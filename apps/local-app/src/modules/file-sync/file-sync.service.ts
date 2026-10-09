import { Inject, Injectable } from '@nestjs/common';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { z } from 'zod';
import { SYNCTHING_GIT_EXCLUDES } from '../../common/constants/syncthing-markers';
import { AppError } from '../../common/errors/error-types';
import { STORAGE_SERVICE, type ProjectStorage } from '../storage/interfaces/storage.interface';
import { FILE_SYNC_PATHS, assertShareableFolder, type FileSyncPaths } from './file-sync-paths';
import {
  SCAN_TIMEOUT_MS,
  FILE_SYNC_REPORT_SAMPLE,
  CONFLICT_BASELINE_MAX,
  ForceCopyBackupRequestSchema,
  RECEIVE_ONLY_SAMPLE_MAX,
  FolderSyncStatusSchema,
  SyncFolderConfigurationSchema,
  type FolderSyncStatus,
  type FolderType,
  type RemoteNeed,
  type ConflictReport,
  type ConflictBaseline,
  type SyncDevice,
  type SyncFolder,
  type SyncFolderPatch,
  type SyncFolderRequest,
  type SyncStatusOptions,
  type ForceCopyBackupRequest,
  type ForceCopyBackup,
  type ReceiveOnlyChanges,
} from './file-sync.dto';
import { projectRepository } from './project-repository';
import { FileSyncIgnoresStore } from './file-sync-ignores.store';
import { SyncthingManager } from './syncthing-manager.service';
import { SyncthingRestError, type SyncthingRestClient } from './syncthing-rest.client';
import { captureFileSyncConflictBaseline, scanFileSyncConflicts } from './file-sync-conflicts';

/**
 * Sent in every folder PATCH: Syncthing v1 resets an omitted `fsWatcherDelayS`
 * to 10 s, which would slow every change after a direction flip.
 */
export const FOLDER_WATCHER_DELAY_S = 1;
const RESCAN_INTERVAL_S = 3600;
const COMPLETION_POLL_MS = 500;
/** How many failed files a folder status names; `errors` counts all of them. */
const FILE_ERROR_SAMPLE = 3;
const REMOTE_NEED_PAGE_SIZE = 1000;
const RawRemoteNeedSchema = z.object({
  files: z.array(z.object({ name: z.string(), deleted: z.boolean(), type: z.string() })),
});

const RawStatusSchema = FolderSyncStatusSchema.omit({ folderId: true, peer: true });

const FolderErrorsSchema = z.object({
  errors: z.array(z.object({ path: z.string(), error: z.string() })).nullable(),
});

const RawCompletionSchema = z.object({
  completion: z.number(),
  needItems: z.number(),
  needBytes: z.number(),
  remoteState: z.string(),
});

const ConnectionsSchema = z.object({
  connections: z.record(z.object({ connected: z.boolean() })),
});

export interface ProjectFolder {
  id: string;
  kind: 'code' | 'git';
}

/** What one side still needs of a folder, from its own last known view. */
export interface FolderNeed {
  id: string;
  needItems: number;
  needBytes: number;
}

export interface SyncProgress {
  completion: number;
  needItems: number;
  needBytes: number;
}

export class FileSyncUnavailableError extends AppError {
  constructor(reason: string) {
    super(`File sync is unavailable: ${reason}`, 'FILE_SYNC_UNAVAILABLE', 503);
  }
}

export class FileSyncTimeoutError extends AppError {
  constructor(
    folderId: string,
    progress: SyncProgress | null,
    lastError: string | null,
    syncErrors: string[] = [],
  ) {
    const reasons = lastError ? [...syncErrors, lastError] : syncErrors;
    super(
      `Folder ${folderId} did not finish syncing in time${reasons.length ? `: ${reasons.join('; ')}` : ''}`,
      'FILE_SYNC_TIMEOUT',
      504,
      { folderId, progress, lastError, syncErrors },
    );
  }
}

