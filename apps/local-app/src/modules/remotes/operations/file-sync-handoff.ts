import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  codeIgnores,
  gitIgnores,
  type FolderSyncStatus,
  type SyncFolderPatch,
} from '../../file-sync/file-sync.dto';
import {
  FileSyncService,
  projectFolderList,
  type FolderNeed,
  type ProjectFolder,
  type SyncProgress,
} from '../../file-sync/file-sync.service';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { SyncthingRestError } from '../../file-sync/syncthing-rest.client';
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

/** Handoffs keep code two-way while the remote alone owns git metadata. */
@Injectable()
export class FileSyncHandoff {
  /**
   * One controller per running Connect, so a cancel ends its pairing wait,
   * home rescan and completion wait. A controller leaves the map only while it
   * is still the current one, so a superseded run cannot drop a newer one.
   */
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly fileSync: FileSyncService,
    private readonly host: RemoteHostClient,
    private readonly managedExclusions: FileSyncManagedExclusionsStore,
    private readonly guard: HomeGitGuardService,
  ) {}

  /** Cancel: ends a running Connect's initial sync with a short, plain reason. */
  interrupt(operationId: string): void {
    this.active.get(operationId)?.abort(new Error('The Connect was cancelled.'));
  }

  /**
   * Connect: shares every project folder from home to the remote and waits
   * until the remote holds exactly home's files. Receiver files home does not
   * have are reverted, since home is the owner.
   */
  async initial(run: RemoteOperationStepRun, projectId: string): Promise<void> {
    const controller = new AbortController();
    this.active.set(run.operation.id, controller);
    try {
      const { remoteId } = run.operation;
      const ignores = this.syncIgnores(projectId);
      const devices = await this.pair(remoteId, controller.signal);
      const folders = await this.fileSync.initialFolders(projectId);
      for (const folder of folders) {
        const request = {
          projectId,
          kind: folder.kind,
          ignores: folder.kind === 'code' ? ignores : gitIgnores(false),
          paused: true,
        };
        await this.fileSync.ensureFolder({
          ...request,
          type: 'sendonly',
          peerDeviceId: devices.host,
        });
        await this.host.syncFolders(remoteId, {
          ...request,
          type: 'receiveonly',
          peerDeviceId: devices.home,
        });
      }
      await this.unpauseAll(remoteId, folders);
      await this.waitAll(run, folders, { sender: 'home', devices, signal: controller.signal });
    } finally {
      if (this.active.get(run.operation.id) === controller) this.active.delete(run.operation.id);
    }
  }

  /** Connect's preflight: home's Syncthing must run before Connect changes anything. */
  async ensureAvailable(): Promise<void> {
    await this.fileSync.ensureAvailable();
  }

  /** Connect: keep code two-way, then switch git to remote ownership, receiver first. */
  async flipToHost(run: RemoteOperationStepRun, projectId: string): Promise<void> {
    const { remoteId } = run.operation;
    const folders = await this.fileSync.projectFolders(projectId);
    await this.hostDirections(remoteId, folders, false);
    if (folders.some((folder) => folder.kind === 'git')) {
      const guardWarning = await this.guard.install(projectId, remoteId);
      if (guardWarning) await run.progress({ guardWarning });
    }
  }

  /** Disconnect preserves both code copies; only receive-only git changes may be reverted. */
  async final(run: RemoteOperationStepRun, projectId: string): Promise<void> {
    const { remoteId } = run.operation;
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
      await this.host.syncFolders(remoteId, {
        ...request,
        type: folder.kind === 'code' ? 'sendreceive' : 'sendonly',
        peerDeviceId: devices.home,
      });
      await this.fileSync.ensureFolder({
        ...request,
        type: folder.kind === 'code' ? 'sendreceive' : 'receiveonly',
        peerDeviceId: devices.host,
      });
    }
    await this.unpauseAll(remoteId, folders);
    await this.waitAll(run, folders, { sender: 'host', devices, symmetricCode: true });
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
    await this.deleteHomeTempFiles(projectId);
    await this.guard.remove(projectId, { refreshIndex: true });
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
    const folders = await this.fileSync.projectFolders(projectId);
    await this.hostDirections(remoteId, folders, force, false);
    if (folders.some((folder) => folder.kind === 'git')) {
      const guardWarning = await this.guard.reinstall(projectId, remoteId);
      if (guardWarning) {
        logger.warn({ projectId, remoteId, guardWarning }, 'Remote git guard not reinstalled');
      }
    }
  }

  private async hostDirections(
    remoteId: string,
    folders: ProjectFolder[],
    force: boolean,
    paused?: boolean,
  ): Promise<void> {
    for (const folder of folders) {
      const pause = paused === undefined ? {} : { paused };
      if (folder.kind === 'git') {
        const ignores = gitIgnores(true);
        await this.update('home', remoteId, folder.id, { type: 'receiveonly', ignores, ...pause });
        if (!force)
          await this.update('host', remoteId, folder.id, { type: 'sendonly', ignores, ...pause });
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

  private async waitAll(
    run: RemoteOperationStepRun,
    folders: ProjectFolder[],
    options: {
      sender: Side;
      devices: { home: string; host: string };
      symmetricCode?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const { remoteId } = run.operation;
    const receiver: Side = options.sender === 'home' ? 'host' : 'home';
    const receiverDevice = receiver === 'home' ? options.devices.home : options.devices.host;
    const progress: Record<string, SyncProgress> = {};
    const report = () => run.progress({ fileSync: { folders: { ...progress } } });
    for (const folder of folders) {
      progress[folder.id] = { completion: 0, needItems: 0, needBytes: 0 };
    }
    await report();
    await Promise.all(
      folders.map(async (folder) => {
        const symmetric = options.symmetricCode === true && folder.kind === 'code';
        await Promise.all([
          this.scan(options.sender, remoteId, folder.id, options.signal),
          ...(symmetric ? [this.scan(receiver, remoteId, folder.id)] : []),
        ]);
        progress[folder.id] = await this.fileSync.waitForComplete(folder.id, {
          symmetric,
          sender: () => this.status(options.sender, remoteId, folder.id, receiverDevice),
          receiver: async () => {
            const status = await this.status(
              receiver,
              remoteId,
              folder.id,
              symmetric ? options.devices[options.sender] : undefined,
            );
            if (!symmetric && status.receiveOnlyChangedFiles > 0 && status.state === 'idle') {
              await this.revert(receiver, remoteId, folder.id);
            }
            return status;
          },
          timeoutMs: SYNC_TIMEOUT_MS,
          onProgress: (current) => {
            progress[folder.id] = current;
            void report();
          },
          signal: options.signal,
        });
      }),
    );
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
  ): Promise<FolderSyncStatus> {
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
