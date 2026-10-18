import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { AppError } from '../../../common/errors/error-types';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { ProjectGitMutex } from '../../worktrees/project-git-mutex';
import { GitCoordinatorStore } from './git-coordinator.store';
import { GitCoordinatorIndexService, describeSequencer } from './git-coordinator-index.service';
import { GitProcessIdentity } from './git-process-identity';
import { GitFenceSchema, HANDOVER_PHASES } from './git-coordinator.dto';
import { exportIndexSnapshot, internalGitEnv, missingObjects, refsDigest } from './git-checkpoint';
import { projectFolderId } from '../../file-sync/file-sync.service';
import { gitIgnores } from '../../file-sync/file-sync.dto';
import { scanSequences } from '../git-writes/change-barrier';
import type {
  GitCoordinatorRecord,
  GitCoordinatorStatus,
  GitFence,
  HomeWriteBeginSchema,
  HomeWriteEndSchema,
  HandoverBeginSchema,
  HandoverPhaseSchema,
  GitTransition,
  VmHoldRequest,
} from './git-coordinator.dto';

const logger = createLogger('GitCoordinator');
const CONFIRMED_WRITES_KEPT = 32;
export const GIT_COORDINATOR_TIMINGS = Symbol('GIT_COORDINATOR_TIMINGS');
export const DEFAULT_GIT_COORDINATOR_TIMINGS = {
  pollMs: 1000,
  acquireMs: 90_000,
  leaseMs: 15_000,
  gcMs: 60_000,
};
export type GitCoordinatorTimings = typeof DEFAULT_GIT_COORDINATOR_TIMINGS;

@Injectable()
export class GitCoordinatorService implements OnApplicationBootstrap, OnModuleDestroy {
  /** The admission queue; separate from the project's ProjectGitMutex, which comes after it. */
  private readonly queue = new ProjectGitMutex();
  private readonly lastGc = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private readonly polling = new Set<string>();
  private readonly collecting = new Set<string>();
  private stopped = false;