/** Syncthing's own errors in one side's folder status, in words. */
function describeSyncErrors(status: FolderSyncStatus, side: string): string[] {
  const reasons = status.error ? [`${status.error} on ${side}`] : [];
  const failed = status.errors ?? 0;
  if (failed > 0) {
    const first = status.fileErrors?.[0];
    reasons.push(
      `${failed} ${failed === 1 ? 'file' : 'files'} failed to sync on ${side}` +
        (first ? `. First: ${first.path}: ${first.error}` : ''),
    );
  }
  return reasons;
}

export function codeFolderId(projectId: string): string {
  return projectFolderId(projectId, 'code');
}

export function projectFolderId(projectId: string, kind: ProjectFolder['kind']): string {
  return `${kind}:${projectId}`;
}

/** A project's folders of the given kinds, in handoff order. */
export function projectFolderList(
  projectId: string,
  kinds: readonly ProjectFolder['kind'][] = ['code', 'git'],
): ProjectFolder[] {
  return kinds.map((kind) => ({ id: projectFolderId(projectId, kind), kind }));
}

/**
 * Both sides are idle and the receiver's global index holds exactly the sender's files
 * and directories. Before this, a receive-only Revert would delete the receiver's files.
 */
export function senderIndexReached(sender: FolderSyncStatus, receiver: FolderSyncStatus): boolean {
  return (
    sender.state === 'idle' &&
    receiver.state === 'idle' &&
    receiver.globalFiles === sender.localFiles &&
    receiver.globalDirectories === sender.localDirectories
  );
}

/**
 * A folder is in sync when the sender sees the receiver's copy complete and
 * valid, both sides are idle, and the receiver holds exactly the sender's
 * files and directories. The sender's completion alone only reflects the
 * receiver index it has seen so far.
 */
export function evaluateCompletion(
  sender: FolderSyncStatus,
  receiver: FolderSyncStatus,
): { done: boolean; progress: SyncProgress } {
  const peer = sender.peer;
  const done =
    peer !== null &&
    peer.completion === 100 &&
    peer.needItems === 0 &&
    peer.remoteState === 'valid' &&
    senderIndexReached(sender, receiver) &&
    receiver.needTotalItems === 0 &&
    receiver.localFiles === sender.localFiles;
  return {
    done,
    progress: {
      completion: peer?.completion ?? 0,
      needItems: peer?.needItems ?? receiver.needTotalItems,
      needBytes: peer?.needBytes ?? receiver.needBytes,
    },
  };
}

/** Two-way folders must have exchanged both indexes after both sides have rescanned. */
export function evaluateSymmetricCompletion(home: FolderSyncStatus, host: FolderSyncStatus) {
  const forward = evaluateCompletion(home, host);
  const reverse = evaluateCompletion(host, home);
  return {
    done: forward.done && reverse.done,
    progress: {
      completion: Math.min(forward.progress.completion, reverse.progress.completion),
      needItems: home.needTotalItems + host.needTotalItems,
      needBytes: home.needBytes + host.needBytes,
    },
  };
}

export interface WaitForCompleteOptions {
  /** Status on the sending side, including its view of the receiver (`peer`). */
  sender: () => Promise<FolderSyncStatus>;
  receiver: () => Promise<FolderSyncStatus>;
  timeoutMs: number;
  onProgress?: (progress: SyncProgress) => void;
  pollIntervalMs?: number;
  symmetric?: boolean;
  /** Revert is asynchronous: wait for its receive-only index to clear as well. */
  requireNoReceiveOnlyChanges?: boolean;
  /** When it fires, the wait ends with the signal's reason instead of the timeout. */
  signal?: AbortSignal;
  /** Names the sides in the timeout message, for example "this PC" and "the VM". */
  sides?: { sender: string; receiver: string };
}

/**
 * Folder operations on this instance's Syncthing. Home runs them on its own
 * instance and, through the host routes, on the host's; the calls and their
 * order are the same on both sides.
 */
