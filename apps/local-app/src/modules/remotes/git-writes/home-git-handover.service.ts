import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '../../../common/logging/logger';
import { FILE_SYNC_PATHS, type FileSyncPaths } from '../../file-sync/file-sync-paths';
import { gitIgnores } from '../../file-sync/file-sync.dto';
import {
  FileSyncService,
  projectFolderId,
  senderTransferred,
} from '../../file-sync/file-sync.service';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { GitService } from '../../git/services/git.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { GitCoordinatorIndexService } from '../git-coordinator/git-coordinator-index.service';
import type { GitCoordinatorRecord, GitFence } from '../git-coordinator/git-coordinator.dto';
import { internalGitEnv, missingObjects, refsDigest } from '../git-coordinator/git-checkpoint';
import { DEFAULT_GIT_COORDINATOR_TIMINGS } from '../git-coordinator/git-coordinator.service';
import { GitOwnerStore } from '../git-owner.store';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import { hostErrorCode } from '../transport/host-transport';
import { waitForChangeBarrier } from './change-barrier';
import {
  HomeGitTransitions,
  gitReclaimPending,
  type HomeGitTransitionContext,
} from './home-git-transitions';

const logger = createLogger('HomeGitHandover');
export const HOME_GIT_HANDOVER_TIMINGS = Symbol('HOME_GIT_HANDOVER_TIMINGS');
export const DEFAULT_HOME_GIT_HANDOVER_TIMINGS = {
  barrierPollMs: 100,
  /** Waiting for VM Git processes to exit before the VM guard goes in. */
  drainMs: 90_000,
  barrierMs: 120_000,
  renewMs: DEFAULT_GIT_COORDINATOR_TIMINGS.leaseMs / 3,
  settleMs: 10 * 60_000,
  retryMs: 250,
};
export type HomeGitHandoverTimings = typeof DEFAULT_HOME_GIT_HANDOVER_TIMINGS;
/** A lost answer or a lease that moved on shows as a fence refusal; the VM record says where. */
const MAX_REREADS = 5;

/**
 * Handover (VM → PC) and step-down (PC gives up after a VM reclaim), run by home under its Git
 * admission queue and the project's live-sync queue, so no home write or upkeep runs between
 * steps. The VM journals each handover phase; home resumes from whatever phase the VM record
 * shows. See docs/git-coordinator.md (Handover and step-down).
 */
@Injectable()
export class HomeGitHandoverService extends HomeGitTransitions {
  constructor(
    private readonly host: RemoteHostClient,
    private readonly files: FileSyncService,
    private readonly guard: HomeGitGuardService,
    private readonly indexes: GitCoordinatorIndexService,
    private readonly owners: GitOwnerStore,
    private readonly git: GitService,
    private readonly executor: ProcessExecutor,
    private readonly live: RemoteLiveSyncService,
    @Inject(FILE_SYNC_PATHS) private readonly paths: FileSyncPaths,
    @Inject(HOME_GIT_HANDOVER_TIMINGS) private readonly timings: HomeGitHandoverTimings,
  ) {
    super();
  }

  async handover(context: HomeGitTransitionContext): Promise<void> {
    await this.live.runExclusive(context.projectId, () => this.runHandover(context));
  }

  async stepDown(context: HomeGitTransitionContext): Promise<void> {
    await this.live.runExclusive(context.projectId, () => this.runStepDown(context));
  }

