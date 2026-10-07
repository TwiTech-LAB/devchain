import { Injectable } from '@nestjs/common';
import { GitOwnerStore, type GitOwner } from '../git-owner.store';
import { hostname } from 'node:os';
import { AppError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  codeIgnores,
  gitIgnores,
  isTransientSyncError,
  RemoteNeedSchema,
  ConflictBaselineSchema,
  CONFLICT_BASELINE_MAX,
  RECEIVE_ONLY_SAMPLE_MAX,
  type FolderSyncStatus,
  type SyncFolderPatch,
  type SyncStatusOptions,
} from '../../file-sync/file-sync.dto';
import {
  FileSyncService,
  FileSyncTimeoutError,
  codeFolderId,
  projectFolderId,
  projectFolderList,
  senderIndexReached,
  evaluateCompletion,
  type FolderNeed,
  type ProjectFolder,
  type SyncProgress,
} from '../../file-sync/file-sync.service';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { projectRepository } from '../../file-sync/project-repository';
import { SyncthingRestError } from '../../file-sync/syncthing-rest.client';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { RemoteHostClient, RemoteHostRequestError } from './remote-host.client';
import type { RemoteOperationStepRun } from './remote-operation.types';
import { deleteSyncthingTempFiles } from './syncthing-temp-cleanup';

const logger = createLogger('FileSyncHandoff');

/** How long a sync may run before its step fails; the step can be retried. */
const SYNC_TIMEOUT_MS = 30 * 60_000;
const CONNECT_TIMEOUT_MS = 60_000;
const POLL_MS = 500;

/** What the file-sync steps keep in `operation.details.fileSync`. */
export interface FileSyncDetails {
  folders: Record<string, SyncProgress>;
}

/** What a forced disconnect may leave behind: per folder, what home had not received. */
export type FileSyncLoss = { folders: FolderNeed[] } | 'unknown';

export class FileSyncNotConnectedError extends AppError {
  constructor(address: string) {
    super(
      `Syncthing at home could not connect to the remote's Syncthing at ${address}.`,
      'FILE_SYNC_NOT_CONNECTED',
      502,
      { address },
    );
  }
}

type Side = 'home' | 'host';
/** How a sync error message names each side. */
const SIDE_NAMES: Record<Side, string> = { home: 'this PC', host: 'the VM' };

export interface ForceSyncDetails {
  backups: { side: 'home' | 'vm'; kind: ProjectFolder['kind']; path: string }[];
  replaced?: { count: number; sample: string[] };
  verified: boolean;
}

function forceErrors(status: FolderSyncStatus) {
  const failures = (status.fileErrors ?? []).filter((file) => !isTransientSyncError(file.error));
  return {
    failures,
    failed:
      failures.length > 0 ||
      (status.errors ?? 0) > (status.fileErrors?.length ?? 0) ||
      (!!status.error && !isTransientSyncError(status.error)),
  };
}

