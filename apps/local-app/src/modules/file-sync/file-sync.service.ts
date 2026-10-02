import { Inject, Injectable } from '@nestjs/common';
import { mkdir, readFile, stat, lstat, writeFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import {
  SYNCTHING_MARKERS,
  SYNCTHING_TEMP_PATTERNS,
} from '../../common/constants/syncthing-markers';
import { AppError } from '../../common/errors/error-types';
import { STORAGE_SERVICE, type ProjectStorage } from '../storage/interfaces/storage.interface';
import { FILE_SYNC_PATHS, assertShareableFolder, type FileSyncPaths } from './file-sync-paths';
import {
  FolderSyncStatusSchema,
  FolderTypeSchema,
  type FolderSyncStatus,
  type FolderType,
  type SyncDevice,
  type SyncFolder,
  type SyncFolderPatch,
  type SyncFolderRequest,
} from './file-sync.dto';
import { FileSyncIgnoresStore } from './file-sync-ignores.store';
import { SyncthingManager } from './syncthing-manager.service';
import { SyncthingRestError, type SyncthingRestClient } from './syncthing-rest.client';

/**
 * Sent in every folder PATCH: Syncthing v1 resets an omitted `fsWatcherDelayS`
 * to 10 s, which would slow every change after a direction flip.
 */
export const FOLDER_WATCHER_DELAY_S = 1;
const RESCAN_INTERVAL_S = 3600;
const COMPLETION_POLL_MS = 500;
/**
 * Syncthing answers POST /rest/db/scan only when the scan ends, and a folder's first
 * scan hashes every file, so a large project takes far longer than a normal REST call.
 */
export const SCAN_TIMEOUT_MS = 10 * 60_000;

const RawStatusSchema = FolderSyncStatusSchema.omit({ folderId: true, peer: true });

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
  constructor(folderId: string, progress: SyncProgress | null, lastError: string | null) {
    super(
      `Folder ${folderId} did not finish syncing in time${lastError ? `: ${lastError}` : ''}`,
      'FILE_SYNC_TIMEOUT',
      504,
      { folderId, progress, lastError },
    );
  }
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
    sender.state === 'idle' &&
    receiver.state === 'idle' &&
    receiver.needTotalItems === 0 &&
    receiver.globalFiles === sender.localFiles &&
    receiver.localFiles === sender.localFiles &&
    receiver.globalDirectories === sender.localDirectories;
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
  /** When it fires, the wait ends with the signal's reason instead of the timeout. */
  signal?: AbortSignal;
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

  setIgnores(projectId: string, ignores: string[] | null): string[] {
    return this.ignores.set(projectId, ignores);
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
    const gitDirectory = await lstat(join(root, '.git')).then(
      (info) => info.isDirectory(),
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    return projectFolderList(projectId, gitDirectory ? ['code', 'git'] : ['code']);
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
      ...(request.kind === 'git' ? { maxConflicts: 0 } : {}),
    });
    await client.request('POST', `/rest/db/ignores?folder=${enc(id)}`, {
      ignore: request.ignores,
    });
    const paused = request.paused ?? false;
    if (!paused) await this.updateFolder(id, { paused: false });
    return { id, path, type: request.type, paused };
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
    return z
      .object({
        type: FolderTypeSchema,
        paused: z.boolean(),
        devices: z.array(z.object({ deviceID: z.string() })),
      })
      .parse(await this.client().request('GET', `/rest/config/folders/${enc(folderId)}`));
  }

  async setFolderType(folderId: string, type: FolderType): Promise<void> {
    await this.updateFolder(folderId, { type });
  }

  /** Folder status; with `peerDeviceId`, also this side's view of the peer's copy. */
  async status(folderId: string, peerDeviceId?: string): Promise<FolderSyncStatus> {
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
    return { folderId, ...raw, peer: peer && { deviceId: peerDeviceId ?? '', ...peer } };
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

  /**
   * Polls both sides until `evaluateCompletion` holds. Failed polls count as
   * not done; the last failure is reported if the wait times out. An outside
   * signal ends the wait with its own reason, also when it fires during a poll.
   */
  async waitForComplete(folderId: string, options: WaitForCompleteOptions): Promise<SyncProgress> {
    const deadline = Date.now() + options.timeoutMs;
    let progress: SyncProgress | null = null;
    let lastError: string | null = null;
    for (;;) {
      options.signal?.throwIfAborted();
      let done = false;
      try {
        const [sender, receiver] = await Promise.all([options.sender(), options.receiver()]);
        const result = options.symmetric
          ? evaluateSymmetricCompletion(sender, receiver)
          : evaluateCompletion(sender, receiver);
        progress = result.progress;
        lastError = null;
        options.onProgress?.(progress);
        done = result.done;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      // A cancel during the poll wins over its answer and over the deadline.
      options.signal?.throwIfAborted();
      if (done && progress) return progress;
      if (Date.now() >= deadline) throw new FileSyncTimeoutError(folderId, progress, lastError);
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
  const missing = [
    ...SYNCTHING_MARKERS.map((marker) => `/${marker}`),
    '*.sync-conflict-*',
    ...SYNCTHING_TEMP_PATTERNS,
  ].filter((line) => !lines.has(line));
  if (missing.length === 0) return;
  await mkdir(join(gitDir, 'info'), { recursive: true });
  const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  await writeFile(excludePath, `${current}${prefix}${missing.join('\n')}\n`);
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
