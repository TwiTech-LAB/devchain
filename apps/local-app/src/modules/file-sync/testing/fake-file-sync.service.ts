import { randomBytes } from 'crypto';
import { AppError } from '../../../common/errors/error-types';
import { join } from 'path';
import type {
  FolderSyncStatus,
  RemoteNeed,
  ConflictReport,
  ConflictBaseline,
  FolderType,
  SyncDevice,
  SyncFolder,
  SyncFolderPatch,
  SyncFolderRequest,
  ForceCopyBackupRequest,
  ForceCopyBackup,
  ReceiveOnlyChanges,
  SyncStatusOptions,
} from '../file-sync.dto';
import { FILE_SYNC_IGNORES_CHANGED } from '../file-sync.dto';
import {
  FileSyncService,
  projectFolderId,
  projectFolderList,
  type FolderNeed,
  type ProjectFolder,
  type SyncProgress,
  type WaitForCompleteOptions,
} from '../file-sync.service';
import { SyncthingRestError } from '../syncthing-rest.client';
import { DEFAULT_FILE_SYNC_IGNORES } from '../file-sync-ignores.store';
import { captureFileSyncConflictBaseline, scanFileSyncConflicts } from '../file-sync-conflicts';

export interface FakeFolder {
  type: FolderType;
  paused: boolean;
  peerDeviceId: string;
  ignores: string[];
  backupPath?: string;
}

/**
 * An in-memory `FileSyncService` for apps booted in tests: folders are
 * records, every folder is always in sync, and each instance has its own
 * device id. Tests read `folders` to assert direction and pause state.
 */