/** Handoffs keep code two-way while Git metadata flows from its saved owner. */
@Injectable()
export class FileSyncHandoff {
  /**
   * One controller per cancellable Connect or Git settlement, so cancellation ends
   * pairing, home rescans and completion waits. A controller leaves the map only while it
   * is still the current one, so a superseded run cannot drop a newer one.
   */
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly fileSync: FileSyncService,
    private readonly host: RemoteHostClient,
    private readonly managedExclusions: FileSyncManagedExclusionsStore,
    private readonly guard: HomeGitGuardService,
    private readonly processExecutor: ProcessExecutor,
    private readonly gitOwner: GitOwnerStore,
  ) {}

  /** Stops an in-flight Connect or Git settlement at its next cancellation boundary. */
  interrupt(operationId: string, reason = 'The Connect was cancelled.'): void {
    this.active.get(operationId)?.abort(new Error(reason));
  }

  /**
   * Connect merges code when both records predate the attempt; otherwise home
   * replaces the VM copy. Git always follows home's copy until the flip.
   */
  async initial(run: RemoteOperationStepRun, projectId: string): Promise<void> {
    const controller = new AbortController();
    this.active.set(run.operation.id, controller);
    try {
      const { remoteId } = run.operation;
      const ignores = this.syncIgnores(projectId);
      // The persisted step-start marker owns cancellation cleanup even when
      // this request changes hooks but loses its response.
      const { removed } = await this.host.removeGitGuard(remoteId, projectId);
      if (removed) await run.progress({ vmGuardRemoved: true });
      controller.signal.throwIfAborted();
      const codeId = codeFolderId(projectId);
      if (run.details.fileSyncMode !== 'merge' && run.details.fileSyncMode !== 'reset') {
        const [homeFolders, hostExists] = await Promise.all([
          this.fileSync.projectFolders(projectId),
          this.host.syncFolderExists(remoteId, codeId),
        ]);
        await run.progress(
          {
            fileSyncMode:
              hostExists && homeFolders.some((folder) => folder.id === codeId) ? 'merge' : 'reset',
          },
          { durable: true },
        );
      }
      controller.signal.throwIfAborted();
      const merge = run.details.fileSyncMode === 'merge';
      const devices = await this.pair(remoteId, controller.signal);
      const folders = await this.fileSync.initialFolders(projectId);
      for (const folder of folders) {
        const request = {
          projectId,
          kind: folder.kind,
          ignores: folder.kind === 'code' ? ignores : gitIgnores(false),
          paused: true,
        };
        const mergeCode = merge && folder.kind === 'code';
        if (mergeCode) await this.fileSync.updateFolder(folder.id, { paused: true });
        else
          await this.fileSync.ensureFolder({
            ...request,
            type: 'sendonly',
            peerDeviceId: devices.host,
          });
        await this.host.syncFolders(remoteId, {
          ...request,
          type: mergeCode ? 'sendreceive' : 'receiveonly',
          peerDeviceId: devices.home,
        });
      }
      if (merge) {
        await this.host.syncFolderType(remoteId, codeId, { paused: false });
        await this.host.syncScan(remoteId, codeId);
        await this.waitHostIdle(remoteId, codeId, controller.signal);
        if (
          run.details.vmEdits === undefined &&
          run.details.fileSyncConflictBaseline === undefined
        ) {
          const vmEdits = await this.host.syncRemoteNeed(remoteId, codeId, devices.home);
          const homeBaseline = await this.fileSync.conflictBaseline(
            projectId,
            ignores,
            controller.signal,
          );
          const paths = new Set([
            ...vmEdits.conflictPaths,
            ...(homeBaseline.baselineOverCap ? [] : homeBaseline.paths),
          ]);
          const fileSyncConflictBaseline =
            homeBaseline.baselineOverCap ||
            vmEdits.conflictsOverCap ||
            paths.size > CONFLICT_BASELINE_MAX
              ? { baselineOverCap: true }
              : { baselineOverCap: false, paths: [...paths] };
          await run.progress({ vmEdits, fileSyncConflictBaseline }, { durable: true });
        } else {
          RemoteNeedSchema.parse(run.details.vmEdits);
          ConflictBaselineSchema.parse(run.details.fileSyncConflictBaseline);
        }
        controller.signal.throwIfAborted();
        await this.fileSync.ensureFolder({
          projectId,
          kind: 'code',
          ignores,
          paused: true,
          type: 'sendreceive',
          peerDeviceId: devices.host,
        });
      }
      await this.unpauseAll(remoteId, folders);
      await this.waitAll(run, folders, {
        sender: 'home',
        devices,
        symmetricCode: merge,
        signal: controller.signal,
      });
      if (merge) {
        const fileSyncConflicts = await this.fileSync.conflicts(
          projectId,
          ConflictBaselineSchema.parse(run.details.fileSyncConflictBaseline),
          ignores,
          controller.signal,
        );
        await run.progress({ fileSyncConflicts });
      }
    } finally {
      if (this.active.get(run.operation.id) === controller) this.active.delete(run.operation.id);
    }
  }

  /** Connect's preflight: home's Syncthing must run before Connect changes anything. */
  async ensureAvailable(): Promise<void> {
    await this.fileSync.ensureAvailable();
  }

  /**
   * Runs `git init` at home when the root has no usable repository; a partial `.git`
   * from a failed attempt counts as missing (`projectRepository`). Returns whether it ran.
   */
  async ensureRepository(projectId: string): Promise<boolean> {
    const root = await this.fileSync.folderPath(projectId);
    if ((await projectRepository(root)) !== 'missing') return false;
    const result = await this.processExecutor.run({
      argv: ['git', 'init'],
      mode: 'pipe',
      cwd: root,
      timeout: 30_000,
    });
    if (!result.success) {
      throw new AppError(
        result.stderr.trim() ||
          result.stdout.trim() ||
          'Could not create a Git repository on this PC.',
        'GIT_INIT_FAILED',
        500,
      );
    }
    return true;
  }

  /** Connect: keep code two-way, then switch git to remote ownership, receiver first. */
  async flipToHost(run: RemoteOperationStepRun, projectId: string): Promise<void> {
    const { remoteId } = run.operation;
    const folders = await this.fileSync.projectFolders(projectId);
    await this.hostDirections(remoteId, folders, 'vm', false);
    if (folders.some((folder) => folder.kind === 'git')) {
      const guardWarning = await this.guard.install(projectId, remoteId);
      if (guardWarning) await run.progress({ guardWarning });
    }
  }

  /** Settles the guarded sender before a Git ownership flip. */
  async settleGit(run: RemoteOperationStepRun, projectId: string, owner: GitOwner): Promise<void> {
    const controller = new AbortController();
    const { remoteId, id } = run.operation;
    this.active.set(id, controller);
    try {
      const devices = await this.pair(remoteId, controller.signal);
      const folders = projectFolderList(projectId, ['git']);
      const config =
        owner === 'vm'
          ? await this.fileSync.folderConfiguration(folders[0].id)
          : await this.host.syncFolderConfiguration(remoteId, folders[0].id);
      controller.signal.throwIfAborted();
      if (config.type !== 'receiveonly' || config.paused)
        throw new AppError(
          'The receiving Git folder is not ready. Retry the switch.',
          'GIT_SWITCH_RECEIVER_NOT_READY',
          409,
        );
      await this.waitAll(run, folders, {
        sender: owner === 'vm' ? 'host' : 'home',
        devices,
        requireNoReceiveOnlyChanges: true,
        revertAfterComplete: true,
        signal: controller.signal,
      });
    } finally {
      if (this.active.get(id) === controller) this.active.delete(id);
    }
  }

  async flipGit(run: RemoteOperationStepRun, projectId: string, owner: GitOwner): Promise<void> {
    const { remoteId } = run.operation;
    const folderId = projectFolderId(projectId, 'git');
    const ignores = gitIgnores(true);
    if (owner === 'home') {
      await this.host.syncFolderType(remoteId, folderId, { type: 'receiveonly', ignores });
      await this.fileSync.updateFolder(folderId, { type: 'sendonly', ignores });
    } else {
      await this.fileSync.updateFolder(folderId, { type: 'receiveonly', ignores });
      await this.host.syncFolderType(remoteId, folderId, { type: 'sendonly', ignores });
    }
    this.gitOwner.set(projectId, owner);
    await this.host.syncFolderType(remoteId, folderId, { paused: false });
    await this.fileSync.updateFolder(folderId, { paused: false });
  }

  /** Rebuilds both indexes from the selected source; Retry repeats the whole copy. */
  async forceCopy(
    run: RemoteOperationStepRun,
    projectId: string,
    source: 'home' | 'vm',
    kinds: readonly ProjectFolder['kind'][],
  ): Promise<void> {
    const { remoteId, id: operationId } = run.operation;
    const folders = projectFolderList(projectId, kinds);
    const sender: Side = source === 'home' ? 'home' : 'host';
    const receiver: Side = sender === 'home' ? 'host' : 'home';
    const backups: ForceSyncDetails['backups'] = [];
    for (const folder of folders) {
      const request = { projectId, kind: folder.kind, forceCopy: { operationId } };
      const { path } =
        receiver === 'home'
          ? await this.fileSync.forceCopyBackup(request)
          : await this.host.syncForceCopyBackup(remoteId, request);
      backups.push({ side: receiver === 'home' ? 'home' : 'vm', kind: folder.kind, path });
    }
    await this.forceProgress(run, { backups, verified: false });
    await this.guard.remove(projectId, { refreshIndex: false });
    await this.host.removeGitGuard(remoteId, projectId);
    for (const folder of folders) {
      for (const side of ['home', 'host'] as const) {
        try {
          if (side === 'home') await this.fileSync.removeFolder(folder.id);
          else await this.host.syncRemoveFolder(remoteId, folder.id);
        } catch (error) {
          if (
            !(
              (error instanceof SyncthingRestError || error instanceof RemoteHostRequestError) &&
              error.status === 404
            )
          )
            throw error;
        }
      }
    }
    const devices = await this.pair(remoteId);
    const ignores = this.syncIgnores(projectId);
    for (const folder of folders) {
      const request = {
        projectId,
        kind: folder.kind,
        ignores: folder.kind === 'code' ? ignores : gitIgnores(false),
        paused: true,
      };
      await this.fileSync.ensureFolder({
        ...request,
        type: sender === 'home' ? 'sendonly' : 'receiveonly',
        peerDeviceId: devices.host,
        ...(receiver === 'home' && { forceCopy: { operationId } }),
      });
      await this.host.syncFolders(remoteId, {
        ...request,
        type: sender === 'host' ? 'sendonly' : 'receiveonly',
        peerDeviceId: devices.home,
        ...(receiver === 'host' && { forceCopy: { operationId } }),
      });
    }
    await this.unpauseAll(remoteId, folders);
    for (const folder of folders) {
      await Promise.all([
        this.scan(sender, remoteId, folder.id),
        this.scan(receiver, remoteId, folder.id),
      ]);
    }
    for (const folder of folders) {
      await this.waitBarrier(remoteId, folder.id, sender);
      if (sender === 'home') await this.fileSync.override(folder.id);
      else await this.host.syncOverride(remoteId, folder.id);
    }
    const replaced = { count: 0, sample: [] as string[] };
    for (const folder of folders) {
      const changed =
        receiver === 'home'
          ? await this.fileSync.localChanges(folder.id)
          : await this.host.syncLocalChanges(remoteId, folder.id);
      replaced.count += changed.count;
      replaced.sample.push(
        ...changed.sample
          .slice(0, RECEIVE_ONLY_SAMPLE_MAX - replaced.sample.length)
          .map((name) => (folder.kind === 'git' ? `.git/${name}` : name)),
      );
    }
    // A Retry sees only what earlier attempts did not revert, and a replay sees the same
    // files again: keep the larger count, so earlier evidence stays and nothing counts twice.
    const earlier = this.forceDetails(run).replaced as ForceSyncDetails['replaced'];
    if (earlier) {
      replaced.count = Math.max(replaced.count, earlier.count);
      replaced.sample = [...new Set([...earlier.sample, ...replaced.sample])].slice(
        0,
        RECEIVE_ONLY_SAMPLE_MAX,
      );
    }
    await this.forceProgress(run, { replaced });
    let waitError: unknown;
    try {
      await this.waitAll(run, folders, {
        sender,
        devices,
        symmetricCode: false,
        requireNoReceiveOnlyChanges: true,
      });
    } catch (error) {
      waitError = error;
    }
    await this.verifyForceCopy(remoteId, folders, sender, devices);
    if (waitError) throw waitError;
    await this.forceProgress(run, { verified: true });
  }

  /** Restores complete connected records, including any missing after a restart. */
  async restoreConnected(
    run: RemoteOperationStepRun,
    projectId: string,
    kinds: readonly ProjectFolder['kind'][],
  ): Promise<void> {
    if (this.forceDetails(run).verified !== true)
      throw new AppError('Force sync has not verified the copy.', 'FORCE_SYNC_NOT_VERIFIED', 409);
    const { remoteId } = run.operation;
    const owner = this.gitOwner.get(projectId);
    const devices = await this.pair(remoteId);
    const folders = projectFolderList(projectId, kinds);
    const ignores = this.syncIgnores(projectId);
    for (const folder of folders) {
      const request = {
        projectId,
        kind: folder.kind,
        ignores: folder.kind === 'code' ? ignores : gitIgnores(true),
        paused: true,
      };
      const ensureHome = () =>
        this.fileSync.ensureFolder({
          ...request,
          type:
            folder.kind === 'code' ? 'sendreceive' : owner === 'home' ? 'sendonly' : 'receiveonly',
          peerDeviceId: devices.host,
        });
      const ensureHost = () =>
        this.host.syncFolders(remoteId, {
          ...request,
          type:
            folder.kind === 'code' ? 'sendreceive' : owner === 'vm' ? 'sendonly' : 'receiveonly',
          peerDeviceId: devices.home,
        });
      if (folder.kind === 'git' && owner === 'home') {
        await ensureHost();
        await ensureHome();
      } else {
        await ensureHome();
        await ensureHost();
      }
    }
    await this.unpauseAll(remoteId, folders);
    if (kinds.includes('git')) {
      if (owner === 'vm') {
        const guardWarning = await this.guard.install(projectId, remoteId);
        if (guardWarning) await run.progress({ guardWarning });
      } else {
        const { warning } = await this.host.installGitGuard(remoteId, projectId, {
          homeName: hostname(),
          reason: 'pc-git',
        });
        await run.progress({ vmGuardWarning: warning });
      }
    }
  }

  private forceDetails(run: RemoteOperationStepRun): Record<string, unknown> {
    const value = run.details.forceSync;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private forceProgress(
    run: RemoteOperationStepRun,
    patch: Partial<ForceSyncDetails>,
  ): Promise<void> {
    return run.progress({ forceSync: { ...this.forceDetails(run), ...patch } }, { durable: true });
  }

  private async waitBarrier(remoteId: string, folderId: string, sender: Side): Promise<void> {
    const receiver = sender === 'home' ? 'host' : 'home';
    const deadline = Date.now() + SYNC_TIMEOUT_MS;
    for (;;) {
      const [source, target] = await Promise.all([
        this.status(sender, remoteId, folderId),
        this.status(receiver, remoteId, folderId),
      ]);
      if (senderIndexReached(source, target)) return;
      if (Date.now() >= deadline)
        throw new FileSyncTimeoutError(
          folderId,
          null,
          'The source index did not reach the receiver.',
        );
      await sleep(POLL_MS);
    }
  }

  private async verifyForceCopy(
    remoteId: string,
    folders: ProjectFolder[],
    sender: Side,
    devices: { home: string; host: string },
  ): Promise<void> {
    const receiver: Side = sender === 'home' ? 'host' : 'home';
    const problems: string[] = [];
    const failedFiles: string[] = [];
    for (const folder of folders) {
      const [source, target] = await Promise.all([
        this.status(sender, remoteId, folder.id, devices[receiver], { allErrors: true }),
        this.status(receiver, remoteId, folder.id, undefined, { allErrors: true }),
      ]);
      const targetErrors = forceErrors(target);
      failedFiles.push(
        ...targetErrors.failures
          .slice(0, 3 - failedFiles.length)
          .map((file) => `${folder.id}/${file.path}: ${file.error}`),
      );
      if (
        !evaluateCompletion(source, target).done ||
        target.receiveOnlyChangedFiles !== 0 ||
        forceErrors(source).failed ||
        targetErrors.failed
      ) {
        const reason =
          target.error ||
          source.error ||
          'The copies are not in sync or still have receive-only changes.';
        problems.push(`${folder.id}: ${reason}`);
      }
    }
    if (problems.length)
      throw new AppError(
        `Force sync failed: ${[...problems, ...failedFiles].join('; ')}`,
        'FORCE_SYNC_INCOMPLETE',
        500,
      );
  }

  /** Disconnect preserves both code copies; only receive-only git changes may be reverted. */
  async final(run: RemoteOperationStepRun, projectId: string): Promise<void> {
    const { remoteId } = run.operation;
    const owner = this.gitOwner.get(projectId);
    const ignores = this.syncIgnores(projectId);
    const devices = await this.pair(remoteId);
    const folders = await this.fileSync.projectFolders(projectId);
    // Recorded before any folder is paused, so a cancel knows to unpause them.
    await run.progress({ fileSyncPaused: true });
    for (const folder of folders) {
      const request = {
        projectId,
        kind: folder.kind,
        ignores: folder.kind === 'code' ? ignores : gitIgnores(true),
        paused: true,
      };
      const ensureHost = () =>
        this.host.syncFolders(remoteId, {
          ...request,
          type:
            folder.kind === 'code' ? 'sendreceive' : owner === 'vm' ? 'sendonly' : 'receiveonly',
          peerDeviceId: devices.home,
        });
      const ensureHome = () =>
        this.fileSync.ensureFolder({
          ...request,
          type:
            folder.kind === 'code' ? 'sendreceive' : owner === 'home' ? 'sendonly' : 'receiveonly',
          peerDeviceId: devices.host,
        });
      if (folder.kind === 'git' && owner === 'vm') {
        await ensureHome();
        await ensureHost();
      } else {
        await ensureHost();
        await ensureHome();
      }
    }
    await this.unpauseAll(remoteId, folders);
    await this.waitAll(run, folders, {
      sender: (folder) => (folder.kind === 'git' && owner === 'home' ? 'home' : 'host'),
      devices,
      symmetricCode: true,
    });
  }

  /**
   * Disconnect: home becomes the writer, then both sides pause. A forced
   * disconnect cannot reach the remote and changes home only; the next
   * connect replaces the remote's folder configuration.
   */
  async flipToHome(run: RemoteOperationStepRun, projectId: string, force: boolean): Promise<void> {
    const { remoteId } = run.operation;
    for (const folder of await this.fileSync.projectFolders(projectId)) {
      if (!force) {
        await this.update('host', remoteId, folder.id, { type: 'receiveonly', paused: true });
      }
      await this.update('home', remoteId, folder.id, { type: 'sendonly', paused: true });
    }
    if (force) {
      await run.progress({
        vmGuardSkipped: 'VM guard skipped: the forced Disconnect cannot reach the VM.',
      });
    } else {
      // A lost answer, a partial hook write or a restart before the step ends still requires cleanup on cancel.
      await run.progress({ vmGuardInstalled: true }, { durable: true });
      const { warning } = await this.host.installGitGuard(remoteId, projectId, {
        homeName: hostname(),
        reason: 'disconnect',
      });
      await run.progress({ vmGuardWarning: warning, vmGuardInstalled: warning === null });
    }
    await this.deleteHomeTempFiles(projectId);
    const { warning } = await this.guard.remove(projectId, {
      refreshIndex: this.gitOwner.get(projectId) === 'vm',
    });
    if (warning) await run.progress({ guardWarning: warning });
  }

  /**
   * Cancelled connect: stops sharing every folder on both sides; files stay.
   * Returns why the remote's folders could not be removed, if they could not.
   */
  async removeFolders(remoteId: string, projectId: string): Promise<string | null> {
    const folders = projectFolderList(projectId);
    // The VM never owned git before bind_remote, so home's index is still its own.
    await this.guard.remove(projectId, { refreshIndex: false });
    for (const folder of folders) {
      await this.fileSync.removeFolder(folder.id);
    }
    try {
      for (const folder of folders) {
        await this.host.syncRemoveFolder(remoteId, folder.id);
      }
      return null;
    } catch (error) {
      logger.warn({ remoteId, projectId }, 'Remote file sync folders were not removed');
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Cancelled disconnect restores the connected layout and its ownership guard. */
  async flipBackToHost(remoteId: string, projectId: string, force: boolean): Promise<void> {
    const owner = this.gitOwner.get(projectId);
    const folders = await this.fileSync.projectFolders(projectId);
    await this.hostDirections(remoteId, folders, owner, force, false);
    if (folders.some((folder) => folder.kind === 'git')) {
      const guardWarning =
        owner === 'vm'
          ? await this.guard.reinstall(projectId, remoteId)
          : force
            ? null
            : (
                await this.host.installGitGuard(remoteId, projectId, {
                  homeName: hostname(),
                  reason: 'pc-git',
                })
              ).warning;
      if (guardWarning) {
        logger.warn({ projectId, remoteId, guardWarning }, 'Remote git guard not reinstalled');
      }
    }
  }

  private async hostDirections(
    remoteId: string,
    folders: ProjectFolder[],
    owner: GitOwner,
    force: boolean,
    paused?: boolean,
  ): Promise<void> {
    for (const folder of folders) {
      const pause = paused === undefined ? {} : { paused };
      if (folder.kind === 'git') {
        const ignores = gitIgnores(true);
        const receiver = owner === 'vm' ? 'home' : 'host';
        const sender = owner === 'vm' ? 'host' : 'home';
        if (receiver === 'home' || !force)
          await this.update(receiver, remoteId, folder.id, {
            type: 'receiveonly',
            ignores,
            ...pause,
          });
        if (sender === 'home' || !force)
          await this.update(sender, remoteId, folder.id, { type: 'sendonly', ignores, ...pause });
      } else {
        if (!force)
          await this.update('host', remoteId, folder.id, { type: 'sendreceive', ...pause });
        await this.update('home', remoteId, folder.id, { type: 'sendreceive', ...pause });
      }
    }
  }

  async forcedLoss(projectId: string): Promise<FileSyncLoss> {
    const folders = await this.fileSync.projectNeed(projectId);
    return folders ? { folders } : 'unknown';
  }

  private syncIgnores(projectId: string): string[] {
    return codeIgnores(this.managedExclusions.get(projectId), this.fileSync.getIgnores(projectId));
  }

  /** Deletes leftover Syncthing temp files at home. Best effort; never blocks the flip. */
  private async deleteHomeTempFiles(projectId: string): Promise<void> {
    try {
      await deleteSyncthingTempFiles(
        await this.fileSync.folderPath(projectId),
        this.syncIgnores(projectId),
      );
    } catch (error) {
      logger.warn(
        { projectId, error: error instanceof Error ? error.message : String(error) },
        'Syncthing temp-file cleanup skipped',
      );
    }
  }

  /** Makes each side trust the other and waits until they are connected. */
  private async pair(
    remoteId: string,
    signal?: AbortSignal,
  ): Promise<{ home: string; host: string }> {
    const home = this.fileSync.device();
    const host = await this.host.syncDevice(remoteId);
    await this.fileSync.addPeer(host);
    await this.host.syncPeer(remoteId, home);
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (!(await this.fileSync.isConnected(host.deviceId))) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new FileSyncNotConnectedError(host.address);
      await sleep(POLL_MS);
    }
    return { home: home.deviceId, host: host.deviceId };
  }

  /** Starts both sides of every folder; each side already has its type. */
  private async unpauseAll(remoteId: string, folders: ProjectFolder[]): Promise<void> {
    for (const folder of folders) {
      await this.update('host', remoteId, folder.id, { paused: false });
      await this.update('home', remoteId, folder.id, { paused: false });
    }
  }

  private async waitHostIdle(
    remoteId: string,
    folderId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + SYNC_TIMEOUT_MS;
    for (;;) {
      signal.throwIfAborted();
      const status = await this.host.syncStatus(remoteId, folderId);
      signal.throwIfAborted();
      if (status.error || status.errors)
        throw new FileSyncTimeoutError(folderId, null, status.error ?? 'VM scan failed');
      if (status.state === 'idle') return;
      if (Date.now() >= deadline)
        throw new FileSyncTimeoutError(folderId, null, 'The VM scan did not become idle.');
      await sleep(POLL_MS);
    }
  }

  private async waitAll(
    run: RemoteOperationStepRun,
    folders: ProjectFolder[],
    options: {
      sender: Side | ((folder: ProjectFolder) => Side);
      devices: { home: string; host: string };
      symmetricCode?: boolean;
      requireNoReceiveOnlyChanges?: boolean;
      revertAfterComplete?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const { remoteId } = run.operation;
    const progress: Record<string, SyncProgress> = {};
    const report = () => run.progress({ fileSync: { folders: { ...progress } } });
    for (const folder of folders) {
      progress[folder.id] = { completion: 0, needItems: 0, needBytes: 0 };
    }
    await report();
    // One failed folder stops the others, and the wait returns only after every folder
    // stopped: a Revert must never run after the caller has failed the step.
    const stop = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
    await Promise.allSettled(
      folders.map(async (folder) => {
        try {
          const sender =
            typeof options.sender === 'function' ? options.sender(folder) : options.sender;
          const receiver: Side = sender === 'home' ? 'host' : 'home';
          const receiverDevice = options.devices[receiver];
          const symmetric = options.symmetricCode === true && folder.kind === 'code';
          await Promise.all([
            this.scan(sender, remoteId, folder.id, options.signal),
            ...(symmetric ? [this.scan(receiver, remoteId, folder.id)] : []),
          ]);
          progress[folder.id] = await this.fileSync.waitForComplete(folder.id, {
            symmetric,
            requireNoReceiveOnlyChanges: options.requireNoReceiveOnlyChanges,
            sender: () => this.status(sender, remoteId, folder.id, receiverDevice),
            receiver: async () => {
              const status = await this.status(
                receiver,
                remoteId,
                folder.id,
                symmetric ? options.devices[sender] : undefined,
              );
              if (!symmetric && status.receiveOnlyChangedFiles > 0) {
                signal.throwIfAborted();
                const source = await this.status(
                  sender,
                  remoteId,
                  folder.id,
                  options.revertAfterComplete ? receiverDevice : undefined,
                );
                signal.throwIfAborted();
                // Reverting before the source index arrives would delete every local file.
                // Receiver-only additions do not count against the owner's advertised transfer.
                const transferred =
                  senderIndexReached(source, status) &&
                  source.peer?.completion === 100 &&
                  source.peer.needItems === 0 &&
                  source.peer.remoteState === 'valid' &&
                  status.needTotalItems === 0;
                if (options.revertAfterComplete ? transferred : senderIndexReached(source, status))
                  await this.revert(receiver, remoteId, folder.id);
              }
              return status;
            },
            timeoutMs: SYNC_TIMEOUT_MS,
            sides: { sender: SIDE_NAMES[sender], receiver: SIDE_NAMES[receiver] },
            onProgress: (current) => {
              progress[folder.id] = current;
              void report();
            },
            signal,
          });
        } catch (error) {
          stop.abort(error);
          throw error;
        }
      }),
    );
    if (stop.signal.aborted) throw stop.signal.reason;
    await report();
  }

  private async update(
    side: Side,
    remoteId: string,
    folderId: string,
    patch: SyncFolderPatch,
  ): Promise<void> {
    try {
      if (side === 'home') await this.fileSync.updateFolder(folderId, patch);
      else await this.host.syncFolderType(remoteId, folderId, patch);
    } catch (error) {
      if (
        (error instanceof SyncthingRestError || error instanceof RemoteHostRequestError) &&
        error.status === 404
      )
        return;
      throw error;
    }
  }

  private status(
    side: Side,
    remoteId: string,
    folderId: string,
    peerDeviceId?: string,
    options?: SyncStatusOptions,
  ): Promise<FolderSyncStatus> {
    if (options)
      return side === 'home'
        ? this.fileSync.status(folderId, peerDeviceId, options)
        : this.host.syncStatus(remoteId, folderId, peerDeviceId, options);
    return side === 'home'
      ? this.fileSync.status(folderId, peerDeviceId)
      : this.host.syncStatus(remoteId, folderId, peerDeviceId);
  }

  /** Only the home scan takes a cancel signal; the host side scans through the host routes. */
  private scan(
    side: Side,
    remoteId: string,
    folderId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return side === 'home'
      ? this.fileSync.rescan(folderId, signal)
      : this.host.syncScan(remoteId, folderId);
  }

  private revert(side: Side, remoteId: string, folderId: string): Promise<void> {
    return side === 'home'
      ? this.fileSync.revertLocalChanges(folderId)
      : this.host.syncRevert(remoteId, folderId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
