import { Inject, Injectable } from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { failedCount, type FolderSyncStatus } from '../../file-sync/file-sync.dto';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { shareFolderId } from '../../file-sync/share-paths';
import { SyncthingRestError } from '../../file-sync/syncthing-rest.client';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { RemoteHostClient, RemoteHostRequestError } from '../operations/remote-host.client';
import { RemoteOperationsService } from '../operations/remote-operations.service';
import {
  assertNoOpenShareOperation,
  listOpenShareOperations,
} from '../operations/share-operation-lock';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import {
  SHARED_FOLDER_MISSING,
  SHARED_FOLDER_PATTERNS_NOT_APPLIED,
  type SharedFolderDto,
  type SharedFolderEntry,
  type SharedFolderState,
  type StopSharingResult,
} from './shared-folders.dto';
import { SharedFoldersStore } from './shared-folders.store';

const logger = createLogger('SharedFoldersService');

/** This PC's management of user folders shared with a VM; the copy itself is `share_folder`. */
@Injectable()
export class SharedFoldersService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly store: SharedFoldersStore,
    private readonly files: FileSyncService,
    private readonly host: RemoteHostClient,
    private readonly operations: RemoteOperationsService,
  ) {}

  /** Adds the entry and starts the operation that copies the folder to the VM. */
  async share(remoteId: string, path: string, ignores: string[]): Promise<RemoteOperation> {
    await this.storage.getRemote(remoteId);
    // Store and share the path as written, not with links resolved: on a PC whose home is a link
    // (`/home/u` → `/data/u`) the resolved path is outside `homedir()` and differs from the VM's
    // path. Links below home are refused, so the two can differ only in the home prefix.
    const absolute = resolve(path);
    await this.files.assertSharePath(absolute, this.store.sharedPaths());
    const info = await stat(absolute).catch(() => null);
    if (!info?.isDirectory())
      throw new AppError(
        `Cannot share ${absolute}: the folder does not exist on this PC.`,
        SHARED_FOLDER_MISSING,
        404,
        { path: absolute },
      );
    // The checks above wait on the disk; `add` checks again for overlaps without waiting, so
    // a double submit or two overlapping paths cannot both get an entry.
    const entry = this.store.add(remoteId, absolute, ignores);
    try {
      return await this.operations.shareFolder(remoteId, {
        path: entry.path,
        ignores: entry.ignores,
      });
    } catch (error) {
      this.store.removeById(remoteId, entry.id);
      throw error;
    }
  }

  async list(remoteId: string): Promise<SharedFolderDto[]> {
    await this.storage.getRemote(remoteId);
    const entries = this.store.list(remoteId);
    if (entries.length === 0) return [];
    const open = await this.openOperations(remoteId);
    const online = this.health.getState(remoteId).online;
    return Promise.all(
      entries.map(async (entry) => ({
        ...entry,
        state: await this.state(entry, open, online),
      })),
    );
  }

  /** Stops sharing on the VM, then here, then forgets the entry. Files stay on both sides. */
  async stop(remoteId: string, id: string): Promise<StopSharingResult> {
    const entry = this.store.get(remoteId, id);
    await assertNoOpenShareOperation(this.storage, remoteId, entry.id);
    const folderId = shareFolderId(entry.path);
    let vmRemoved = true;
    try {
      await this.host.syncRemoveFolder(remoteId, folderId);
    } catch (error) {
      if (!noAnswer(error)) throw error;
      logger.warn({ remoteId, folderId }, 'The VM did not answer; stopping the share on this PC');
      vmRemoved = false;
    }
    await this.files.removeFolder(folderId);
    this.store.removeById(remoteId, id);
    return {
      vmRemoved,
      message: vmRemoved
        ? `Stopped sharing ${entry.path}. The files stay on this PC and the VM.`
        : `Stopped sharing ${entry.path} on this PC. The VM did not answer, so it may still list the folder. The files stay on both sides.`,
    };
  }

  /**
   * Stores the patterns, then installs them on the VM and here. A failed side keeps the stored
   * list with `patternsApplied: false`; saving again retries both sides.
   */
  async updateIgnores(remoteId: string, id: string, ignores: string[]): Promise<SharedFolderEntry> {
    const entry = this.store.get(remoteId, id);
    await assertNoOpenShareOperation(this.storage, remoteId, entry.id);
    this.store.update(remoteId, id, { ignores, patternsApplied: false });
    const folderId = shareFolderId(entry.path);
    let side = 'the VM';
    try {
      await this.host.syncShareIgnores(remoteId, folderId, ignores);
      side = 'this PC';
      await this.files.updateFolder(folderId, { ignores });
    } catch (error) {
      logger.warn({ error, remoteId, folderId }, 'Shared folder patterns were not applied');
      throw new AppError(
        `Saved, but ${side} could not apply the patterns. Save again to retry.`,
        SHARED_FOLDER_PATTERNS_NOT_APPLIED,
        503,
        { side: side === 'the VM' ? 'vm' : 'home', retryable: true },
      );
    }
    return this.store.update(remoteId, id, { patternsApplied: true });
  }

  /** The newest running or failed `share_folder` operation of each share id. */
  private async openOperations(remoteId: string): Promise<Map<string, RemoteOperation>> {
    const operations = await listOpenShareOperations(this.storage, remoteId);
    const byShare = new Map<string, RemoteOperation>();
    for (const operation of operations) {
      const id = operation.details.shareId;
      if (typeof id === 'string' && !byShare.has(id)) byShare.set(id, operation);
    }
    return byShare;
  }

  private async state(
    entry: SharedFolderEntry,
    open: Map<string, RemoteOperation>,
    online: boolean,
  ): Promise<SharedFolderState> {
    const operation = open.get(entry.id);
    if (operation?.state === 'running') return { kind: 'sharing', operationId: operation.id };
    if (operation)
      return {
        kind: 'failed',
        operationId: operation.id,
        message: operation.steps.find((step) => step.error)?.error?.message ?? null,
      };
    if (!online) return { kind: 'vm-offline' };
    const folderId = shareFolderId(entry.path);
    // The two reads do not depend on each other; the VM's result is judged first.
    const [vm, home] = await Promise.allSettled([
      this.host.syncStatus(entry.remoteId, folderId),
      this.files.status(folderId),
    ]);
    if (vm.status === 'rejected') {
      const error: unknown = vm.reason;
      if (error instanceof RemoteHostRequestError && error.status === 404)
        return { kind: 'not-on-vm' };
      if (noAnswer(error)) return { kind: 'vm-offline' };
      return { kind: 'error', message: errorMessage(error) };
    }
    if (home.status === 'rejected') {
      const error: unknown = home.reason;
      if (error instanceof SyncthingRestError && error.status === 404)
        return { kind: 'error', message: 'The folder is not shared on this PC.' };
      return { kind: 'error', message: errorMessage(error) };
    }
    return folderState(home.value, vm.value);
  }
}

/** Errors first, then failed files, then pending items. */
export function folderState(home: FolderSyncStatus, vm: FolderSyncStatus): SharedFolderState {
  const folderError = [
    home.error && `This PC: ${home.error}`,
    vm.error && `VM: ${vm.error}`,
  ].filter(Boolean);
  if (folderError.length) return { kind: 'error', message: folderError.join('; ') };
  const failedFiles = failedCount(home) + failedCount(vm);
  if (failedFiles > 0) return { kind: 'failing', failedFiles };
  const needItems = home.needTotalItems + vm.needTotalItems;
  if (needItems > 0) return { kind: 'syncing', needItems };
  return { kind: 'in-sync' };
}

/** The VM did not answer at all, as opposed to answering with an error. */
function noAnswer(error: unknown): boolean {
  return error instanceof RemoteHostRequestError && error.status === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