  private async runHandover(context: HomeGitTransitionContext): Promise<void> {
    const { projectId, remoteId, signal, writeId } = context;
    if (!writeId) throw new Error('A Git handover needs the home write it is for');
    const steps = new StepTimer('handover', projectId);
    const lease = new LeaseRenewal(this.host, remoteId, projectId, this.timings.renewMs);
    let record = context.record;
    let rereads = 0;
    try {
      for (;;) {
        const transition = record.transition;
        if (transition?.kind === 'handover' && record.homeWrites[writeId] !== undefined)
          context.published?.(record);
        if (transition && transition.kind !== 'handover') throw gitReclaimPending();
        if (!transition && record.owner === 'home') break;
        const fence: GitFence = {
          expectedGeneration: record.generation,
          transitionId: transition?.id ?? null,
        };
        try {
          if (!transition) {
            signal.throwIfAborted();
            record = await steps.run('begin', () =>
              this.host.handoverBegin(remoteId, projectId, {
                ...fence,
                id: randomUUID(),
                homeName: hostname(),
              }),
            );
          } else if (transition.phase === 'draining') {
            lease.keep(fence);
            if (!transition.sequences) {
              record = await steps.run('drain', () =>
                this.drain(remoteId, projectId, fence, signal),
              );
              continue;
            }
            const sequences = transition.sequences;
            await steps.run('barrier', () => this.barrier(remoteId, sequences));
            // The last moment a lost supervisor can still abort: after this, finish forward.
            signal.throwIfAborted();
            record = await steps.run('vm-receiving', () =>
              this.host.handoverPhase(remoteId, projectId, { ...fence, phase: 'vm-receiving' }),
            );
            lease.stop();
          } else if (transition.phase === 'vm-receiving') {
            record = await steps.run('home-sending', () =>
              this.host.handoverPhase(remoteId, projectId, { ...fence, phase: 'home-sending' }),
            );
          } else if (transition.phase === 'home-sending') {
            await steps.run('home-sendonly', () =>
              this.files.updateFolder(projectFolderId(projectId, 'git'), {
                type: 'sendonly',
                ignores: gitIgnores(true),
                paused: false,
              }),
            );
            record = await steps.run('publish', () =>
              this.host.handoverPhase(remoteId, projectId, {
                ...fence,
                phase: 'published',
                writeId,
              }),
            );
          } else {
            await steps.run('home-finish', () => this.finish(remoteId, projectId, transition.id));
            record = await steps.run('complete', () =>
              this.host.handoverComplete(remoteId, projectId, fence),
            );
          }
        } catch (error) {
          if (hostErrorCode(error) !== 'GIT_GENERATION_MISMATCH' || ++rereads > MAX_REREADS)
            throw error;
          record = await this.host.gitCoordinatorStatus(remoteId, projectId);
        }
      }
      this.owners.remember(projectId, record);
      steps.done();
    } catch (error) {
      lease.stop();
      await this.abortBeforeFlip(remoteId, projectId, record);
      throw error;
    }
  }

  /** Waits for VM Git processes to exit; the VM then installs its guard and records sequences. */
  private async drain(
    remoteId: string,
    projectId: string,
    fence: GitFence,
    signal: AbortSignal,
  ): Promise<GitCoordinatorRecord> {
    const deadline = Date.now() + this.timings.drainMs;
    for (;;) {
      signal.throwIfAborted();
      try {
        return await this.host.handoverPhase(remoteId, projectId, { ...fence, phase: 'draining' });
      } catch (error) {
        if (hostErrorCode(error) !== 'GIT_VM_HELD' || Date.now() >= deadline) throw error;
        await sleep(this.timings.retryMs);
      }
    }
  }

  /** Every VM change up to the recorded sequences is on this PC or failed here. */
  private barrier(remoteId: string, sequences: Record<string, number>): Promise<void> {
    const self = this.files.device().deviceId;
    return waitForChangeBarrier({
      sequences,
      needed: (folderId, sequence) =>
        this.host.syncRemoteNeedThrough(remoteId, folderId, self, sequence),
      failed: async (folderId) =>
        ((await this.files.status(folderId, undefined, { allErrors: true })).fileErrors ?? []).map(
          (error) => error.path,
        ),
      timeoutMs: this.timings.barrierMs,
      pollMs: this.timings.barrierPollMs,
      sleep,
    });
  }

  /**
   * The PC side after the VM published home ownership: guard off, VM worktree branches
   * protected, then the VM's index installed so staged entries move with Git.
   */
  private async finish(remoteId: string, projectId: string, handoverId: string): Promise<void> {
    const removed = await this.guard.remove(projectId, {
      refreshIndex: false,
      failOnReadError: true,
    });
    if (removed.warning) throw new Error(removed.warning);
    const { worktreeBranches } = await this.host.gitCoordinatorStatus(remoteId, projectId);
    const unprotected = await this.guard.protectBranches(projectId, remoteId, worktreeBranches);
    if (unprotected) logger.warn({ projectId }, unprotected);
    const root = await this.files.folderPath(projectId);
    await this.indexes.save(
      projectId,
      await this.host.gitCoordinatorIndex(remoteId, projectId),
      async (indexFile) => {
        const missing = await missingObjects(this.executor, root, indexFile);
        if (missing.length)
          throw new Error(`This PC does not have ${missing.length} objects of the VM index yet`);
      },
    );
    await this.indexes.replace(projectId, handoverId);
    // The VM's stat data does not match this checkout; refresh it so status stays fast.
    await this.executor.run({
      argv: ['git', '-c', 'gc.auto=0', 'update-index', '-q', '--refresh'],
      mode: 'pipe',
      cwd: root,
      env: internalGitEnv(),
      timeout: 60_000,
    });
  }