@Injectable()
export class FileSyncService {
  constructor(
    private readonly syncthing: SyncthingManager,
    @Inject(FILE_SYNC_PATHS) private readonly paths: FileSyncPaths,
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage,
    private readonly ignores: FileSyncIgnoresStore,
  ) {}

  /**
   * Starts Syncthing again if it is not running, so a binary installed after
   * boot is found without a restart. Throws, with the install guidance, when
   * it still cannot run.
   */
  async ensureAvailable(): Promise<void> {
    await this.syncthing.ensureRunning();
    this.connection();
  }

  device(): SyncDevice {
    const connection = this.connection();
    return { deviceId: connection.deviceId, address: connection.listenAddress };
  }

  /** Trusts the peer device and dials it at `address`; it may never share folders on its own. */
  async addPeer(peer: SyncDevice): Promise<void> {
    await this.client().request('PUT', `/rest/config/devices/${enc(peer.deviceId)}`, {
      deviceID: peer.deviceId,
      name: 'devchain-peer',
      addresses: [peer.address],
      autoAcceptFolders: false,
    });
  }

  async isConnected(deviceId: string): Promise<boolean> {
    const body = ConnectionsSchema.parse(
      await this.client().request('GET', '/rest/system/connections'),
    );
    return body.connections[deviceId]?.connected === true;
  }

  getIgnores(projectId: string): string[] {
    return this.ignores.get(projectId);
  }

  getIgnoresRevision(projectId: string): number {
    return this.ignores.revision(projectId);
  }

  setIgnores(projectId: string, ignores: string[] | null, revision?: number): string[] {
    return this.ignores.set(projectId, ignores, revision);
  }

  /** The configured layout survives restarts and does not assume a nested git share exists. */
  async projectFolders(projectId: string): Promise<ProjectFolder[]> {
    const configured = z
      .array(z.object({ id: z.string() }))
      .parse(await this.client().request('GET', '/rest/config/folders'));
    const ids = new Set(configured.map((folder) => folder.id));
    return projectFolderList(projectId).filter((folder) => ids.has(folder.id));
  }

  /** New shares follow the home checkout; a worktree's .git file is not a git folder. */
  async initialFolders(projectId: string): Promise<ProjectFolder[]> {
    const root = await this.folderPath(projectId);
    const repository = await projectRepository(root);
    return projectFolderList(projectId, repository === 'repository' ? ['code', 'git'] : ['code']);
  }

  /**
   * What this side still needs of each of the project's folders, as its
   * Syncthing last knew it. Folders this side never had are left out; null
   * when Syncthing is not running or cannot answer.
   */
  async projectNeed(projectId: string): Promise<FolderNeed[] | null> {
    const needs: FolderNeed[] = [];
    try {
      for (const folder of await this.projectFolders(projectId)) {
        try {
          const status = await this.status(folder.id);
          needs.push({
            id: folder.id,
            needItems: status.needTotalItems,
            needBytes: status.needBytes,
          });
        } catch (error) {
          if (!(error instanceof SyncthingRestError && error.status === 404)) throw error;
        }
      }
    } catch {
      return null;
    }
    return needs;
  }

  /** Where this instance keeps the folder; never HOME or a directory containing it. */
  async folderPath(projectId: string, kind: ProjectFolder['kind'] = 'code'): Promise<string> {
    const project = await this.storage.getProject(projectId);
    const path = this.paths.codeFolder(project);
    assertShareableFolder(path);
    return kind === 'git' ? join(path, '.git') : path;
  }

