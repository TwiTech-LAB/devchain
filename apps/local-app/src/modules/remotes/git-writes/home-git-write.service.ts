import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { AppError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { FileSyncService } from '../../file-sync/file-sync.service';
import {
  STORAGE_SERVICE,
  type ProjectStorage,
  type RemoteStorage,
} from '../../storage/interfaces/storage.interface';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { ProjectGitMutex } from '../../worktrees/project-git-mutex';
import { exportIndexSnapshot, refsDigest } from '../git-coordinator/git-checkpoint';
import type { GitCoordinatorRecord } from '../git-coordinator/git-coordinator.dto';
import { GitProcessIdentity } from '../git-coordinator/git-process-identity';
import { RemoteHostClient, RemoteHostRequestError } from '../operations/remote-host.client';
import { hostErrorCode } from '../transport/host-transport';
import { GitOwnerStore } from '../git-owner.store';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { scanSequences, waitForChangeBarrier } from './change-barrier';
import { HomeGitTransitions, gitReclaimPending } from './home-git-transitions';
import { HomeGitWriteStore, type HomeGitWrite } from './home-git-write.store';

const logger = createLogger('HomeGitWrites');
export const HOME_GIT_WRITE_TIMINGS = Symbol('HOME_GIT_WRITE_TIMINGS');
export const DEFAULT_HOME_GIT_WRITE_TIMINGS = {
  /** How often an in-flight write checks whether its git process is gone. */
  pidPollMs: 100,
  /** A batch starts once no git of the project's tracked writes has run for this long. */
  batchQuietMs: 300,
  /** The longest a batch waits for that quiet before it confirms the writes whose git is gone. */
  batchWaitMs: 3_000,
  barrierPollMs: 100,
  /** One barrier attempt; the next attempt scans again and records new sequences. */
  barrierMs: 30_000,
  retryMinMs: 1_000,
  retryMaxMs: 10_000,
  /** How often home checks whether the VM took back Git this PC owns. */
  stepDownPollMs: 5_000,
};
export type HomeGitWriteTimings = typeof DEFAULT_HOME_GIT_WRITE_TIMINGS;

export interface HomeGitProject {
  projectId: string;
  /** Null when the project is not connected, so Git runs without the coordinator. */
  remoteName: string | null;
}

class Stopped extends Error {}

/** The start identity of a write home learned only from the VM: its git is treated as gone. */
const UNKNOWN_START = 'unknown';

/**
 * The home write path: `acquire` registers a write on the VM before git runs, and write-through
 * confirms it on the VM after the registered git process is gone. Write-through runs in the
 * background and retries without a limit. After a short settle wait, one sync check confirms
 * every finished write of a project. See docs/git-coordinator.md.
 */
@Injectable()
export class HomeGitWriteService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly admission = new ProjectGitMutex();
  private readonly capture = new ProjectGitMutex();
  private readonly jobs = new Map<string, Promise<void>>();
  /** Projects whose VM record home must settle before their writes are tracked: project → remote. */
  private readonly recovering = new Map<string, string>();
  private readonly stop = new AbortController();
  private stepDownTimer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage & RemoteStorage,
    private readonly bindings: RemoteBindingsService,
    private readonly host: RemoteHostClient,
    private readonly files: FileSyncService,
    private readonly processes: GitProcessIdentity,
    private readonly executor: ProcessExecutor,
    private readonly store: HomeGitWriteStore,
    private readonly transitions: HomeGitTransitions,
    private readonly owners: GitOwnerStore,
    @Inject(HOME_GIT_WRITE_TIMINGS) private readonly timings: HomeGitWriteTimings,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const connected = new Map(
      (await this.bindings.list())
        .filter((binding) => binding.state === 'remote')
        .map((binding) => [binding.projectId, binding.remoteId]),
    );
    for (const write of this.store.list()) if (!connected.has(write.projectId)) this.track(write);
    // A handover the last run left past its flip, or a write only the VM knows, settles first.
    for (const [projectId, remoteId] of connected) this.recoverLater(projectId, remoteId);
    this.stepDownTimer = setInterval(() => void this.pollStepDowns(), this.timings.stepDownPollMs);
    this.stepDownTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.stepDownTimer);
    this.stop.abort();
    await Promise.allSettled(this.jobs.values());
  }

  /** The registered project containing `path`, with its VM when Git writes need the VM. */
  async project(path: string): Promise<HomeGitProject | null> {
    for (let candidate = resolve(path); ; candidate = dirname(candidate)) {
      const project = await this.storage.findProjectByPath(candidate);
      if (project) {
        const binding = await this.bindings.get(project.id);
        if (!binding || binding.state === 'failed')
          return { projectId: project.id, remoteName: null };
        return { projectId: project.id, remoteName: await this.remoteName(binding.remoteId) };
      }
      if (dirname(candidate) === candidate) return null;
    }
  }

  /**
   * Registers the gated git child `pid` as a home write, after moving Git to this PC if needed.
   * The write id follows from the pid and its start identity, so a retry reuses it.
   */
  async acquire(projectId: string, pid: number, signal: AbortSignal): Promise<{ writeId: string }> {
    const remoteId = await this.connectedRemote(projectId);
    const identity = await this.processes.read(pid);
    if (typeof identity !== 'string')
      throw new AppError(
        'The git process is gone or cannot be identified',
        'GIT_PROCESS_IDENTITY',
        409,
      );
    const writeId = `hw-${pid}-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
    return this.admission.runExclusive(projectId, async () => {
      const saved = this.store.get(writeId);
      const createdAt = saved?.createdAt ?? Date.now();
      const writeAt = (generation: number): HomeGitWrite => ({
        writeId,
        projectId,
        remoteId,
        pid,
        processStartTime: identity,
        generation,
        createdAt,
      });
      let generation = saved?.generation ?? this.ownedGeneration(projectId);
      for (let attempt = 0; ; attempt += 1) {
        if (generation !== null) {
          const write = writeAt(generation);
          // Saved before the VM hears of it, so a write the VM may know is always ended later.
          this.store.put(write);
          this.track(write);
          try {
            await this.reachVm(remoteId, () =>
              this.host.homeWriteBegin(remoteId, projectId, {
                expectedGeneration: write.generation,
                transitionId: null,
                writeId,
                homeName: hostname(),
              }),
            );
            return { writeId };
          } catch (error) {
            if (attempt >= 2 || !GIT_MOVED.includes(hostErrorCode(error) ?? '')) throw error;
          }
        }
        try {
          generation = await this.moveGitHere(projectId, remoteId, writeId, signal, (record) =>
            this.store.put(writeAt(record.generation)),
          );
          signal.throwIfAborted();
        } catch (error) {
          // The VM may know the write already; it is tracked once its handover has finished.
          if (this.store.get(writeId)) this.recoverLater(projectId, remoteId);
          throw error;
        }
      }
    });
  }

  private track(write: HomeGitWrite): void {
    if (this.jobs.has(write.writeId)) return;
    this.jobs.set(
      write.writeId,
      this.writeThrough(write).finally(() => this.jobs.delete(write.writeId)),
    );
  }

  /** Ends once a batch confirmed the write or the VM no longer knows it. */
  private async writeThrough({ writeId }: HomeGitWrite): Promise<void> {
    let delay = this.timings.retryMinMs;
    try {
      for (;;) {
        this.stop.signal.throwIfAborted();
        // Acquire may re-register the write under a newer generation after a move.
        const write = this.store.get(writeId);
        if (!write) return;
        if (!(await this.gitGone(write))) {
          await this.sleep(this.timings.pidPollMs);
          continue;
        }
        try {
          await this.capture.runExclusive(write.projectId, () => this.confirmBatch(writeId));
          delay = this.timings.retryMinMs;
        } catch (error) {
          if (error instanceof Stopped || this.stop.signal.aborted) throw error;
          logger.warn(
            { error, projectId: write.projectId, writeId: write.writeId },
            'Home Git write is not confirmed on the VM yet; retrying',
          );
          await this.sleep(delay);
          delay = Math.min(delay * 2, this.timings.retryMaxMs);
        }
      }
    } catch (error) {
      if (this.stop.signal.aborted) return;
      throw error;
    }
  }

  /**
   * Unknown liveness keeps the write in flight: git or a hook may still be writing. Git never
   * starts before `acquire` answers, so a write home did not save there has no git to wait for.
   */
  private async gitGone(write: HomeGitWrite): Promise<boolean> {
    if (write.processStartTime === UNKNOWN_START) return true;
    const identity = await this.processes.read(write.pid);
    return identity !== null && identity !== write.processStartTime;
  }

  /**
   * Confirms every finished write of the project with one sync check. Members are fixed before
   * the rescan, so each member's git exited before the snapshot; the VM still checks the refs and
   * objects for each write. Every member carries the full index: the VM installs what it gets.
   */
  private async confirmBatch(writeId: string): Promise<void> {
    // A batch run while this job waited for the capture queue may have confirmed it.
    const write = this.store.get(writeId);
    if (!write) return;
    await this.settle(write.projectId);
    const members: HomeGitWrite[] = [];
    for (const candidate of this.tracked(write.projectId))
      if (candidate.remoteId === write.remoteId && (await this.gitGone(candidate)))
        members.push(candidate);
    if (members.length === 0) return;
    members.sort((a, b) => a.createdAt - b.createdAt);
    const binding = await this.bindings.get(write.projectId);
    if (!binding || binding.remoteId !== write.remoteId) {
      logger.warn(
        { projectId: write.projectId, writeIds: members.map((member) => member.writeId) },
        'Dropping home Git writes for a project that is no longer connected to its VM',
      );
      for (const member of members) this.store.delete(member.writeId);
      return;
    }
    await this.changeBarrier(write.projectId, write.remoteId);
    const root = await this.files.folderPath(write.projectId);
    const [digest, index] = await Promise.all([
      refsDigest(this.executor, root),
      exportIndexSnapshot(this.executor, root),
    ]);
    const indexBase64 = index.toString('base64');
    for (const member of members) {
      if (this.stop.signal.aborted) throw new Stopped();
      try {
        await this.host.homeWriteEnd(member.remoteId, member.projectId, {
          expectedGeneration: member.generation,
          transitionId: null,
          writeId: member.writeId,
          refsDigest: digest,
          indexBase64,
        });
        this.store.delete(member.writeId);
      } catch (error) {
        if (!WRITE_NOT_REGISTERED.includes(hostErrorCode(error) ?? '')) throw error;
        logger.warn(
          { projectId: member.projectId, writeId: member.writeId },
          'The VM does not know this home Git write; dropping it',
        );
        // A write registered again under a newer generation stays for the next batch.
        if (this.store.get(member.writeId)?.generation === member.generation)
          this.store.delete(member.writeId);
      }
    }
  }

  /**
   * Waits until no git of the project's tracked writes has run for `batchQuietMs`, at most
   * `batchWaitMs`: in `git commit && git push`, the push registers shortly after the commit's
   * git exits, and its write then joins the batch.
   */
  private async settle(projectId: string): Promise<void> {
    const started = Date.now();
    let quietSince = started;
    for (;;) {
      if (await this.anyGitRunning(projectId)) quietSince = Date.now();
      const now = Date.now();
      if (
        now - quietSince >= this.timings.batchQuietMs ||
        now - started >= this.timings.batchWaitMs
      )
        return;
      await this.sleep(this.timings.pidPollMs);
    }
  }

  /** True while the git of any tracked write of the project may still run. */
  private async anyGitRunning(projectId: string): Promise<boolean> {
    for (const write of this.tracked(projectId)) if (!(await this.gitGone(write))) return true;
    return false;
  }

  /** Saved writes with a write-through job; recovery tracks a write only once its project settled. */
  private tracked(projectId: string): HomeGitWrite[] {
    return this.store
      .list()
      .filter((write) => write.projectId === projectId && this.jobs.has(write.writeId));
  }

  /**
   * Scans both folders, records each one's local sequence, then waits until every item changed
   * up to that sequence is at the VM or in the VM's failed items. Failed items already show in
   * the file sync warning; for `.git`, the VM's refs and object checks still decide.
   */
  private async changeBarrier(projectId: string, remoteId: string): Promise<void> {
    const folders = await this.files.projectFolders(projectId);
    const self = this.files.device().deviceId;
    const code = folders.find((folder) => folder.kind === 'code');
    const vmDevice = code
      ? (await this.files.folderConfiguration(code.id)).devices.find(
          (device) => device.deviceID !== self,
        )?.deviceID
      : undefined;
    if (!vmDevice) throw new Error('The project has no VM device in its code folder');
    const sequences: Record<string, number> = {};
    const scanned = await scanSequences(
      this.files,
      folders.map((folder) => folder.id),
    );
    for (const [folderId, sequence] of Object.entries(scanned))
      sequences[folderId] = sequence ?? Number.MAX_SAFE_INTEGER;
    await waitForChangeBarrier({
      sequences,
      needed: (folderId, sequence) => this.files.remoteNeedThrough(folderId, vmDevice, sequence),
      failed: async (folderId) =>
        (
          (await this.host.syncStatus(remoteId, folderId, undefined, { allErrors: true }))
            .fileErrors ?? []
        ).map((error) => error.path),
      timeoutMs: this.timings.barrierMs,
      pollMs: this.timings.barrierPollMs,
      sleep: (ms) => this.sleep(ms),
    });
  }

  /**
   * Brings Git to this PC after the VM refused a write: resumes a handover, steps down first
   * when the VM took back Git this PC owned, then hands over. Returns the generation now owned.
   */
  private async moveGitHere(
    projectId: string,
    remoteId: string,
    writeId: string,
    signal: AbortSignal,
    published: (record: GitCoordinatorRecord) => void,
  ): Promise<number> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const record = await this.reachVm(remoteId, () =>
        this.host.gitCoordinatorStatus(remoteId, projectId),
      );
      const context = {
        projectId,
        remoteId,
        remoteName: await this.remoteName(remoteId),
        record,
        writeId,
        signal,
        published,
      };
      if (record.transition?.kind === 'reclaim') throw gitReclaimPending();
      if (record.transition) await this.transitions.handover(context);
      else if (record.owner === 'home') {
        // Only this PC hands Git over, so a home-owned record is ours, even if the cache lags.
        this.owners.remember(projectId, record);
        return record.generation;
      } else if (this.owners.get(projectId) === 'home') await this.transitions.stepDown(context);
      else await this.transitions.handover(context);
      signal.throwIfAborted();
    }
    throw new AppError('Git did not move to this PC', 'GIT_HANDOVER_REQUIRED', 409);
  }

  /** The generation this PC owns Git under, or null while the VM owns it. */
  private ownedGeneration(projectId: string): number | null {
    return this.owners.get(projectId) === 'home' ? this.owners.generation(projectId) : null;
  }

  /** A VM reclaim seen here steps this PC down before any other home Git work. */
  private async pollStepDowns(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const [projectId, remoteId] of this.recovering) await this.recover(projectId, remoteId);
      for (const binding of await this.bindings.list()) {
        if (binding.state !== 'remote' || this.owners.get(binding.projectId) !== 'home') continue;
        await this.stepDownIfReclaimed(binding.projectId, binding.remoteId).catch(
          (error: unknown) =>
            logger.warn({ error, projectId: binding.projectId }, 'Git step-down will retry'),
        );
      }
    } catch (error) {
      logger.warn({ error }, 'Git step-down poll failed');
    } finally {
      this.polling = false;
    }
  }

  async stepDownIfReclaimed(projectId: string, remoteId: string): Promise<void> {
    await this.admission.runExclusive(projectId, async () => {
      if (this.owners.get(projectId) !== 'home') return;
      const record = await this.host.gitCoordinatorStatus(remoteId, projectId);
      if (record.owner === 'home' && !record.transition) {
        this.adopt(projectId, remoteId, record);
        this.trackProject(projectId);
      }
      if (record.owner !== 'vm' || record.generation <= this.owners.generation(projectId)) return;
      await this.transitions.stepDown({
        projectId,
        remoteId,
        remoteName: await this.remoteName(remoteId),
        record,
        signal: this.stop.signal,
      });
    });
  }

  private trackProject(projectId: string): void {
    for (const write of this.store.list()) if (write.projectId === projectId) this.track(write);
  }

  private recoverLater(projectId: string, remoteId: string): void {
    this.recovering.set(projectId, remoteId);
    void this.recover(projectId, remoteId);
  }

  /**
   * Settles the VM record, then tracks the project's writes: write-through can only confirm
   * once no handover is pending. Past its flip, only this PC can finish a handover; it then
   * publishes a write without a git process. Retried by the step-down poll until it succeeds.
   */
  private async recover(projectId: string, remoteId: string): Promise<void> {
    try {
      await this.admission.runExclusive(projectId, async () => {
        if (this.recovering.get(projectId) !== remoteId) return;
        let record = await this.host.gitCoordinatorStatus(remoteId, projectId);
        const transition = record.transition;
        if (transition?.kind === 'handover') {
          // Before the flip the VM lease ends it; the next poll looks again.
          if (transition.phase === 'draining')
            throw new Error('A Git handover is still draining on the VM');
          await this.transitions.handover({
            projectId,
            remoteId,
            remoteName: await this.remoteName(remoteId),
            record,
            writeId: `hw-${process.pid}-recovered-${transition.id}`,
            signal: this.stop.signal,
            published: (published) => this.adopt(projectId, remoteId, published),
          });
          record = await this.host.gitCoordinatorStatus(remoteId, projectId);
        }
        if (record.owner === 'home' && !record.transition) {
          this.owners.remember(projectId, record);
          this.adopt(projectId, remoteId, record);
        }
        this.trackProject(projectId);
        this.recovering.delete(projectId);
      });
    } catch (error) {
      logger.warn({ error, projectId }, 'Home Git write recovery will retry');
    }
  }

  /**
   * Saves each write the VM lists that home does not have, under the record's generation; a
   * write `acquire` saved keeps its real process identity. Callers hold the admission queue.
   */
  private adopt(projectId: string, remoteId: string, record: GitCoordinatorRecord): void {
    for (const [writeId, createdAt] of Object.entries(record.homeWrites)) {
      const pid = Number(/^hw-(\d+)-/.exec(writeId)?.[1]);
      if (this.store.get(writeId) || !Number.isSafeInteger(pid) || pid <= 0) continue;
      logger.warn({ projectId, writeId }, 'Adopting a home Git write that only the VM knows');
      this.store.put({
        writeId,
        projectId,
        remoteId,
        pid,
        processStartTime: UNKNOWN_START,
        generation: record.generation,
        createdAt,
      });
    }
  }

  private async connectedRemote(projectId: string): Promise<string> {
    const binding = await this.bindings.get(projectId);
    if (!binding || binding.state === 'failed')
      throw new AppError('This project is not connected to a VM', 'GIT_PROJECT_NOT_CONNECTED', 409);
    if (binding.state !== 'remote')
      throw new AppError(
        `This project is ${binding.state === 'attaching' ? 'connecting to' : 'disconnecting from'} its VM; run Git again when that finishes.`,
        'GIT_PROJECT_MOVING',
        409,
      );
    return binding.remoteId;
  }

  /** A VM that does not answer is one 503, so the supervisor can wait and ask again. */
  private async reachVm<T>(remoteId: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (error instanceof RemoteHostRequestError && error.status === null)
        throw new AppError(
          `The VM '${await this.remoteName(remoteId)}' does not respond`,
          'GIT_VM_UNREACHABLE',
          503,
        );
      throw error;
    }
  }

  private async remoteName(remoteId: string): Promise<string> {
    return (await this.storage.getRemote(remoteId)).name;
  }

  private async sleep(ms: number): Promise<void> {
    const signal = this.stop.signal;
    if (signal.aborted) throw new Stopped();
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        done();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        fail(new Stopped());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** VM refusals of `homeWriteBegin` that a move of Git to this PC resolves. */
const GIT_MOVED = ['GIT_GENERATION_MISMATCH', 'GIT_HANDOVER_REQUIRED'];
/**
 * VM refusals of `homeWriteEnd` for a write the VM never registered: it keeps the generation
 * while a home write is pending, so a changed generation means the same.
 */
const WRITE_NOT_REGISTERED = ['GIT_HOME_WRITE_UNKNOWN', 'GIT_GENERATION_MISMATCH'];
