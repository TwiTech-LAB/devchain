import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { findDevchainCli } from '../../../common/devchain-cli-launcher';
import { createLogger } from '../../../common/logging/logger';
import { FILE_SYNC_PATHS, type FileSyncPaths } from '../../file-sync/file-sync-paths';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteProjectBinding } from '../../storage/models/domain.models';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { internalGitEnv, refsDigest } from '../git-coordinator/git-checkpoint';
import type { GitCoordinatorRecord } from '../git-coordinator/git-coordinator.dto';
import { GIT_SHIM_HOME } from '../git-shim/git-shim-registry.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import {
  hasRecoveryRefs,
  listRecoveredRefs,
  prepareRecoveryRefs,
  RECOVERY_MARKER,
  gitBackupRoot,
} from './home-git-recovery-refs';
import { HomeGitWriteStore } from './home-git-write.store';

const logger = createLogger('HomeGitRecovery');
const PlanSchema = z
  .array(
    z.object({
      source: z.string(),
      destination: z.string().regex(/^refs\/(heads|tags)\/devchain-recovered\//),
      oid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    }),
  )
  .nonempty();
const MarkerSchema = z.object({
  projectId: z.string(),
  remoteId: z.string(),
  pcName: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  state: z.enum(['pending', 'fetched', 'recovered', 'nothing']),
  refs: z.array(z.string()).optional(),
  stagedSkipped: z.literal('conflicts').optional(),
  writeId: z.string().optional(),
  plan: PlanSchema.optional(),
});
type Marker = z.infer<typeof MarkerSchema>;
type Backup = { directory: string; time: string; marker: Marker };
type BindingWarning = { remoteId: string; warning?: string; refreshing?: boolean };
export type HomeGitRecovery = Omit<Marker, 'projectId' | 'writeId' | 'refs' | 'plan'> & {
  time: string;
  refs: string[];
};

@Injectable()
export class HomeGitRecoveryService implements OnModuleDestroy {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly retries = new Map<string, { after: number; delay: number }>();
  private readonly warnings = new Map<string, BindingWarning>();
  private readonly stop = new AbortController();

  constructor(
    @Inject(FILE_SYNC_PATHS) private readonly paths: FileSyncPaths,
    @Inject(GIT_SHIM_HOME) private readonly shimHome: string,
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly bindings: RemoteBindingsService,
    private readonly host: RemoteHostClient,
    private readonly files: FileSyncService,
    private readonly executor: ProcessExecutor,
    private readonly writes: HomeGitWriteStore,
  ) {}

  /** Call after ownership reconciliation releases both queues. The supervisor takes them itself. */
  schedule(projectId: string, remoteId: string): void {
    if (this.stop.signal.aborted || this.jobs.has(projectId)) return;
    const job = this.recover(projectId, remoteId)
      .catch((error: unknown) => {
        if (this.stop.signal.aborted) return;
        logger.warn({ error, projectId }, 'Git backup recovery will retry');
      })
      .finally(() => this.jobs.delete(projectId));
    this.jobs.set(projectId, job);
  }

  async onModuleDestroy(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled(this.jobs.values());
  }

  async list(projectId: string): Promise<HomeGitRecovery[]> {
    return (await this.backups(projectId)).map(({ time, marker }) => ({
      time,
      remoteId: marker.remoteId,
      pcName: marker.pcName,
      createdAt: marker.createdAt,
      state: marker.state,
      refs: marker.refs ?? [],
      stagedSkipped: marker.stagedSkipped,
    }));
  }

  /** Bindings establish UI routing, so they can only use results from completed refreshes. */
  bindingWarnings(
    bindings: readonly Pick<RemoteProjectBinding, 'projectId' | 'remoteId' | 'state'>[],
  ): Map<string, string> {
    const active = new Set<string>();
    const warnings = new Map<string, string>();
    for (const { projectId, remoteId, state } of bindings) {
      if (state !== 'remote') continue;
      active.add(projectId);
      let entry = this.warnings.get(projectId);
      if (entry?.remoteId !== remoteId) {
        entry = { remoteId };
        this.warnings.set(projectId, entry);
      }
      if (entry.warning) warnings.set(projectId, entry.warning);
      if (entry.refreshing || this.stop.signal.aborted) continue;
      const refreshing = entry;
      refreshing.refreshing = true;
      void this.warning(projectId, remoteId).then((warning) => {
        refreshing.warning = warning;
        refreshing.refreshing = false;
      });
    }
    for (const projectId of this.warnings.keys()) {
      if (!active.has(projectId)) this.warnings.delete(projectId);
    }
    return warnings;
  }

  async warning(
    projectId: string,
    remoteId: string,
    vm?: { name: string; forcedReclaim: NonNullable<GitCoordinatorRecord['forcedReclaim']> },
  ): Promise<string | undefined> {
    try {
      const recoveries = (await this.list(projectId)).filter(
        (entry) => entry.remoteId === remoteId,
      );
      const pending = recoveries.filter(({ state }) => state === 'pending' || state === 'fetched');
      const refs = pending.length
        ? []
        : await listRecoveredRefs(this.executor, await this.files.folderPath(projectId));
      if (!pending.length && !refs.length) return;

      if (!vm) {
        const { forcedReclaim } = await this.host.gitCoordinatorStatus(remoteId, projectId);
        if (!forcedReclaim) return;
        vm = { name: (await this.storage.getRemote(remoteId)).name, forcedReclaim };
      }
      const takeover = `The VM '${vm.name}' took Git back at ${new Date(vm.forcedReclaim.at).toISOString()}`;
      const message = pending.length
        ? `${takeover} because this PC was away. Recovery of this PC's Git work is pending.`
        : `${takeover}. This PC's work is in: ${refs.join(', ')}. Merge or delete these branches.`;
      const relevant = pending.length
        ? pending
        : recoveries.filter((entry) => entry.refs.some((ref) => refs.includes(ref)));
      const staged = relevant
        .filter(({ stagedSkipped }) => stagedSkipped)
        .map(({ time }) => {
          const index = join(gitBackupRoot(this.paths, projectId), time, 'index');
          return `Staged changes had conflicts and are in ${index}.`;
        });
      return [message, ...staged].join(' ');
    } catch (error) {
      logger.debug({ error, projectId, remoteId }, 'Git recovery warning could not be read');
      return undefined;
    }
  }

  private async recover(projectId: string, remoteId: string): Promise<void> {
    for (const backup of await this.backups(projectId)) {
      const { directory, marker } = backup;
      if (
        marker.remoteId !== remoteId ||
        marker.state === 'nothing' ||
        marker.state === 'recovered'
      )
        continue;
      const retry = this.retries.get(directory);
      if (retry && retry.after > Date.now()) continue;
      this.stop.signal.throwIfAborted();
      if (!(await this.connected(projectId, remoteId))) return;
      try {
        if (await this.needsFetch(backup)) await this.fetch(backup);
        this.retries.delete(directory);
      } catch (error) {
        this.stop.signal.throwIfAborted();
        const delay = Math.min((retry?.delay ?? 2_500) * 2, 55_000);
        this.retries.set(directory, { delay, after: Date.now() + delay });
        logger.warn({ error, projectId, time: backup.time }, 'Git backup recovery will retry');
      }
    }
  }

  private async needsFetch({ directory, marker }: Backup): Promise<boolean> {
    const { writeId, projectId, remoteId, plan, state } = marker;
    if (!writeId) {
      if (state === 'fetched') throw new Error('Fetched Git backup has no saved write id');
      return true;
    }
    if (this.writes.get(writeId)) return false;
    const record = await this.host.gitCoordinatorStatus(remoteId, projectId);
    if (record.transition || Object.hasOwn(record.homeWrites, writeId)) return false;
    if (!(await this.connected(projectId, remoteId))) return false;
    const superseded = Object.hasOwn(record.supersededWrites ?? {}, writeId);
    const confirmed =
      Object.hasOwn(record.confirmedWrites ?? {}, writeId) ||
      record.checkpoint?.writeId === writeId;
    if (!superseded && state === 'fetched' && confirmed) {
      await this.save(directory, { ...marker, state: 'recovered' });
      return false;
    }
    if (plan) {
      const root = await this.files.folderPath(projectId);
      if (await hasRecoveryRefs(this.executor, root, plan, this.stop.signal)) {
        // After step-down, the checkout reflects the VM refs, including any confirmed replay.
        if (
          record.owner === 'vm' ||
          (!superseded &&
            (confirmed ||
              (record.checkpoint &&
                record.checkpoint.refsDigest === (await refsDigest(this.executor, root)))))
        ) {
          await this.save(directory, { ...marker, state: 'recovered' });
          return false;
        }
      }
    }
    return true;
  }

  private async fetch({ directory, time, marker }: Backup): Promise<void> {
    const { projectId, remoteId, pcName, createdAt } = marker;
    const root = await this.files.folderPath(projectId);
    const options = { root, backup: directory, pcName, time, createdAt };
    const signal = this.stop.signal;
    let plan = marker.plan;
    let stagedSkipped = marker.stagedSkipped;
    if (!plan) {
      const prepared = await prepareRecoveryRefs(this.executor, options, signal);
      stagedSkipped = prepared.stagedSkipped;
      if (prepared.refs.length === 0) {
        await this.save(directory, { ...marker, stagedSkipped, state: 'nothing', refs: [] });
        return;
      }
      plan = PlanSchema.parse(prepared.refs);
    }
    const pending: Marker = {
      ...marker,
      plan,
      stagedSkipped,
      state: 'pending',
      refs: plan.map(({ destination }) => destination),
      writeId: undefined,
    };
    await this.save(directory, pending);
    const { name } = await this.storage.getRemote(remoteId);
    if (!(await this.connected(projectId, remoteId))) return;
    const writeId = await this.supervise(
      root,
      name,
      marker,
      [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        '--atomic',
        '--update-shallow',
        directory,
        ...plan.map(({ oid, destination }) => `${oid}:${destination}`),
      ],
      (writeId) => this.save(directory, { ...pending, writeId }),
    );
    if (!(await hasRecoveryRefs(this.executor, root, plan, signal)))
      throw new Error(
        'Git recovery fetch did not create all planned refs at their expected objects',
      );
    await this.save(directory, { ...pending, state: 'fetched', writeId });
  }

  private async connected(projectId: string, remoteId: string): Promise<boolean> {
    const binding = await this.bindings.get(projectId);
    return binding?.state === 'remote' && binding.remoteId === remoteId;
  }

  private async supervise(
    root: string,
    remoteName: string,
    { projectId, remoteId }: Marker,
    args: string[],
    prepare: (writeId: string) => Promise<void>,
  ): Promise<string> {
    const cli = findDevchainCli();
    if (!cli) throw new Error('The Git supervisor script could not be located');
    const signal = this.stop.signal;
    signal.throwIfAborted();
    const supervisor = join(dirname(cli), 'lib', 'git-supervisor.js');
    return new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [supervisor, ...args], {
        cwd: root,
        env: internalGitEnv({
          HOME: dirname(dirname(this.shimHome)),
          GIT_TERMINAL_PROMPT: '0',
          DEVCHAIN_REAL_GIT: 'git',
          DEVCHAIN_GIT_PROJECT: projectId,
          DEVCHAIN_GIT_SIDE: 'home',
          DEVCHAIN_GIT_REMOTE_NAME: remoteName,
          DEVCHAIN_GIT_EXPECTED_REMOTE_ID: remoteId,
        }),
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let writeId: string | undefined;
      let journal: Promise<void> | undefined;
      let journalError: unknown;
      const abort = () => child.kill('SIGTERM');
      signal.addEventListener('abort', abort, { once: true });
      child.once('message', (message: unknown) => {
        if (
          typeof message === 'object' &&
          message !== null &&
          'writeId' in message &&
          typeof message.writeId === 'string'
        ) {
          const id = message.writeId;
          journal = prepare(id)
            .then(() => {
              signal.throwIfAborted();
              writeId = id;
              child.send({ ready: id }, (error) => {
                if (error) abort();
              });
            })
            .catch((error: unknown) => {
              journalError = error;
              abort();
            });
        } else {
          abort();
        }
      });
      child.once('error', reject);
      child.once('close', (code, exitSignal) => {
        signal.removeEventListener('abort', abort);
        void Promise.resolve(journal).then(() => {
          if (journalError) reject(journalError);
          else if (code === 0 && writeId) resolve(writeId);
          else reject(new Error(`Git recovery fetch failed (${exitSignal ?? code})`));
        });
      });
    });
  }

  private async backups(projectId: string): Promise<Backup[]> {
    if (!projectId || projectId === '.' || projectId === '..' || basename(projectId) !== projectId)
      return [];
    const parent = gitBackupRoot(this.paths, projectId);
    const entries = await readdir(parent, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const backups: Backup[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = join(parent, entry.name);
      const text = await readFile(join(directory, RECOVERY_MARKER), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        },
      );
      if (text === null) continue;
      const marker = MarkerSchema.parse(JSON.parse(text));
      if (marker.projectId === projectId) backups.push({ directory, time: entry.name, marker });
    }
    return backups.sort((a, b) => a.marker.createdAt - b.marker.createdAt);
  }

  private async save(directory: string, marker: Marker): Promise<void> {
    const temp = join(directory, `.recovery-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
      await rename(temp, join(directory, RECOVERY_MARKER));
    } finally {
      await rm(temp, { force: true });
    }
  }
}