  /**
   * Creates or replaces the folder paused, installs its ignore patterns
   * before the first scan, then unpauses it unless `paused` is set.
   */
  async ensureFolder(request: SyncFolderRequest): Promise<SyncFolder> {
    if (request.forceCopy && request.type !== 'receiveonly')
      throw new AppError(
        'Force copy backups require a receive-only folder',
        'INVALID_FORCE_COPY',
        400,
      );
    const backupPath = request.forceCopy
      ? (
          await this.forceCopyBackup({
            projectId: request.projectId,
            kind: request.kind,
            forceCopy: request.forceCopy,
          })
        ).path
      : undefined;
    const path = await this.folderPath(request.projectId, request.kind);
    const id = projectFolderId(request.projectId, request.kind);
    await mkdir(path, { recursive: true });
    if (request.kind === 'code') await excludeMarkersFromGit(path);
    const client = this.client();
    await client.request('PUT', `/rest/config/folders/${enc(id)}`, {
      id,
      label: id,
      path,
      type: request.type,
      devices: [{ deviceID: request.peerDeviceId }],
      paused: true,
      fsWatcherEnabled: true,
      fsWatcherDelayS: FOLDER_WATCHER_DELAY_S,
      rescanIntervalS: RESCAN_INTERVAL_S,
      ...(backupPath
        ? {
            maxConflicts: -1,
            versioning: {
              type: 'trashcan',
              fsPath: backupPath,
              fsType: 'basic',
              params: { cleanoutDays: '0' },
            },
          }
        : { versioning: { type: '' }, maxConflicts: request.kind === 'git' ? 0 : 10 }),
    });
    await client.request('POST', `/rest/db/ignores?folder=${enc(id)}`, {
      ignore: request.ignores,
    });
    const paused = request.paused ?? false;
    if (!paused) await this.updateFolder(id, { paused: false });
    return { id, path, type: request.type, paused, ...(backupPath && { backupPath }) };
  }

  /** Computes and creates a local backup directory without touching any share record. */
  async forceCopyBackup(request: ForceCopyBackupRequest): Promise<ForceCopyBackup> {
    const { projectId, kind, forceCopy } = ForceCopyBackupRequestSchema.parse({
      projectId: request.projectId,
      kind: request.kind,
      forceCopy: request.forceCopy,
    });
    await this.folderPath(projectId, kind);
    const path = join(
      dirname(this.paths.syncthingHome()),
      'sync-backups',
      projectId,
      forceCopy.operationId,
      kind,
    );
    await mkdir(path, { recursive: true });
    return { path };
  }

  /**
   * Changes direction or pause state. For a flip, make the new receiver
   * `receiveonly` before the new sender becomes `sendonly`, so there is never
   * a moment with two senders.
   */
  async updateFolder(folderId: string, patch: SyncFolderPatch): Promise<void> {
    const { ignores, ...configuration } = patch;
    if (ignores) {
      await this.client().request('POST', `/rest/db/ignores?folder=${enc(folderId)}`, {
        ignore: ignores,
      });
    }
    await this.client().request('PATCH', `/rest/config/folders/${enc(folderId)}`, {
      ...configuration,
      fsWatcherDelayS: FOLDER_WATCHER_DELAY_S,
    });
  }

  async folderConfiguration(folderId: string) {
    return SyncFolderConfigurationSchema.parse(
      await this.client().request('GET', `/rest/config/folders/${enc(folderId)}`),
    );
  }

  async setFolderType(folderId: string, type: FolderType): Promise<void> {
    await this.updateFolder(folderId, { type });
  }

  /** Folder status; with `peerDeviceId`, also this side's view of the peer's copy. */
  async status(
    folderId: string,
    peerDeviceId?: string,
    options: SyncStatusOptions = {},
  ): Promise<FolderSyncStatus> {
    const client = this.client();
    const raw = RawStatusSchema.parse(
      await client.request('GET', `/rest/db/status?folder=${enc(folderId)}`),
    );
    const peer = peerDeviceId
      ? RawCompletionSchema.parse(
          await client.request(
            'GET',
            `/rest/db/completion?folder=${enc(folderId)}&device=${enc(peerDeviceId)}`,
          ),
        )
      : null;
    const fileErrors =
      raw.errors || options.allErrors
        ? await this.fileErrors(client, folderId, options.allErrors)
        : [];
    return {
      folderId,
      ...raw,
      ...(fileErrors.length || options.allErrors ? { fileErrors } : {}),
      peer: peer && { deviceId: peerDeviceId ?? '', ...peer },
    };
  }

