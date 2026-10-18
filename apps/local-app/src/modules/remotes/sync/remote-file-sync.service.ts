import { Inject, Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import { GitOwnerStore, type GitOwner } from '../git-owner.store';
import { createLogger } from '../../../common/logging/logger';
import { ConflictError } from '../../../common/errors/error-types';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { FileSyncAutoFixStore } from '../../file-sync/file-sync-auto-fix.store';
import type { FileSyncAutoFix } from '../../file-sync/file-sync-auto-fix.dto';
import {
  isSelectableExclusion,
  type ExclusionSuggestion,
} from '../../file-sync/sync-path-inspection.dto';
import { FileSyncFailuresService } from './file-sync-failures.service';
import { FileSyncSuggestionsService } from './file-sync-suggestions.service';
import {
  codeIgnores,
  IgnorePatternsSchema,
  gitIgnores,
  isTransientSyncError,
  type FolderSyncStatus,
} from '../../file-sync/file-sync.dto';
import { SyncthingRestError } from '../../file-sync/syncthing-rest.client';
import {
  FileSyncService,
  evaluateCompletion,
  projectFolderId,
} from '../../file-sync/file-sync.service';
import { GitService } from '../../git/services/git.service';
import type { GitCoordinatorRecord } from '../git-coordinator/git-coordinator.dto';
import {
  STORAGE_SERVICE,
  type RemoteStorage,
  type ProjectStorage,
} from '../../storage/interfaces/storage.interface';
import { RemoteHostRequestError, RemoteHostClient } from '../operations/remote-host.client';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import {
  isStuckFileSyncProblem,
  type SaveProjectIgnoresResult,
  type FileSyncFailedCounts,
  type FileSyncProblem,
  type ForceSyncOffer,
} from './remote-file-sync.dto';

const logger = createLogger('RemoteFileSyncService');
const CHECK_INTERVAL_MS = 30_000;
const OWNERSHIP_SCAN_INTERVAL_MS = 2 * 60_000;
const PROBLEM_GRACE_MS = 2 * 60_000;
const STALLED_MS = 10 * 60_000;
interface SyncObservation {
  since: number;
  count: number;
  bytes?: number;
}
const MOVE_STEPS = ['create', 'settle', 'ignores', 'directions', 'guard', 'done'] as const;
type MoveStep = (typeof MOVE_STEPS)[number];
const stepIndex = (step: MoveStep) => MOVE_STEPS.indexOf(step);
interface ProjectState {
  remoteId: string;
  step: MoveStep;
  hasGit: boolean;
  /** The PC's HEAD after its last receiver index rebuild. */
  homeHead?: string;
  /** The owner-cache revision that `homeHead` belongs to. */
  homeHeadRevision?: number;
  warning: string | null;
  checkProblem?: FileSyncProblem;
  guardWarning?: string | null;
  laneBranchesWarning?: string | null;
  checkWarning?: string | null;
  lastCheck?: number;
  /** Last successful git-ignore repair; drift from outside DevChain is rare. */
  ignoresRepairedAt?: number;
  observations?: Map<string, SyncObservation>;
  failed?: FileSyncFailedCounts;
  autoFixAttempt?: { at: number; home: number; vm: number };
  ownershipScan?: { attemptedAt: number; inspectedSequence?: number };
  /** Sides whose code folder a restart paused and has not yet resumed. */
  resume?: Set<'home' | 'vm'>;
}

/** File upkeep shares live sync's queue; persisted operations can hold it across restarts. */
@Injectable()
export class RemoteFileSyncService {
  private readonly projects = new Map<string, ProjectState>();

  constructor(
    private readonly files: FileSyncService,
    private readonly host: RemoteHostClient,
    private readonly bindings: RemoteBindingsService,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly exclusions: FileSyncManagedExclusionsStore,
    private readonly git: GitService,
    private readonly guard: HomeGitGuardService,
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage & ProjectStorage,
    private readonly autoFix: FileSyncAutoFixStore,
    private readonly failures: FileSyncFailuresService,
    private readonly gitOwner: GitOwnerStore,
    private readonly suggestions: FileSyncSuggestionsService,
  ) {}

  getIgnores(projectId: string): { ignores: string[]; revision: number } {
    return {
      ignores: this.files.getIgnores(projectId),
      revision: this.files.getIgnoresRevision(projectId),
    };
  }

  getAutoFix(projectId: string): FileSyncAutoFix {
    return this.autoFix.get(projectId);
  }

  setAutoFix(projectId: string, enabled: boolean): FileSyncAutoFix {
    return this.autoFix.setEnabled(projectId, enabled);
  }

  warning(projectId: string): string | null {
    const state = this.projects.get(projectId);
    return state?.checkWarning ?? state?.warning ?? state?.guardWarning ?? null;
  }

  problem(projectId: string): FileSyncProblem | null {
    const state = this.projects.get(projectId);
    if (state?.checkWarning) return state.checkProblem ?? null;
    if (state?.warning) return 'setup';
    return null;
  }

  /** With the VM record, a home write, transition or Disconnect in progress also holds upkeep. */
  async hasOpenHold(projectId: string, vm?: GitCoordinatorRecord): Promise<boolean> {
    if (vm && (vm.transition || vm.closed || Object.keys(vm.homeWrites).length)) return true;
    const operations = await this.storage.listRemoteOperations({
      projectId,
      kinds: ['force_sync'],
      states: ['running', 'failed'],
      limit: 1,
    });
    return operations.some(
      (operation) =>
        operation.kind === 'force_sync' &&
        (operation.state === 'running' || operation.state === 'failed'),
    );
  }

  async assertNoHold(projectId: string): Promise<void> {
    if (await this.hasOpenHold(projectId))
      throw new ConflictError(
        'Force sync is running for this project. Save the list after it finishes.',
      );
  }

  async forceSyncOffer(projectId: string, excludeOperationId?: string): Promise<ForceSyncOffer> {
    const pending: ForceSyncOffer['pending'] = { fromVm: null, fromHome: null };
    const refuse = (reason: string): ForceSyncOffer => ({ offered: false, reason, pending });
    const binding = await this.bindings.get(projectId);
    if (binding?.state !== 'remote') return refuse('The project must be connected to Force sync.');
    const device = await this.host.syncDevice(binding.remoteId).catch(() => null);
    const ids = (['code', 'git'] as const).map((kind) => projectFolderId(projectId, kind));
    const reads = await Promise.allSettled([
      ...ids.map((id, index) =>
        this.files.status(id, index === 0 ? device?.deviceId : undefined, { allErrors: true }),
      ),
      ...ids.map((id) =>
        this.host.syncStatus(binding.remoteId, id, undefined, { allErrors: true }),
      ),
    ]);
    const homeCode = reads[0];
    if (homeCode.status === 'fulfilled') {
      pending.fromVm = homeCode.value.needTotalItems ?? null;
      pending.fromHome = homeCode.value.peer?.needItems ?? null;
    }
    const errors: string[] = [];
    for (const [index, read] of reads.entries()) {
      if (read.status === 'rejected') {
        const error: unknown = read.reason;
        if (
          (error instanceof SyncthingRestError || error instanceof RemoteHostRequestError) &&
          error.status === 404
        )
          continue;
        return refuse(
          index < 2
            ? "DevChain could not read this PC's file sync status."
            : "DevChain could not read the VM's file sync status.",
        );
      }
      const status = read.value;
      errors.push(...(status.fileErrors ?? []).map((entry) => entry.error));
      if (status.error) errors.push(status.error);
    }
    const persistent = errors.filter((error) => !isTransientSyncError(error));
    if (persistent.some((error) => /permission denied|operation not permitted/i.test(error)))
      return refuse('Repair file permissions before using Force sync.');
    const health = this.health.getState(binding.remoteId);
    if (health.apiKeyRejected) return refuse("The VM rejected this PC's API key.");
    if (!health.online) return refuse('The VM is offline.');
    if (!health.versionMatches) return refuse('The VM runs a different DevChain version.');
    if (!device) return refuse("DevChain could not read the VM's file sync status.");
    const connected = await this.files.isConnected(device.deviceId).catch(() => false);
    if (!connected) return refuse('There is no file sync connection to the VM.');
    const operations = await this.storage.listRemoteOperations({
      projectId,
      states: ['running', 'failed'],
    });
    if (operations.some((operation) => operation.id !== excludeOperationId))
      return refuse('Another operation is open for this project.');
    const problem = this.problem(projectId);
    const failedFiles = reads.some(
      (read) =>
        read.status === 'fulfilled' &&
        (read.value.fileErrors ?? []).some((entry) => !isTransientSyncError(entry.error)),
    );
    if (!isStuckFileSyncProblem(problem) && !failedFiles)
      return refuse('File sync has no stuck problem to repair.');
    return { offered: true, reason: null, pending };
  }

  failedCounts(projectId: string): FileSyncFailedCounts | null {
    return this.projects.get(projectId)?.failed ?? null;
  }

  forget(projectId: string): void {
    this.projects.delete(projectId);
  }

  /** The caller holds live sync's per-project queue until both pushes finish. */
  async saveIgnores(
    projectId: string,
    list: string[] | null,
    active: () => boolean,
    expectedRevision?: number,
  ): Promise<SaveProjectIgnoresResult> {
    const ignores = this.files.setIgnores(projectId, list, expectedRevision);
    const revision = this.files.getIgnoresRevision(projectId);
    const notApplied = (reason: string): SaveProjectIgnoresResult => ({
      ignores,
      revision,
      applied: false,
      message: `Saved, not applied yet: ${reason}; DevChain applies it automatically while the project stays connected.`,
    });
    const deferred = (reason: string): SaveProjectIgnoresResult => {
      const state = this.projects.get(projectId);
      if (state && stepIndex(state.step) > stepIndex('ignores')) state.step = 'ignores';
      return notApplied(reason);
    };
    let reason = 'the connection could not be checked';
    try {
      const binding = await this.bindings.get(projectId);
      if (binding?.state === 'attaching') return notApplied('the project is connecting');
      if (binding?.state !== 'remote') {
        return {
          ignores,
          revision,
          applied: false,
          message: 'Saved. The list applies at the next Connect.',
        };
      }
      if (!active()) return deferred('live sync is not running');
      const health = this.health.getState(binding.remoteId);
      if (health.apiKeyRejected) return deferred("the VM rejected this PC's API key");
      if (!health.online) return deferred('the VM is offline');
      if (!health.versionMatches) return deferred('the VM runs a different DevChain version');
      const state = this.projects.get(projectId);
      // Removing .git from the code share must wait for the separate git share to settle.
      if (
        !state ||
        state.remoteId !== binding.remoteId ||
        stepIndex(state.step) < stepIndex('ignores')
      ) {
        return deferred('file sync setup is still running');
      }
      reason = 'the ignore list could not be prepared';
      const installed = codeIgnores(this.exclusions.get(projectId), ignores);
      const codeId = projectFolderId(projectId, 'code');
      reason = 'the VM could not apply the list';
      await this.host.syncFolderType(binding.remoteId, codeId, { ignores: installed });
      await this.retryPullErrors(projectId, 'vm', binding.remoteId, active);
      if (!active()) return deferred('the connection is changing');
      reason = 'this PC could not apply the list';
      try {
        await this.files.updateFolder(codeId, { ignores: installed });
        await this.retryPullErrors(projectId, 'home', binding.remoteId, active);
      } catch (error) {
        if (error instanceof SyncthingRestError && error.status === 404)
          reason = 'the folder is not shared on this PC';
        throw error;
      }
      return { ignores, revision, applied: true, message: 'Applied to the VM and this PC.' };
    } catch (error) {
      logger.warn({ error, projectId }, 'Saved file sync ignores will retry');
      return deferred(reason);
    }
  }

  private async retryPullErrors(
    projectId: string,
    side: 'home' | 'vm',
    remoteId: string,
    active: () => boolean,
  ): Promise<void> {
    const codeId = projectFolderId(projectId, 'code');
    try {
      if (!active()) return;
      const status =
        side === 'vm'
          ? await this.host.syncStatus(remoteId, codeId)
          : await this.files.status(codeId);
      if (!active() || (status.pullErrors ?? 0) <= 0) return;
      const state = this.projects.get(projectId);
      // Owed until a resume succeeds; `tick` retries it, so a lost resume never strands a pause.
      if (state) (state.resume ??= new Set()).add(side);
      // Resume even if pausing reports an error: the remote response may have been lost.
      try {
        await this.pauseCode(codeId, side, remoteId, true);
      } finally {
        await this.pauseCode(codeId, side, remoteId, false);
        state?.resume?.delete(side);
      }
    } catch (error) {
      logger.warn(
        { error, projectId, side },
        'File sync folder restart failed after applying ignores',
      );
    }
  }

  private pauseCode(
    codeId: string,
    side: 'home' | 'vm',
    remoteId: string,
    paused: boolean,
  ): Promise<void> {
    return side === 'vm'
      ? this.host.syncFolderType(remoteId, codeId, { paused })
      : this.files.updateFolder(codeId, { paused });
  }

  /** Completes resumes that a failed request left owed; each side stays owed until one succeeds. */
  private async resumeOwed(projectId: string, state: ProjectState): Promise<void> {
    const codeId = projectFolderId(projectId, 'code');
    for (const side of [...(state.resume ?? [])]) {
      try {
        await this.pauseCode(codeId, side, state.remoteId, false);
        state.resume!.delete(side);
      } catch (error) {
        logger.warn({ error, projectId, side }, 'File sync folder resume will retry');
      }
    }
  }

  private async repairGitIgnores(projectId: string, remoteId: string): Promise<void> {
    const id = projectFolderId(projectId, 'git');
    const ignores = gitIgnores(true);
    const [home, vm] = await Promise.all([
      this.files.installedIgnores(id),
      this.host.syncFolderIgnores(remoteId, id),
    ]);
    if (home.ignore.join('\0') !== ignores.join('\0'))
      await this.files.updateFolder(id, { ignores });
    if (vm.ignore.join('\0') !== ignores.join('\0'))
      await this.host.syncFolderType(remoteId, id, { ignores }, this.gitOwner.fence(projectId));
  }

  async tick(projectId: string, remoteId: string, active: () => boolean): Promise<void> {
    const health = this.health.getState(remoteId);
    if (!active() || !health.online || health.apiKeyRejected || !health.versionMatches) return;
    if (await this.hasOpenHold(projectId)) return;
    const binding = await this.bindings.get(projectId);
    if (!active() || binding?.state !== 'remote' || binding.remoteId !== remoteId) return;
    let state = this.projects.get(projectId);
    if (!state || state.remoteId !== remoteId) {
      state = { remoteId, step: 'create', hasGit: false, warning: null };
      this.projects.set(projectId, state);
    }
    try {
      if (state.resume?.size) await this.resumeOwed(projectId, state);
      if (!active()) return;
      if (state.step !== 'done') {
        await this.move(projectId, state, active);
        // Migration's revert and ordinary upkeep must never run in the same tick.
        return;
      }
      const now = Date.now();
      if (
        state.hasGit &&
        (state.ignoresRepairedAt === undefined ||
          now - state.ignoresRepairedAt >= CHECK_INTERVAL_MS)
      ) {
        await this.repairGitIgnores(projectId, remoteId);
        state.ignoresRepairedAt = now;
      }
      if (!active()) return;
      await this.checkSync(projectId, state, active);
      if (!state.hasGit || !active()) return;
      const vm = await this.host.gitCoordinatorStatus(remoteId, projectId);
      if (!active() || (await this.hasOpenHold(projectId, vm))) return;
      const owner = this.followVmRecord(projectId, vm, state);
      if (owner === null || !active()) return;
      if (owner === 'home') {
        await this.protectLaneBranches(projectId, remoteId, state, vm.worktreeBranches);
        if (!active()) return;
      }
      // Receiver maintenance only: it never changes the owner's side or the VM index.
      const id = projectFolderId(projectId, 'git');
      const config =
        owner === 'vm'
          ? await this.files.folderConfiguration(id)
          : await this.host.syncFolderConfiguration(remoteId, id);
      if (!active() || config.type !== 'receiveonly' || config.paused) return;
      const status =
        owner === 'vm' ? await this.files.status(id) : await this.host.syncStatus(remoteId, id);
      if (!active() || status.state !== 'idle' || status.needTotalItems !== 0) return;
      state.warning = null;
      if (status.receiveOnlyChangedFiles > 0) {
        if (owner === 'vm') await this.files.revertLocalChanges(id);
        else await this.host.syncRevert(remoteId, id, this.gitOwner.fence(projectId));
        return;
      }
      // While the PC owns Git, the VM index changes only through confirmed checkpoints.
      if (owner === 'home') return;
      // Each change of Git control starts a new receiver lifetime, even when Git left and came
      // back between two ticks, so an earlier rebuild no longer applies.
      const revision = this.gitOwner.revision(projectId);
      if (state.homeHeadRevision !== revision) {
        state.homeHead = undefined;
        state.homeHeadRevision = revision;
      }
      const root = await this.files.folderPath(projectId);
      const head = await this.git.mirroredHead(projectId, root);
      if (!active() || head === null || head === state.homeHead) return;
      await this.git.refreshIndexFromHead(projectId, root);
      state.homeHead = head;
    } catch (error) {
      state.warning =
        'File sync could not finish updating this project. It will retry automatically.';
      logger.warn({ error, projectId, step: state.step }, 'Remote file sync will retry');
    }
  }

  /** While this PC owns Git, its hooks refuse changes to branches that VM worktrees check out. */
  private async protectLaneBranches(
    projectId: string,
    remoteId: string,
    state: ProjectState,
    worktreeBranches: string[],
  ): Promise<void> {
    try {
      const warning = await this.guard.protectBranches(projectId, remoteId, worktreeBranches);
      if (warning && warning !== state.laneBranchesWarning) logger.warn({ projectId }, warning);
      state.laneBranchesWarning = warning;
    } catch (error) {
      // The previous protection stays installed until a refresh succeeds.
      logger.warn({ error, projectId }, 'VM worktree branch protection was not refreshed');
    }
  }

  /**
   * The owner upkeep may act for, or null when this PC's cache disagrees with the VM record in a
   * way only a handover or step-down may settle. A VM-owned record only moves the cached
   * generation forward; this PC is the receiver either way.
   */
  private followVmRecord(
    projectId: string,
    vm: GitCoordinatorRecord,
    state: ProjectState,
  ): GitOwner | null {
    const cached = this.gitOwner.get(projectId);
    // `cached === 'home'` with a VM-owned record at the same generation is a PC that took Git with
    // the removed manual take: its saved 'home' reads as generation 0, and the VM record starts at
    // vm/0. It is not dead code.
    if (
      vm.generation === this.gitOwner.generation(projectId) &&
      (vm.owner === cached || cached === 'home')
    )
      return cached;
    if (vm.owner === 'vm' && cached === 'vm') {
      this.gitOwner.remember(projectId, vm);
      return 'vm';
    }
    state.warning =
      cached === 'home'
        ? 'The VM took Git back while this PC was away. File sync continues after this PC gives up Git.'
        : 'Git is moving to this PC. File sync continues after the move finishes.';
    return null;
  }

  private async checkSync(
    projectId: string,
    state: ProjectState,
    active: () => boolean,
  ): Promise<void> {
    const now = Date.now();
    if (!active() || (state.lastCheck !== undefined && now - state.lastCheck < CHECK_INTERVAL_MS))
      return;
    state.lastCheck = now;
    try {
      const folders = await this.files.projectFolders(projectId);
      const configurations = await Promise.all(
        folders.map(async (folder) => ({
          ...folder,
          config: await this.files.folderConfiguration(folder.id),
        })),
      );
      const code = configurations.find((folder) => folder.kind === 'code');
      const homeId = this.files.device().deviceId;
      const peers = code?.config.devices.filter((device) => device.deviceID !== homeId);
      if (!code || peers?.length !== 1)
        throw new Error('Expected one VM device in the code folder');
      const peerId = peers[0].deviceID;
      const [connected, statuses, vmStatus] = await Promise.all([
        this.files.isConnected(peerId),
        Promise.all(
          configurations.map(async (folder) => ({
            ...folder,
            status: await this.files.status(folder.id, folder.kind === 'code' ? peerId : undefined),
          })),
        ),
        this.host.syncStatus(state.remoteId, code.id).catch((error: unknown) => {
          logger.warn({ error, projectId }, 'VM file sync status could not be read');
          return null;
        }),
      ]);
      if (!active()) return;
      const observations = new Map<string, SyncObservation>();
      const warnings: { message: string; problem: FileSyncProblem }[] = [];
      /** Returns the count once it has lasted `limit`, otherwise 0. */
      const observe = (
        key: string,
        count: number,
        limit: number,
        message: (since: string) => string,
        problem: FileSyncProblem,
        bytes?: number,
      ): number => {
        if (count <= 0) return 0;
        const previous = state.observations?.get(key);
        const since =
          !previous ||
          count < previous.count ||
          (bytes !== undefined && previous.bytes !== undefined && bytes < previous.bytes)
            ? now
            : previous.since;
        observations.set(key, { since, count, bytes });
        if (now - since < limit) return 0;
        warnings.push({ message: message(new Date(since).toTimeString().slice(0, 5)), problem });
        return count;
      };
      observe(
        'connection',
        connected ? 0 : 1,
        PROBLEM_GRACE_MS,
        (since) =>
          `No file sync connection to the VM since ${since}; changes do not move between this PC and the VM.`,
        'connection',
      );
      const homeCode = statuses.find((folder) => folder.kind === 'code')!;
      const vmCount = vmStatus
        ? (vmStatus.errors ?? 0)
        : (state.observations?.get('vm-failed')?.count ?? 0);
      const vmFailed = observe(
        'vm-failed',
        vmCount,
        PROBLEM_GRACE_MS,
        (since) => `${vmCount} files on the VM fail to sync since ${since}.`,
        'failed-files',
      );
      const homeCount = homeCode.status.errors ?? 0;
      const homeFailed = observe(
        'home-failed',
        homeCount,
        PROBLEM_GRACE_MS,
        (since) => `${homeCount} files on this PC fail to sync since ${since}.`,
        'failed-files',
      );
      for (const { id, kind, config, status } of statuses) {
        const error = folderError(config, status, kind !== 'code');
        observe(
          `error:${id}`,
          error ? 1 : 0,
          PROBLEM_GRACE_MS,
          (since) => `File sync at home has an error since ${since}: ${error}.`,
          !config.paused && !status.error?.trim() && (status.errors ?? 0) > 0
            ? 'failed-files'
            : 'error',
        );
      }
      const stalled = `no progress for ${STALLED_MS / 60_000} minutes`;
      for (const { id, status } of statuses) {
        observe(
          `home:${id}`,
          status.needTotalItems,
          STALLED_MS,
          (since) =>
            `This PC has not received ${status.needTotalItems} pending file sync items since ${since} (${stalled}).`,
          'stalled',
          status.needBytes,
        );
        const { peer } = status;
        if (peer) {
          observe(
            `peer:${id}`,
            peer.needItems,
            STALLED_MS,
            (since) =>
              `The VM has not received ${peer.needItems} pending file sync items from this PC since ${since} (${stalled}).`,
            'stalled',
            peer.needBytes,
          );
        }
      }
      state.observations = observations;
      state.checkWarning = warnings[0]?.message ?? null;
      state.checkProblem = warnings[0]?.problem;
      state.failed = homeFailed || vmFailed ? { home: homeFailed, vm: vmFailed } : undefined;
      if (homeCount === 0 && vmCount === 0) state.autoFixAttempt = undefined;
      if (state.failed && active())
        await this.fixAutomatically(
          projectId,
          state,
          { home: homeCount, vm: vmCount },
          now,
          active,
        );
      if (vmStatus?.sequence !== undefined && active())
        await this.scanVmOwnership(projectId, state, vmStatus.sequence, now, active);
    } catch (error) {
      if (!active()) return;
      state.checkProblem = 'error';
      state.checkWarning = 'DevChain could not read the file sync status. It will try again.';
      logger.warn({ error, projectId }, 'Remote file sync check failed');
    }
  }

  private async fixAutomatically(
    projectId: string,
    state: ProjectState,
    counts: FileSyncFailedCounts,
    now: number,
    active: () => boolean,
  ): Promise<void> {
    if (!this.autoFix.get(projectId).enabled) return;
    const previous = state.autoFixAttempt;
    if (
      previous &&
      previous.home === counts.home &&
      previous.vm === counts.vm &&
      now - previous.at < STALLED_MS
    )
      return;
    state.autoFixAttempt = { ...counts, at: now };
    try {
      const revision = this.files.getIgnoresRevision(projectId);
      const failed = await this.failures.failed(projectId);
      if (!active() || !this.autoFix.get(projectId).enabled) return;
      await this.applyAutomaticExclusions(projectId, failed.groups, revision, now, active);
    } catch (error) {
      logger.warn({ error, projectId }, 'Automatic file sync exclusions will retry');
    }
  }

  private async scanVmOwnership(
    projectId: string,
    state: ProjectState,
    sequence: number,
    now: number,
    active: () => boolean,
  ): Promise<void> {
    if (!this.autoFix.get(projectId).enabled) return;
    const previous = state.ownershipScan;
    if (
      previous &&
      (sequence === previous.inspectedSequence ||
        now - previous.attemptedAt < OWNERSHIP_SCAN_INTERVAL_MS)
    )
      return;
    const scan = { ...previous, attemptedAt: now };
    state.ownershipScan = scan;
    try {
      const revision = this.files.getIgnoresRevision(projectId);
      const result = await this.suggestions.vmSuggestions(projectId, state.remoteId);
      if (!active() || !this.autoFix.get(projectId).enabled) return;
      if (
        await this.applyAutomaticExclusions(projectId, result.groups, revision, now, active, 'vm')
      )
        scan.inspectedSequence = sequence;
    } catch (error) {
      logger.warn({ error, projectId }, 'VM ownership exclusions will retry');
    }
  }

  private async applyAutomaticExclusions(
    projectId: string,
    suggestions: ExclusionSuggestion[],
    revision: number,
    now: number,
    active: () => boolean,
    sourceSide?: 'vm',
  ): Promise<boolean> {
    const groups = suggestions.filter(
      (group) =>
        isSelectableExclusion(group) &&
        group.selected &&
        group.reasonKind === 'foreignOwner' &&
        !group.home?.tracked &&
        !group.vm?.tracked &&
        group.patternChecksPassed === true,
    );
    const current = this.files.getIgnores(projectId);
    const additions = groups
      .flatMap((group) => group.patterns)
      .filter((pattern) => !current.includes(pattern));
    const list = [...new Set([...current, ...additions])];
    if (additions.length === 0) return true;
    if (!IgnorePatternsSchema.safeParse(list).success) return false;
    if (await this.hasOpenHold(projectId)) return false;
    if (!active()) return false;
    const saved = await this.saveIgnores(projectId, list, active, revision);
    for (const side of ['home', 'vm'] as const) {
      const patterns = [
        ...new Set(
          groups
            .filter((group) => (sourceSide ?? group.side) === side)
            .flatMap((group) => group.patterns)
            .filter((pattern) => additions.includes(pattern)),
        ),
      ];
      if (patterns.length)
        this.autoFix.record(projectId, {
          at: new Date(now).toISOString(),
          kind: 'exclude',
          side,
          patterns,
        });
    }
    return saved.applied;
  }

  private async move(projectId: string, state: ProjectState, active: () => boolean): Promise<void> {
    const { remoteId } = state;
    const codeId = projectFolderId(projectId, 'code');
    const gitId = projectFolderId(projectId, 'git');
    if (state.step === 'create') {
      const folders = await this.files.projectFolders(projectId);
      if (!active() || !folders.some((folder) => folder.kind === 'code')) return;
      state.hasGit = (await this.files.initialFolders(projectId)).some(
        (folder) => folder.kind === 'git',
      );
    }
    // Directions follow the VM record: a stale cache after a VM reclaim must not undo it.
    let owner: GitOwner = this.gitOwner.get(projectId);
    if (state.hasGit) {
      const vm = await this.host.gitCoordinatorStatus(remoteId, projectId);
      if (!active() || (await this.hasOpenHold(projectId, vm))) return;
      const followed = this.followVmRecord(projectId, vm, state);
      if (followed === null) return;
      owner = followed;
    }
    const fence = this.gitOwner.fence(projectId);
    if (state.step === 'create') {
      if (state.hasGit) {
        const home = this.files.device();
        const host = await this.host.syncDevice(remoteId);
        if (!active()) return;
        await this.files.addPeer(host);
        await this.host.syncPeer(remoteId, home);
        const ensureVm = () =>
          this.host.syncFolders(
            remoteId,
            {
              projectId,
              kind: 'git',
              type: owner === 'vm' ? 'sendonly' : 'receiveonly',
              peerDeviceId: home.deviceId,
              ignores: gitIgnores(true),
              paused: true,
            },
            fence,
          );
        const ensureHome = () =>
          this.files.ensureFolder({
            projectId,
            kind: 'git',
            type: owner === 'home' ? 'sendonly' : 'receiveonly',
            peerDeviceId: host.deviceId,
            ignores: gitIgnores(true),
            paused: true,
          });
        // Configure the receiver first so a retry never leaves two send-only sides.
        if (owner === 'vm') {
          await ensureHome();
          await ensureVm();
        } else {
          await ensureVm();
          await ensureHome();
        }
        await this.host.syncFolderType(remoteId, gitId, { paused: false }, fence);
        await this.files.updateFolder(gitId, { paused: false });
        await Promise.all([this.host.syncScan(remoteId, gitId, fence), this.files.rescan(gitId)]);
      }
      state.step = state.hasGit ? 'settle' : 'ignores';
    }
    if (!active()) return;
    if (state.step === 'settle') {
      const config =
        owner === 'vm'
          ? await this.files.folderConfiguration(gitId)
          : await this.host.syncFolderConfiguration(remoteId, gitId);
      if (config.type !== 'receiveonly' || config.paused)
        throw new Error('Git share is not receiving');
      const [sender, receiver] = await Promise.all(
        owner === 'vm'
          ? [
              this.host.syncStatus(remoteId, gitId, this.files.device().deviceId),
              this.files.status(gitId),
            ]
          : [
              this.files.status(gitId, (await this.host.syncDevice(remoteId)).deviceId),
              this.host.syncStatus(remoteId, gitId),
            ],
      );
      if (!active()) return;
      if (receiver.state === 'idle' && receiver.receiveOnlyChangedFiles > 0) {
        if (owner === 'vm') await this.files.revertLocalChanges(gitId);
        else await this.host.syncRevert(remoteId, gitId, fence);
        return;
      }
      if (!evaluateCompletion(sender, receiver).done) {
        state.warning =
          'Git sync is still settling. The file sync update will retry automatically.';
        return;
      }
      state.step = 'ignores';
    }
    if (!active()) return;
    if (state.step === 'ignores') {
      const ignores = codeIgnores(this.exclusions.get(projectId), this.files.getIgnores(projectId));
      await this.host.syncFolderType(remoteId, codeId, { ignores });
      await this.files.updateFolder(codeId, { ignores });
      state.step = 'directions';
    }
    if (!active()) return;
    if (state.step === 'directions') {
      // Unpausing here also recovers a restart pause that a home restart forgot to resume.
      await this.host.syncFolderType(remoteId, codeId, { type: 'sendreceive', paused: false });
      await this.files.updateFolder(codeId, { type: 'sendreceive', paused: false });
      state.step = 'guard';
    }
    if (!active()) return;
    if (state.step === 'guard') {
      if (state.hasGit) {
        state.guardWarning =
          owner === 'vm'
            ? await this.guard.install(projectId, remoteId)
            : (
                await this.host.installGitGuard(
                  remoteId,
                  projectId,
                  { homeName: hostname(), reason: 'pc-git' },
                  fence,
                )
              ).warning;
      }
      state.step = 'done';
      state.warning = null;
    }
  }
}

/** What is wrong with a home folder, in the order a user should fix it; null when nothing is. */
function folderError(
  config: { paused: boolean },
  status: FolderSyncStatus,
  includeFailedFiles = true,
): string | null {
  if (config.paused) return 'folder is paused';
  const message = status.error?.trim();
  if (message) return message;
  if (includeFailedFiles && (status.errors ?? 0) > 0) return `${status.errors} files failed`;
  if (status.state === 'error') return 'folder is in an error state';
  return null;
}