  constructor(
    private readonly store: GitCoordinatorStore,
    private readonly files: FileSyncService,
    private readonly guard: HomeGitGuardService,
    private readonly indexes: GitCoordinatorIndexService,
    private readonly processes: GitProcessIdentity,
    private readonly executor: ProcessExecutor,
    @Inject(GIT_COORDINATOR_TIMINGS) private readonly timings: GitCoordinatorTimings,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      void this.poll().catch((error: unknown) =>
        logger.warn({ error }, 'Git coordinator polling failed'),
      );
    }, this.timings.pollMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.queue.idle();
  }

  async status(projectId: string): Promise<GitCoordinatorStatus> {
    return this.exclusive(projectId, async () => {
      await this.files.folderPath(projectId);
      const record = this.store.read(projectId);
      await this.reconcile(projectId, record);
      return { ...record, worktreeBranches: await this.indexes.worktreeBranches(projectId) };
    });
  }

  async acquireVmHold(projectId: string, request: VmHoldRequest): Promise<GitCoordinatorRecord> {
    const adopted = await this.exclusive(projectId, async () => {
      await this.files.folderPath(projectId);
      const record = this.store.read(projectId);
      const existing = record.vmHolds[request.holdId];
      if (!existing || record.owner !== 'vm') return null;
      if (
        existing.pid !== request.pid ||
        existing.processStartTime !== request.processStartTime ||
        (await this.processes.read(request.pid)) !== request.processStartTime
      )
        throw new ConflictException('Git hold identity cannot be verified');
      return record;
    });
    if (adopted) return adopted;
    return this.waitForVm(projectId, async (record) => {
      const identity = await this.processes.read(request.pid);
      if (identity !== request.processStartTime)
        throw new AppError(
          'Git process is dead or its start identity cannot be verified',
          'GIT_PROCESS_IDENTITY',
          409,
        );
      const existing = record.vmHolds[request.holdId];
      if (existing && (existing.pid !== request.pid || existing.processStartTime !== identity))
        throw new ConflictException('Git hold id already belongs to another process');
      record.vmHolds[request.holdId] = {
        pid: request.pid,
        processStartTime: identity,
        startedAt: existing?.startedAt ?? Date.now(),
      };
      this.store.write(projectId, record);
      return record;
    });
  }

  async releaseVmHold(projectId: string, request: VmHoldRequest): Promise<void> {
    await this.exclusive(projectId, async () => {
      const record = this.store.read(projectId);
      const hold = record.vmHolds[request.holdId];
      if (!hold) return;
      if (hold.pid !== request.pid || hold.processStartTime !== request.processStartTime)
        throw new ConflictException('Git hold identity mismatch');
      const identity = await this.processes.read(hold.pid);
      if (identity === null || identity === hold.processStartTime)
        throw new ConflictException('Git process has not exited');
      delete record.vmHolds[request.holdId];
      this.store.write(projectId, record);
    });
  }

  /** Acquire this permit before ProjectGitMutex; never acquire it recursively. */
  async withVmPermit<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    return this.waitForVm(projectId, operation);
  }

  async withHostMutation<T>(
    projectId: string,
    fence: GitFence,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.exclusive(projectId, async () => {
      await this.files.folderPath(projectId);
      const record = this.store.read(projectId);
      await this.reconcileFenced(projectId, record, fence);
      if (Object.keys(record.vmHolds).length)
        throw new AppError('Git processes still hold the VM', 'GIT_VM_HELD', 409);
      if (record.transition?.kind === 'reclaim')
        throw new ConflictException('Git reclaim is in progress');
      return operation();
    });
  }

  async homeWriteBegin(
    projectId: string,
    request: z.infer<typeof HomeWriteBeginSchema>,
  ): Promise<GitCoordinatorRecord> {
    return this.exclusive(projectId, async () => {
      await this.files.folderPath(projectId);
      const record = this.store.read(projectId);
      this.assertFence(record, request);
      if (record.closed) throw disconnecting();
      if (record.owner !== 'home' || record.transition)
        throw new AppError(
          'Git must finish moving to the PC before writing',
          'GIT_HANDOVER_REQUIRED',
          409,
        );
      record.homeName = request.homeName;
      record.homeWrites[request.writeId] ??= Date.now();
      this.store.write(projectId, record);
      return record;
    });
  }

  async homeWriteEnd(
    projectId: string,
    request: z.infer<typeof HomeWriteEndSchema>,
  ): Promise<GitCoordinatorRecord> {
    return this.exclusive(projectId, async () => {
      const record = this.store.read(projectId);
      const pending = record.homeWrites[request.writeId] !== undefined;
      // A retry after a lost answer gets the recorded result, even after a later reclaim, and
      // never replaces a newer checkpoint.
      if (
        !pending &&
        (record.confirmedWrites?.[request.writeId] ||
          record.checkpoint?.writeId === request.writeId)
      )
        return record;
      this.assertFence(record, request);
      if (!pending) throw new AppError('Unknown home Git write', 'GIT_HOME_WRITE_UNKNOWN', 409);
      if (record.owner !== 'home' || record.transition)
        throw new ConflictException('Git is not owned by the PC');
      const root = await this.files.folderPath(projectId);
      if ((await refsDigest(this.executor, root)) !== request.refsDigest)
        throw checkpointIncomplete('VM Git does not have the refs of this home write yet');
      await this.indexes.save(
        projectId,
        Buffer.from(request.indexBase64, 'base64'),
        async (indexFile) => {
          const missing = await missingObjects(this.executor, root, indexFile);
          if (missing.length)
            throw checkpointIncomplete(
              `VM Git does not have ${missing.length} objects of this home write yet`,
            );
        },
      );
      await this.indexes.replace(projectId, request.writeId);
      const result = {
        generation: record.generation,
        refsDigest: request.refsDigest,
        at: Date.now(),
      };
      record.checkpoint = { writeId: request.writeId, ...result };
      record.confirmedWrites = Object.fromEntries(
        [...Object.entries(record.confirmedWrites ?? {}), [request.writeId, result] as const].slice(
          -CONFIRMED_WRITES_KEPT,
        ),
      );
      delete record.homeWrites[request.writeId];
      this.store.write(projectId, record);
      return record;
    });
  }

  async beginHandover(
    projectId: string,
    request: z.infer<typeof HandoverBeginSchema>,
  ): Promise<GitCoordinatorRecord> {
    return this.exclusive(projectId, async () => {
      await this.files.folderPath(projectId);
      const record = this.store.read(projectId);
      const retryFence =
        record.transition?.kind === 'handover' &&
        record.transition.id === request.id &&
        request.transitionId === null
          ? { expectedGeneration: request.expectedGeneration, transitionId: request.id }
          : request;
      await this.reconcileFenced(projectId, record, retryFence);
      if (record.transition?.kind === 'handover' && record.transition.id === request.id)
        return record;
      if (record.closed) throw disconnecting();
      if (record.owner !== 'vm' || record.transition)
        throw new ConflictException('Git cannot start a handover');
      await this.assertNoSequencer(projectId);
      record.homeName = request.homeName;
      record.transition = {
        kind: 'handover',
        id: request.id,
        phase: 'draining',
        lease: Date.now() + this.timings.leaseMs,
      };
      this.store.write(projectId, record);
      return record;
    });
  }

  async renewHandover(projectId: string, fence: GitFence): Promise<GitCoordinatorRecord> {
    return this.exclusive(projectId, async () => {
      const record = this.store.read(projectId);
      await this.reconcileFenced(projectId, record, fence);
      if (record.transition?.kind !== 'handover')
        throw new ConflictException('No handover to renew');
      record.transition.lease = Date.now() + this.timings.leaseMs;
      this.store.write(projectId, record);
      return record;
    });
  }

  async abortHandover(projectId: string, fence: GitFence): Promise<GitCoordinatorRecord> {
    return this.exclusive(projectId, async () => {
      const record = this.store.read(projectId);
      this.assertFence(record, fence);
      if (record.transition?.kind !== 'handover' || record.transition.phase !== 'draining')
        throw new ConflictException('Git handover must finish forward after the flip');
      await this.abortPreFlip(projectId, record);
      return record;
    });
  }

  /** Disconnect: admits no new holds, home writes or transitions; in-flight ones finish. */
  async close(projectId: string): Promise<GitCoordinatorRecord> {
    return this.setClosed(projectId, true);
  }

  /** A cancelled Disconnect admits Git again. */
  async reopen(projectId: string): Promise<GitCoordinatorRecord> {
    return this.setClosed(projectId, false);
  }

  /** Connect starts a fresh record (VM owner, generation 0); a released project has none. */
  async forget(projectId: string): Promise<void> {
    await this.exclusive(projectId, async () => this.store.delete(projectId));
  }

  /** The handover implementation journals its phases inside this same admission queue. */
  async handoverStep<T>(
    projectId: string,
    fence: GitFence,
    operation: (record: GitCoordinatorRecord, journal: () => void) => Promise<T>,
  ): Promise<T> {
    return this.withHostMutation(projectId, fence, async () => {
      const record = this.store.read(projectId);
      if (record.transition?.kind !== 'handover') throw new ConflictException('No active handover');
      await this.assertNoSequencer(projectId);
      const result = await operation(record, () => this.store.write(projectId, record));
      this.store.write(projectId, record);
      return result;
    });
  }

  /**
   * Runs one handover phase, in order: `draining` (holds gone: VM guard, scan, record each
   * folder's sequence), `vm-receiving` (VM Git folder receive-only), `home-sending` (home makes
   * its folder send-only after this answer) and `published` (owner home, next generation, the
   * home write registered). Each phase is journaled before its effect; repeating the current
   * phase repeats its effect.
   */
  async handoverPhase(
    projectId: string,
    request: z.infer<typeof HandoverPhaseSchema>,
  ): Promise<GitCoordinatorRecord> {
    const { phase, writeId, ...fence } = request;
    return this.handoverStep(projectId, fence, async (record, journal) => {
      const transition = record.transition as Extract<GitTransition, { kind: 'handover' }>;
      const from = HANDOVER_PHASES.indexOf(transition.phase);
      const to = HANDOVER_PHASES.indexOf(phase);
      if (to !== from && to !== from + 1)
        throw new ConflictException(`Git handover cannot go from ${transition.phase} to ${phase}`);
      const started = Date.now();
      if (phase === 'draining') {
        const warning = await this.guard.install(projectId, {
          homeName: record.homeName ?? 'the connected PC',
          reason: 'pc-git',
        });
        if (warning) logger.warn({ projectId }, warning);
        const sequences: Record<string, number> = {};
        const folders = await this.files.projectFolders(projectId);
        const scanned = await scanSequences(
          this.files,
          folders.map((folder) => folder.id),
        );
        for (const [folderId, sequence] of Object.entries(scanned)) {
          if (sequence === undefined)
            throw new Error(`Syncthing reported no sequence for ${folderId}`);
          sequences[folderId] = sequence;
        }
        transition.sequences = sequences;
      } else if (phase === 'vm-receiving') {
        transition.phase = phase;
        journal();
        await this.files.updateFolder(projectFolderId(projectId, 'git'), {
          type: 'receiveonly',
          ignores: gitIgnores(true),
          paused: false,
        });
      } else if (phase === 'home-sending') {
        transition.phase = phase;
      } else if (transition.phase !== 'published') {
        record.owner = 'home';
        record.generation++;
        transition.phase = 'published';
      }
      if (phase === 'published') record.homeWrites[writeId!] ??= Date.now();
      logger.debug({ projectId, phase, ms: Date.now() - started }, 'Git handover phase');
      return record;
    });
  }

  /** Home removed its guard and installed the VM index: Git may run on the PC from now on. */
  async handoverComplete(projectId: string, fence: GitFence): Promise<GitCoordinatorRecord> {
    return this.handoverStep(projectId, fence, async (record) => {
      if (record.transition?.kind !== 'handover' || record.transition.phase !== 'published')
        throw new ConflictException('Git handover is not published yet');
      record.transition = null;
      return record;
    });
  }

  /** The VM root index for the PC to install when Git moves there. */
  async indexSnapshot(projectId: string): Promise<{ indexBase64: string }> {
    return this.exclusive(projectId, async () => ({
      indexBase64: (
        await exportIndexSnapshot(this.executor, await this.files.folderPath(projectId))
      ).toString('base64'),
    }));
  }

  async idleGc(projectId: string): Promise<boolean> {
    return this.exclusive(projectId, async () => {
      const record = this.store.read(projectId);
      const known = await this.reconcile(projectId, record);
      if (
        !known ||
        record.owner !== 'vm' ||
        record.transition ||
        Object.keys(record.vmHolds).length
      )
        return false;
      const result = await this.executor.run({
        argv: ['git', '-c', 'gc.autoDetach=false', 'gc', '--auto'],
        cwd: await this.files.folderPath(projectId),
        mode: 'pipe',
        env: internalGitEnv(),
        timeout: 60_000,
      });
      if (!result.success) throw new Error(`VM Git gc failed: ${result.stderr}`);
      return true;
    });
  }

  async poll(): Promise<void> {
    if (this.stopped) return;
    await Promise.all(
      this.store.projects().map(async (projectId) => {
        if (this.polling.has(projectId)) return;
        this.polling.add(projectId);
        try {
          await this.exclusive(projectId, async () => {
            const record = this.store.read(projectId);
            const known = await this.reconcile(projectId, record);
            if (
              known &&
              record.transition?.kind === 'reclaim' &&
              !Object.keys(record.vmHolds).length &&
              !(await this.indexes.sequencer(projectId))
            )
              await this.reclaim(projectId, record);
          });
          if (
            !this.collecting.has(projectId) &&
            Date.now() - (this.lastGc.get(projectId) ?? 0) >= this.timings.gcMs
          ) {
            this.lastGc.set(projectId, Date.now());
            this.collecting.add(projectId);
            void this.idleGc(projectId)
              .catch((error: unknown) => {
                logger.warn({ projectId, error }, 'VM idle Git gc failed');
              })
              .finally(() => this.collecting.delete(projectId));
          }
        } catch (error) {
          logger.warn(
            { projectId, error },
            'Git coordinator reconciliation failed; admission remains closed',
          );
        } finally {
          this.polling.delete(projectId);
        }
      }),
    );
  }

  private async waitForVm<T>(
    projectId: string,
    operation: (record: GitCoordinatorRecord) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + this.timings.acquireMs;
    let reason = 'Git ownership is changing';
    let homeName = 'the connected PC';
    while (!this.stopped) {
      const result = await this.exclusive(projectId, async () => {
        await this.files.folderPath(projectId);
        const record = this.store.read(projectId);
        homeName = oneLine(record.homeName ?? homeName);
        // A reclaim during Disconnect would move Git after home read the owner.
        if (record.closed) throw disconnecting();
        const known = await this.reconcile(projectId, record);
        if (!known) {
          reason = 'a persisted Git process cannot be verified';
          return { admitted: false } as const;
        }
        if (record.transition?.kind === 'handover') {
          reason = 'a home handover is pending';
          return { admitted: false } as const;
        }
        if (record.owner === 'home' || record.transition?.kind === 'reclaim') {
          const blocker = await this.reclaimBlocker(projectId, record);
          if (blocker) reason = blocker;
          else {
            // The journaled reclaim resumes on the next poll; the caller keeps its deadline.
            // A failed step may leave `record` half-updated, so it never admits this round.
            try {
              await this.reclaim(projectId, record);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              reason = `the VM could not take Git back yet (${oneLine(message)})`;
              logger.warn({ error, projectId }, 'Git reclaim step failed; retrying');
              return { admitted: false } as const;
            }
          }
        }
        if (record.owner !== 'vm' || record.transition) return { admitted: false } as const;
        return { admitted: true, value: await operation(record) } as const;
      });
      if (result.admitted) return result.value;
      if (Date.now() >= deadline)
        throw new AppError(`Git is on PC '${homeName}': ${reason}.`, 'GIT_VM_ACQUIRE_TIMEOUT', 409);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(this.timings.pollMs, Math.max(0, deadline - Date.now()))),
      );
    }
    throw new ServiceUnavailableException('Git coordinator is stopping');
  }

  /** Why the VM cannot take Git back from the PC yet; null once it may. */
  private async reclaimBlocker(
    projectId: string,
    record: GitCoordinatorRecord,
  ): Promise<string | null> {
    if (Object.keys(record.vmHolds).length) return 'VM Git processes are still active';
    if (Object.keys(record.homeWrites).length) return 'a home Git write is unconfirmed';
    if (record.checkpoint?.generation !== record.generation)
      return 'the home checkpoint is missing or stale';
    const sequencer = await this.indexes.sequencer(projectId);
    return sequencer ? `Git there is in the middle of ${describeSequencer(sequencer)}` : null;
  }

  private async assertNoSequencer(projectId: string): Promise<void> {
    const sequencer = await this.indexes.sequencer(projectId);
    if (sequencer)
      throw new ConflictException(`VM Git is in the middle of ${describeSequencer(sequencer)}`);
  }

  private async setClosed(projectId: string, closed: boolean): Promise<GitCoordinatorRecord> {
    return this.exclusive(projectId, async () => {
      const record = this.store.read(projectId);
      if (closed) record.closed = true;
      else delete record.closed;
      this.store.write(projectId, record);
      return record;
    });
  }

  private assertFence(record: GitCoordinatorRecord, input: GitFence): void {
    const fence = GitFenceSchema.parse(input);
    if (
      fence.expectedGeneration !== record.generation ||
      fence.transitionId !== (record.transition?.id ?? null)
    )
      throw new AppError(
        'Git ownership generation or transition changed',
        'GIT_GENERATION_MISMATCH',
        409,
        { generation: record.generation, transitionId: record.transition?.id ?? null },
      );
  }

  /** The fence is checked again after reconcile, which may abort an expired handover. */
  private async reconcileFenced(
    projectId: string,
    record: GitCoordinatorRecord,
    fence: GitFence,
  ): Promise<void> {
    this.assertFence(record, fence);
    await this.reconcile(projectId, record);
    this.assertFence(record, fence);
  }

  private async reconcile(projectId: string, record: GitCoordinatorRecord): Promise<boolean> {
    let known = true;
    let changed = false;
    for (const [id, hold] of Object.entries(record.vmHolds)) {
      const identity = await this.processes.read(hold.pid);
      if (identity === null) known = false;
      else if (identity !== hold.processStartTime) {
        delete record.vmHolds[id];
        changed = true;
      }
    }
    if (changed) this.store.write(projectId, record);
    if (
      known &&
      record.transition?.kind === 'handover' &&
      record.transition.phase === 'draining' &&
      record.transition.lease <= Date.now()
    )
      await this.abortPreFlip(projectId, record);
    return known;
  }

  private async abortPreFlip(projectId: string, record: GitCoordinatorRecord): Promise<void> {
    // Clear the journal only after guard removal is confirmed, so failure stays closed.
    const result = await this.guard.remove(projectId, {
      refreshIndex: false,
      failOnReadError: true,
    });
    if (result.warning) throw new Error(result.warning);
    record.transition = null;
    this.store.write(projectId, record);
  }

  private async reclaim(projectId: string, record: GitCoordinatorRecord): Promise<void> {
    if (!record.transition) {
      record.transition = { kind: 'reclaim', id: randomUUID(), phase: 'sending', lease: null };
      this.store.write(projectId, record);
    }
    const transition = record.transition;
    if (transition.kind !== 'reclaim') throw new ConflictException('Git handover blocks reclaim');
    if (transition.phase === 'sending') {
      await this.files.updateFolder(projectFolderId(projectId, 'git'), { type: 'sendonly' });
      transition.phase = 'unguarding';
      this.store.write(projectId, record);
    }
    if (transition.phase === 'unguarding') {
      const result = await this.guard.remove(projectId, {
        refreshIndex: false,
        failOnReadError: true,
      });
      if (result.warning) throw new Error(result.warning);
      transition.phase = 'index';
      this.store.write(projectId, record);
    }
    if (transition.phase === 'index') {
      await this.indexes.install(projectId, transition.id);
      transition.phase = 'publishing';
      this.store.write(projectId, record);
    }
    record.owner = 'vm';
    record.generation++;
    record.transition = null;
    this.store.write(projectId, record);
    await this.indexes.cleanup(projectId, transition.id);
  }

  private exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    return this.queue.runExclusive(projectId, operation);
  }
}

function checkpointIncomplete(message: string): AppError {
  return new AppError(message, 'GIT_CHECKPOINT_INCOMPLETE', 409);
}

function disconnecting(): AppError {
  return new AppError(
    'This project is disconnecting from its VM; Git runs again after the Disconnect.',
    'GIT_PROJECT_DISCONNECTING',
    409,
  );
}

/** Control characters become spaces, so a refusal message stays one line. */
function oneLine(text: string): string {
  return text.replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
}