  /**
   * Before the flip, a failed or abandoned handover is aborted: the VM removes its guard before
   * it reopens holds. If that fails, the VM lease aborts it later.
   */
  private async abortBeforeFlip(
    remoteId: string,
    projectId: string,
    record: GitCoordinatorRecord,
  ): Promise<void> {
    const transition = record.transition;
    if (transition?.kind !== 'handover' || transition.phase !== 'draining') return;
    try {
      await this.host.handoverAbort(remoteId, projectId, {
        expectedGeneration: record.generation,
        transitionId: transition.id,
      });
    } catch (error) {
      logger.warn({ error, projectId }, 'Git handover abort failed; the VM lease will end it');
    }
  }

  private async runStepDown({ projectId, remoteId, record }: HomeGitTransitionContext) {
    const steps = new StepTimer('step-down', projectId);
    const gitId = projectFolderId(projectId, 'git');
    const guardWarning = await steps.run('guard', () => this.guard.install(projectId, remoteId));
    if (guardWarning) logger.warn({ projectId }, guardWarning);
    const root = await this.files.folderPath(projectId);
    const digest = await refsDigest(this.executor, root);
    if (digest !== record.checkpoint?.refsDigest) {
      const backup = await steps.run('backup', () => this.backup(projectId, root));
      logger.warn(
        { projectId, backup },
        'Git on this PC changed after its last confirmed write; its refs and objects were backed up before the VM copy replaces them',
      );
    }
    await steps.run('receiveonly', () =>
      this.files.updateFolder(gitId, {
        type: 'receiveonly',
        ignores: gitIgnores(true),
        paused: false,
      }),
    );
    const self = this.files.device().deviceId;
    await steps.run('settle', () =>
      this.files.waitForComplete(gitId, {
        sender: () => this.host.syncStatus(remoteId, gitId, self),
        receiver: async () => {
          const status = await this.files.status(gitId);
          if (status.receiveOnlyChangedFiles > 0) {
            const source = await this.host.syncStatus(remoteId, gitId, self);
            if (senderTransferred(source, status)) await this.files.revertLocalChanges(gitId);
          }
          return status;
        },
        requireNoReceiveOnlyChanges: true,
        timeoutMs: this.timings.settleMs,
        pollIntervalMs: this.timings.barrierPollMs,
        sides: { sender: 'the VM', receiver: 'this PC' },
      }),
    );
    await steps.run('index', () => this.git.refreshIndexFromHead(projectId, root));
    this.owners.remember(projectId, record);
    steps.done();
  }

  /** Copies HEAD, refs, packed-refs and objects under `~/.devchain/backups/git/`. */
  private async backup(projectId: string, root: string): Promise<string> {
    const target = join(
      dirname(this.paths.syncthingHome()),
      'backups',
      'git',
      projectId,
      new Date().toISOString().replace(/[:.]/g, '-'),
    );
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of ['HEAD', 'packed-refs', 'refs', 'objects']) {
      const source = join(root, '.git', name);
      if (await exists(source)) await cp(source, join(target, name), { recursive: true });
    }
    return target;
  }
}

/** Debug timings per step and in total. */
class StepTimer {
  private readonly started = Date.now();

  constructor(
    private readonly kind: string,
    private readonly projectId: string,
  ) {}

  async run<T>(step: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await work();
    } finally {
      logger.debug(
        { projectId: this.projectId, kind: this.kind, step, ms: Date.now() - started },
        'Git ownership step',
      );
    }
  }

  done(): void {
    logger.debug(
      { projectId: this.projectId, kind: this.kind, ms: Date.now() - this.started },
      'Git ownership move finished',
    );
  }
}

/** Renews the VM's pre-flip lease while home waits; a renewal failure lets the lease run out. */
class LeaseRenewal {
  private timer?: NodeJS.Timeout;
  private fence?: GitFence;

  constructor(
    private readonly host: RemoteHostClient,
    private readonly remoteId: string,
    private readonly projectId: string,
    private readonly everyMs: number,
  ) {}

  /** A new transition after a reread restarts the renewals with its own id. */
  keep(fence: GitFence): void {
    if (
      this.timer &&
      this.fence?.transitionId === fence.transitionId &&
      this.fence.expectedGeneration === fence.expectedGeneration
    )
      return;
    this.stop();
    this.fence = fence;
    this.timer = setInterval(() => {
      this.host.handoverRenew(this.remoteId, this.projectId, fence).catch((error: unknown) => {
        logger.warn({ error, projectId: this.projectId }, 'Git handover lease renewal failed');
      });
    }, this.everyMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.fence = undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