export class FakeFileSyncService
  implements
    Pick<
      FileSyncService,
      | 'device'
      | 'addPeer'
      | 'isConnected'
      | 'getIgnores'
      | 'getIgnoresRevision'
      | 'setIgnores'
      | 'projectFolders'
      | 'initialFolders'
      | 'projectNeed'
      | 'ensureFolder'
      | 'forceCopyBackup'
      | 'localChanges'
      | 'override'
      | 'updateFolder'
      | 'setFolderType'
      | 'folderConfiguration'
      | 'folderPath'
      | 'removeFolder'
      | 'status'
      | 'remoteNeed'
      | 'conflicts'
      | 'conflictBaseline'
      | 'rescan'
      | 'revertLocalChanges'
      | 'waitForComplete'
    >
{
  readonly deviceId = Array.from({ length: 8 }, () =>
    randomBytes(7)
      .toString('base64')
      .toUpperCase()
      .replace(/[^A-Z2-7]/g, 'A')
      .slice(0, 7)
      .padEnd(7, 'A'),
  ).join('-');
  readonly peers = new Set<string>();
  readonly gitProjects = new Set<string>();
  readonly folders = new Map<string, FakeFolder>();
  /** Per folder, what `status` reports this side still needs. */
  readonly need = new Map<string, { needItems: number; needBytes: number }>();
  readonly remoteNeeds = new Map<string, RemoteNeed>();
  readonly receiveOnlyChanges = new Map<string, ReceiveOnlyChanges>();
  /** Where `folderPath` answers; tests point it at real directories. */
  readonly codeRoots = new Map<string, string>();
  private readonly ignores = new Map<string, string[]>();
  private readonly revisions = new Map<string, number>();

  async ensureAvailable(): Promise<void> {}

  device(): SyncDevice {
    return { deviceId: this.deviceId, address: 'tcp://127.0.0.1:22000' };
  }

  async addPeer(peer: SyncDevice): Promise<void> {
    this.peers.add(peer.deviceId);
  }

  async isConnected(deviceId: string): Promise<boolean> {
    return this.peers.has(deviceId);
  }

  getIgnores(projectId: string): string[] {
    return this.ignores.get(projectId) ?? [...DEFAULT_FILE_SYNC_IGNORES];
  }

  getIgnoresRevision(projectId: string): number {
    return this.revisions.get(projectId) ?? 0;
  }

  setIgnores(projectId: string, ignores: string[] | null, revision?: number): string[] {
    const current = this.getIgnoresRevision(projectId);
    if (revision !== undefined && revision !== current)
      throw new AppError('The file list changed. Review it again.', FILE_SYNC_IGNORES_CHANGED, 409);
    this.revisions.set(projectId, current + 1);
    if (ignores === null) this.ignores.delete(projectId);
    else this.ignores.set(projectId, ignores);
    return this.getIgnores(projectId);
  }

  async projectFolders(projectId: string): Promise<ProjectFolder[]> {
    return projectFolderList(projectId).filter((folder) => this.folders.has(folder.id));
  }

  async initialFolders(projectId: string): Promise<ProjectFolder[]> {
    return projectFolderList(
      projectId,
      this.gitProjects.has(projectId) ? ['code', 'git'] : ['code'],
    );
  }

  async projectNeed(projectId: string): Promise<FolderNeed[] | null> {
    return (await this.projectFolders(projectId)).map((folder) => ({
      id: folder.id,
      ...(this.need.get(folder.id) ?? zeroNeed()),
    }));
  }

  async ensureFolder(request: SyncFolderRequest): Promise<SyncFolder> {
    const id = projectFolderId(request.projectId, request.kind);
    const paused = request.paused ?? false;
    const backupPath = request.forceCopy
      ? (
          await this.forceCopyBackup({
            projectId: request.projectId,
            kind: request.kind,
            forceCopy: request.forceCopy,
          })
        ).path
      : undefined;
    this.folders.set(id, {
      type: request.type,
      paused,
      peerDeviceId: request.peerDeviceId,
      ignores: request.ignores,
      ...(backupPath && { backupPath }),
    });
    return {
      id,
      path: `/fake/${id}`,
      type: request.type,
      paused,
      ...(backupPath && { backupPath }),
    };
  }

  async forceCopyBackup(request: ForceCopyBackupRequest): Promise<ForceCopyBackup> {
    return {
      path: `/fake/sync-backups/${request.projectId}/${request.forceCopy.operationId}/${request.kind}`,
    };
  }

  async updateFolder(folderId: string, patch: SyncFolderPatch): Promise<void> {
    const folder = this.require(folderId);
    this.folders.set(folderId, { ...folder, ...patch });
  }

  async folderConfiguration(folderId: string) {
    const folder = this.require(folderId);
    return {
      type: folder.type,
      paused: folder.paused,
      devices: [{ deviceID: this.deviceId }, { deviceID: folder.peerDeviceId }],
    };
  }

  async folderPath(projectId: string, kind: ProjectFolder['kind'] = 'code'): Promise<string> {
    const root = this.codeRoots.get(projectId) ?? `/fake/${projectId}`;
    return kind === 'git' ? join(root, '.git') : root;
  }

  async setFolderType(folderId: string, type: FolderType): Promise<void> {
    await this.updateFolder(folderId, { type });
  }

  async removeFolder(folderId: string): Promise<void> {
    this.folders.delete(folderId);
  }

  async status(
    folderId: string,
    peerDeviceId?: string,
    _options?: SyncStatusOptions,
  ): Promise<FolderSyncStatus> {
    this.require(folderId);
    const need = this.need.get(folderId) ?? zeroNeed();
    return {
      folderId,
      state: 'idle',
      localFiles: 1,
      localDirectories: 1,
      globalFiles: 1,
      globalDirectories: 1,
      needTotalItems: need.needItems,
      needBytes: need.needBytes,
      receiveOnlyChangedFiles: this.receiveOnlyChanges.get(folderId)?.count ?? 0,
      peer: peerDeviceId
        ? {
            deviceId: peerDeviceId,
            completion: 100,
            needItems: 0,
            needBytes: 0,
            remoteState: 'valid',
          }
        : null,
    };
  }

  async rescan(folderId: string, signal?: AbortSignal): Promise<void> {
    this.require(folderId);
    signal?.throwIfAborted();
  }

  async remoteNeed(folderId: string, _peerDeviceId: string): Promise<RemoteNeed> {
    this.require(folderId);
    return structuredClone(
      this.remoteNeeds.get(folderId) ?? {
        total: 0,
        deleted: 0,
        sample: [],
        conflictPaths: [],
        conflictsOverCap: false,
      },
    );
  }

  async conflicts(
    projectId: string,
    baseline: ConflictBaseline,
    ignores: readonly string[],
    signal?: AbortSignal,
  ): Promise<ConflictReport> {
    const root = this.codeRoots.get(projectId);
    return root
      ? scanFileSyncConflicts(root, baseline, ignores, signal)
      : { total: 0, sample: [], ...(baseline.baselineOverCap && { baselineOverCap: true }) };
  }

  async conflictBaseline(
    projectId: string,
    ignores: readonly string[],
    signal?: AbortSignal,
  ): Promise<ConflictBaseline> {
    const root = this.codeRoots.get(projectId);
    return root
      ? captureFileSyncConflictBaseline(root, ignores, signal)
      : { baselineOverCap: false, paths: [] };
  }

  async revertLocalChanges(folderId: string): Promise<void> {
    this.require(folderId);
    this.receiveOnlyChanges.delete(folderId);
  }

  async localChanges(folderId: string): Promise<ReceiveOnlyChanges> {
    this.require(folderId);
    return structuredClone(this.receiveOnlyChanges.get(folderId) ?? { count: 0, sample: [] });
  }

  async override(folderId: string): Promise<void> {
    this.require(folderId);
  }

  waitForComplete(folderId: string, options: WaitForCompleteOptions): Promise<SyncProgress> {
    return FileSyncService.prototype.waitForComplete.call(this, folderId, {
      pollIntervalMs: 10,
      ...options,
    });
  }

  private require(folderId: string): FakeFolder {
    const folder = this.folders.get(folderId);
    if (!folder) {
      throw new SyncthingRestError(`Syncthing answered 404: no such folder ${folderId}`, {
        path: '/rest/db/status',
        status: 404,
      });
    }
    return folder;
  }
}

function zeroNeed(): { needItems: number; needBytes: number } {
  return { needItems: 0, needBytes: 0 };
}