  /** Pagination counts every pending file/deletion without retaining every path. */
  async remoteNeed(folderId: string, peerDeviceId: string): Promise<RemoteNeed> {
    const result: RemoteNeed = {
      total: 0,
      deleted: 0,
      sample: [],
      conflictPaths: [],
      conflictsOverCap: false,
    };
    for (let page = 1; ; page += 1) {
      const { files } = RawRemoteNeedSchema.parse(
        await this.client().request(
          'GET',
          `/rest/db/remoteneed?folder=${enc(folderId)}&device=${enc(peerDeviceId)}&page=${page}&perpage=${REMOTE_NEED_PAGE_SIZE}`,
        ),
      );
      for (const file of files) {
        if (file.type === 'FILE_INFO_TYPE_DIRECTORY') continue;
        result.total += 1;
        if (file.deleted) result.deleted += 1;
        if (result.sample.length < FILE_SYNC_REPORT_SAMPLE)
          result.sample.push({ path: file.name, deleted: file.deleted });
        if (
          file.name.split('/').at(-1)?.includes('.sync-conflict-') &&
          !result.conflictsOverCap &&
          !result.conflictPaths.includes(file.name)
        ) {
          if (result.conflictPaths.length === CONFLICT_BASELINE_MAX) {
            result.conflictsOverCap = true;
            result.conflictPaths = [];
          } else result.conflictPaths.push(file.name);
        }
      }
      if (files.length < REMOTE_NEED_PAGE_SIZE) return result;
    }
  }

  async conflicts(
    projectId: string,
    baseline: ConflictBaseline,
    ignores: readonly string[],
    signal?: AbortSignal,
  ): Promise<ConflictReport> {
    return scanFileSyncConflicts(await this.folderPath(projectId), baseline, ignores, signal);
  }

  async conflictBaseline(
    projectId: string,
    ignores: readonly string[],
    signal?: AbortSignal,
  ): Promise<ConflictBaseline> {
    return captureFileSyncConflictBaseline(await this.folderPath(projectId), ignores, signal);
  }

  /** A full-list read must surface failures rather than looking like an empty list. */
  private async fileErrors(client: SyncthingRestClient, folderId: string, allErrors = false) {
    try {
      const body = FolderErrorsSchema.parse(
        await client.request(
          'GET',
          `/rest/folder/errors?folder=${enc(folderId)}${allErrors ? '' : `&page=1&perpage=${FILE_ERROR_SAMPLE}`}`,
        ),
      );
      const errors = body.errors ?? [];
      return allErrors ? errors : errors.slice(0, FILE_ERROR_SAMPLE);
    } catch (error) {
      if (allErrors) throw error;
      return [];
    }
  }

  /** Stops sharing the folder; its files stay on disk. A folder that is gone counts as removed. */
  async removeFolder(folderId: string): Promise<void> {
    try {
      await this.client().request('DELETE', `/rest/config/folders/${enc(folderId)}`);
    } catch (error) {
      if (!(error instanceof SyncthingRestError && error.status === 404)) throw error;
    }
  }

  async rescan(folderId: string, signal?: AbortSignal): Promise<void> {
    await this.client().request(
      'POST',
      `/rest/db/scan?folder=${enc(folderId)}`,
      undefined,
      SCAN_TIMEOUT_MS,
      signal,
    );
  }

  /** On a receive-only side, discards local changes and restores the global version. */
  async revertLocalChanges(folderId: string): Promise<void> {
    await this.client().request('POST', `/rest/db/revert?folder=${enc(folderId)}`);
  }

  async override(folderId: string): Promise<void> {
    await this.client().request('POST', `/rest/db/override?folder=${enc(folderId)}`);
  }

  /** Counts receive-only changes while retaining at most one page of names. */
  async localChanges(folderId: string): Promise<ReceiveOnlyChanges> {
    const status = await this.status(folderId);
    const { files } = z
      .object({ files: z.array(z.object({ name: z.string() })) })
      .parse(
        await this.client().request(
          'GET',
          `/rest/db/localchanged?folder=${enc(folderId)}&page=1&perpage=${RECEIVE_ONLY_SAMPLE_MAX}`,
        ),
      );
    return {
      count: status.receiveOnlyChangedFiles,
      sample: files.slice(0, RECEIVE_ONLY_SAMPLE_MAX).map((file) => file.name),
    };
  }

  /**
   * Polls both sides until `evaluateCompletion` holds. Failed polls count as
   * not done. If the wait times out, it reports Syncthing's errors from the
   * last poll that read both sides, and the last failed poll. An outside
   * signal ends the wait with its own reason, also when it fires during a poll.
   * Each poll waits for both callbacks, also when one fails.
   */
  async waitForComplete(folderId: string, options: WaitForCompleteOptions): Promise<SyncProgress> {
    const deadline = Date.now() + options.timeoutMs;
    const sides = options.sides ?? { sender: 'the sender', receiver: 'the receiver' };
    let progress: SyncProgress | null = null;
    let lastError: string | null = null;
    let syncErrors: string[] = [];
    for (;;) {
      options.signal?.throwIfAborted();
      let done = false;
      try {
        // Both reads end before the poll does: a receiver read may be inside a Revert.
        const [senderRead, receiverRead] = await Promise.allSettled([
          options.sender(),
          options.receiver(),
        ]);
        if (senderRead.status === 'rejected') throw senderRead.reason;
        if (receiverRead.status === 'rejected') throw receiverRead.reason;
        const [sender, receiver] = [senderRead.value, receiverRead.value];
        syncErrors = [
          ...describeSyncErrors(receiver, sides.receiver),
          ...describeSyncErrors(sender, sides.sender),
        ];
        const result = options.symmetric
          ? evaluateSymmetricCompletion(sender, receiver)
          : evaluateCompletion(sender, receiver);
        progress = result.progress;
        lastError = null;
        options.onProgress?.(progress);
        done =
          result.done &&
          (!options.requireNoReceiveOnlyChanges || receiver.receiveOnlyChangedFiles === 0);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      // A cancel during the poll wins over its answer and over the deadline.
      options.signal?.throwIfAborted();
      if (done && progress) return progress;
      if (Date.now() >= deadline)
        throw new FileSyncTimeoutError(folderId, progress, lastError, syncErrors);
      await new Promise((resolve) =>
        setTimeout(resolve, options.pollIntervalMs ?? COMPLETION_POLL_MS),
      );
    }
  }

  private connection() {
    const connection = this.syncthing.getConnection();
    if (!connection) {
      throw new FileSyncUnavailableError(
        this.syncthing.getState().error ?? 'Syncthing is not running',
      );
    }
    return connection;
  }

  private client(): SyncthingRestClient {
    return this.connection().client;
  }
}

/**
 * Keeps Syncthing's markers, conflict copies and partial-pull temp files out
 * of git in a code folder that is a repository, through `.git/info/exclude`,
 * so the committed `.gitignore` stays untouched.
 */
async function excludeMarkersFromGit(root: string): Promise<void> {
  const gitDir = join(root, '.git');
  const isRepository = await stat(gitDir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!isRepository) return;
  const excludePath = join(gitDir, 'info', 'exclude');
  const current = await readFile(excludePath, 'utf8').catch(() => '');
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = SYNCTHING_GIT_EXCLUDES.filter((line) => !lines.has(line));
  if (missing.length === 0) return;
  await mkdir(join(gitDir, 'info'), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  await writeFile(excludePath, `${current}${prefix}${missing.join('\n')}\n`);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
