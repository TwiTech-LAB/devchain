import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import type { FolderSyncStatus } from '../../file-sync/file-sync.dto';
import {
  FileSyncService,
  projectFolderList,
  type DeviceConnection,
  type FolderConfigurationSummary,
  type FolderStats,
} from '../../file-sync/file-sync.service';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { SyncthingRestError } from '../../file-sync/syncthing-rest.client';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteProjectBinding } from '../../storage/models/domain.models';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import type {
  FileSyncStatusFolder,
  FileSyncStatusLink,
  FileSyncStatusOptions,
  FileSyncStatusResponse,
  FileSyncStatusScope,
  LastReceivedFile,
} from './file-sync-status.dto';
import {
  folderCounts,
  scopeStatus,
  takesPart,
  trustedUpkeep,
  type ScopeFacts,
  type ScopeMemory,
  type VerdictFolder,
} from './file-sync-verdict';
import { RemoteFileSyncService } from './remote-file-sync.service';

const logger = createLogger('FileSyncStatusService');
const PENDING_SAMPLE = 10;
/** Open Force sync operations are few; the cap only bounds the one read of all projects. */
export const OPEN_FORCE_SYNC_LIMIT = 500;

type OpenForceSync = NonNullable<ScopeFacts['forceSync']>;

interface OpenForceSyncRead {
  /** The newest open Force sync of each project in the read. */
  newest: Map<string, OpenForceSync>;
  /** False when the read reached its cap, so a project that is absent can still have one. */
  complete: boolean;
}

interface SharedReads {
  homeDeviceId: string | null;
  configs: Map<string, FolderConfigurationSummary> | null;
  connections: Record<string, DeviceConnection> | null;
  stats: Record<string, FolderStats> | null;
  forceSync: OpenForceSyncRead | null;
}

interface StoredMemory {
  /** The VM that the samples belong to; a sample of another VM is no baseline. */
  vm: string;
  memory: ScopeMemory;
}

interface ReadFolder extends VerdictFolder {
  id: string;
  kind: FileSyncStatusFolder['kind'];
  /** Read only with `details=true`. */
  pending: FileSyncStatusFolder['pending'];
}

/** The facts of a scope, with the folders as this service reads them. */
interface ReadFacts extends ScopeFacts {
  folders: ReadFolder[];
}

/** The facts that the counter read of one project gives. */
type CounterRead = Pick<ReadFacts, 'codeConfigured' | 'connected' | 'forceSync' | 'folders'>;

/**
 * Measured file sync status of the projects on VMs, read from home's Syncthing only. It never
 * calls a VM and never runs upkeep, so it also answers while upkeep is stopped.
 */
@Injectable()
export class FileSyncStatusService {
  /** The newest pending sample per project; requests from several tabs share it. */
  private readonly memory = new Map<string, StoredMemory>();
  /** The end of the last counter read of each project that is still in progress. */
  private readonly turns = new Map<string, Promise<void>>();

  constructor(
    private readonly files: FileSyncService,
    private readonly syncthing: SyncthingManager,
    private readonly bindings: RemoteBindingsService,
    private readonly upkeep: RemoteFileSyncService,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
  ) {}

  async status(options: FileSyncStatusOptions): Promise<FileSyncStatusResponse> {
    const now = Date.now();
    const syncthing = this.syncthing.getState();
    const remote = (await this.bindings.list()).filter((binding) => binding.state === 'remote');
    const scopeIds = new Set(remote.map((binding) => binding.projectId));
    for (const projectId of this.memory.keys())
      if (!scopeIds.has(projectId)) this.memory.delete(projectId);
    const bindings = options.projectId
      ? remote.filter((binding) => binding.projectId === options.projectId)
      : remote;
    // Without a project in scope the answer has no scope and no link, so it needs no read.
    const shared =
      syncthing.running && bindings.length > 0 ? await this.sharedReads(options.projectId) : null;
    const scopes = await Promise.all(
      bindings.map((binding) => this.scope(binding, syncthing, shared, options.details === true)),
    );
    return {
      checkedAt: new Date(now).toISOString(),
      syncthing: { running: syncthing.running, version: syncthing.version, error: syncthing.error },
      links: links(scopes, shared?.connections ?? null),
      scopes: scopes.map(({ scope }) => scope),
    };
  }

  private async sharedReads(projectId?: string): Promise<SharedReads> {
    const [configs, connections, stats, forceSync] = await Promise.allSettled([
      this.files.folderConfigurations(),
      this.files.connections(),
      this.files.folderStats(),
      this.openForceSync(projectId),
    ]);
    for (const read of [configs, connections, stats, forceSync])
      if (read.status === 'rejected')
        logger.debug({ error: read.reason as unknown }, 'A read for sync status failed');
    let homeDeviceId: string | null = null;
    try {
      homeDeviceId = this.files.device().deviceId;
    } catch {
      // Syncthing stopped after getState(); every scope of this request is unknown.
    }
    return {
      homeDeviceId,
      configs:
        configs.status === 'fulfilled'
          ? new Map(configs.value.map((config) => [config.id, config]))
          : null,
      connections: connections.status === 'fulfilled' ? connections.value : null,
      stats: stats.status === 'fulfilled' ? stats.value : null,
      forceSync: forceSync.status === 'fulfilled' ? forceSync.value : null,
    };
  }

  /** One read for all scopes of a request; the list is newest first. */
  private async openForceSync(projectId?: string): Promise<OpenForceSyncRead> {
    const limit = projectId ? 1 : OPEN_FORCE_SYNC_LIMIT;
    const operations = await this.storage.listRemoteOperations({
      ...(projectId && { projectId }),
      kinds: ['force_sync'],
      states: ['running', 'failed'],
      limit,
    });
    const newest = new Map<string, OpenForceSync>();
    for (const { projectId: id, state } of operations)
      if (id && !newest.has(id) && (state === 'running' || state === 'failed'))
        newest.set(id, state);
    return { newest, complete: projectId !== undefined || operations.length < limit };
  }

  /**
   * Runs `work` after the earlier work of the same project. One request at a time reads the
   * counters of a project and compares them with the memory, so the memory gets the samples in
   * the order in which Syncthing gave them, also when the requests of several tabs overlap.
   */
  private inTurn<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.turns.get(projectId) ?? Promise.resolve()).then(work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.turns.set(projectId, settled);
    void settled.then(() => {
      if (this.turns.get(projectId) === settled) this.turns.delete(projectId);
    });
    return run;
  }

  private async scope(
    binding: RemoteProjectBinding,
    syncthing: ScopeFacts['syncthing'],
    shared: SharedReads | null,
    details: boolean,
  ): Promise<{ scope: FileSyncStatusScope; vmDeviceId: string | null }> {
    const { projectId, remoteId } = binding;
    const health = this.health.getState(remoteId);
    const upkeepTrusted = health.online && !health.apiKeyRejected && health.versionMatches;
    const upkeepState = this.upkeep.upkeepState(projectId);
    const upkeep = upkeepState?.remoteId === remoteId ? upkeepState : null;
    const vmDeviceId = shared && vmDevice(projectId, shared);
    const vm = `${remoteId}:${vmDeviceId ?? ''}`;
    const facts: ReadFacts = {
      syncthing,
      readFailed: false,
      codeConfigured: false,
      connected: false,
      forceSync: null,
      upkeepTrusted,
      upkeep,
      folders: [],
    };
    const baseline = () => {
      const stored = this.memory.get(projectId);
      return stored?.vm === vm ? stored.memory : undefined;
    };
    const measured = await this.inTurn(projectId, async () => {
      if (shared) {
        try {
          Object.assign(facts, await this.readCounters(projectId, shared, vmDeviceId));
        } catch (error) {
          logger.debug({ error, projectId }, 'File sync status of a project could not be read');
          facts.readFailed = true;
        }
      }
      const observedAt = Date.now();
      const outcome = scopeStatus(facts, baseline(), observedAt);
      this.memory.set(projectId, { vm, memory: outcome.memory });
      return { outcome, observedAt };
    });
    let { outcome } = measured;
    let { folders } = facts;
    // The names can take longer than the counters. They stay outside the turn and add no sample.
    if (details && vmDeviceId && folders.some((folder) => folder.status)) {
      try {
        const named = await this.pendingNames(folders, vmDeviceId);
        if (named.some((folder, index) => folder.paused !== folders[index].paused)) {
          facts.folders = named;
          outcome = scopeStatus(facts, baseline(), measured.observedAt, true);
        }
        folders = named;
      } catch (error) {
        logger.debug({ error, projectId }, 'Pending file names of a project could not be read');
        facts.readFailed = true;
        folders = [];
        outcome = scopeStatus(facts, baseline(), measured.observedAt, true);
      }
    }
    const active = folders.filter((folder) => folder.status);
    const scope: FileSyncStatusScope = {
      projectId,
      remoteId,
      verdict: outcome.verdict,
      reason: outcome.reason,
      toVm: outcome.toVm,
      fromVm: outcome.fromVm,
      failed: {
        home: outcome.failedHome,
        vm: trustedUpkeep(facts)?.vmFailed ?? null,
      },
      files: sum(active, (status) => status.globalFiles),
      bytes: sum(active, (status) => status.globalBytes),
      lastReceived: newest(
        folders
          .filter((folder) => takesPart(folder.type, 'fromVm'))
          .map((folder) => lastReceived(shared, folder.id)),
      ),
      ...(details && { folders: folders.map((folder) => folderDetails(folder, shared)) }),
    };
    return { scope, vmDeviceId };
  }

  /**
   * The counters of one project. Throws when a read that the answer needs fails, so the project
   * becomes `unknown`. A folder that Syncthing reports as paused is not a failure.
   */
  private async readCounters(
    projectId: string,
    shared: SharedReads,
    vmDeviceId: string | null,
  ): Promise<CounterRead> {
    const { configs, connections, stats } = shared;
    if (!configs || !connections || !stats || !shared.forceSync)
      throw new Error(
        "Home's Syncthing config, connections, folder stats or open operations could not be read",
      );
    let forceSync = shared.forceSync.newest.get(projectId) ?? null;
    // The read of all projects reached its cap: this project can have an operation beyond it.
    if (!forceSync && !shared.forceSync.complete)
      forceSync = (await this.openForceSync(projectId)).newest.get(projectId) ?? null;
    const configured = projectFolderList(projectId).flatMap((folder) => {
      const config = configs.get(folder.id);
      return config ? [{ ...folder, config }] : [];
    });
    if (!configured.some((folder) => folder.kind === 'code'))
      return { codeConfigured: false, connected: false, forceSync, folders: [] };
    if (!vmDeviceId) throw new Error('Expected one VM device in the code folder');
    const folders = await Promise.all(
      configured.map(async ({ id, kind, config }): Promise<ReadFolder> => {
        const folder: ReadFolder = {
          id,
          kind,
          type: config.type,
          paused: false,
          status: null,
          pending: [],
        };
        if (config.paused) return pausedFolder(folder);
        try {
          // A sample that cannot be read must not pass as "no persistent failure".
          const status = await this.files.status(id, vmDeviceId, { strictErrors: true });
          return { ...folder, status };
        } catch (error) {
          if (pausedAnswer(error)) return pausedFolder(folder);
          throw error;
        }
      }),
    );
    return {
      codeConfigured: true,
      connected: connections[vmDeviceId]?.connected === true,
      forceSync,
      folders,
    };
  }

  /** The pending file names of the folders that have a status; a folder paused meanwhile is paused. */
  private pendingNames(folders: ReadFolder[], vmDeviceId: string): Promise<ReadFolder[]> {
    return Promise.all(
      folders.map(async (folder) => {
        if (!folder.status) return folder;
        try {
          return { ...folder, pending: await this.pendingSample(folder, vmDeviceId) };
        } catch (error) {
          if (pausedAnswer(error)) return pausedFolder(folder);
          throw error;
        }
      }),
    );
  }

  private async pendingSample(
    folder: ReadFolder,
    vmDeviceId: string,
  ): Promise<ReadFolder['pending']> {
    const { toVm, fromVm } = folderCounts(folder);
    const [to, from] = await Promise.all([
      toVm?.items ? this.files.remoteNeedSample(folder.id, vmDeviceId, PENDING_SAMPLE) : [],
      fromVm?.items ? this.files.needSample(folder.id, PENDING_SAMPLE) : [],
    ]);
    return [
      ...to.map((path) => ({ direction: 'toVm' as const, path })),
      ...from.map((path) => ({ direction: 'fromVm' as const, path })),
    ];
  }
}

/** The VM device of a project: the one device of its code folder that is not home's. */
function vmDevice(projectId: string, shared: SharedReads): string | null {
  const code = shared.configs?.get(projectFolderList(projectId, ['code'])[0].id);
  const peers = code?.devices.filter((device) => device.deviceID !== shared.homeDeviceId);
  return shared.homeDeviceId && peers?.length === 1 ? peers[0].deviceID : null;
}

function folderDetails(folder: ReadFolder, shared: SharedReads | null): FileSyncStatusFolder {
  const { status } = folder;
  return {
    id: folder.id,
    kind: folder.kind,
    type: folder.type,
    paused: folder.paused,
    state: status?.state ?? null,
    remoteState: status?.peer?.remoteState ?? null,
    files: status?.globalFiles ?? null,
    bytes: status?.globalBytes ?? null,
    ...folderCounts(folder),
    errors: status?.errors ?? null,
    error: status?.error?.trim() || null,
    watchError: status?.watchError?.trim() || null,
    lastReceived: lastReceived(shared, folder.id),
    pending: folder.pending,
  };
}

function pausedFolder(folder: ReadFolder): ReadFolder {
  return { ...folder, paused: true, status: null };
}

/** Syncthing answers 404 for a folder that was paused after the config read. */
function pausedAnswer(error: unknown): boolean {
  return (
    error instanceof SyncthingRestError &&
    error.status === 404 &&
    /folder is paused|no such folder/i.test(error.message)
  );
}

function sum(
  folders: ReadFolder[],
  value: (status: FolderSyncStatus) => number | undefined,
): number | null {
  if (folders.length === 0) return null;
  let total = 0;
  for (const folder of folders) {
    const next = value(folder.status!);
    if (next === undefined) return null;
    total += next;
  }
  return total;
}

function lastReceived(shared: SharedReads | null, folderId: string): LastReceivedFile | null {
  const file = shared?.stats?.[folderId]?.lastFile;
  return file ? { path: file.filename, at: file.at, deleted: file.deleted } : null;
}

function newest(files: (LastReceivedFile | null)[]): LastReceivedFile | null {
  return files.reduce<LastReceivedFile | null>(
    (latest, file) =>
      file && (!latest || Date.parse(file.at) > Date.parse(latest.at)) ? file : latest,
    null,
  );
}

function links(
  scopes: { scope: FileSyncStatusScope; vmDeviceId: string | null }[],
  connections: Record<string, DeviceConnection> | null,
): FileSyncStatusLink[] {
  const devices = new Map<string, string | null>();
  for (const { scope, vmDeviceId } of scopes)
    if (!devices.get(scope.remoteId)) devices.set(scope.remoteId, vmDeviceId);
  return [...devices].map(([remoteId, deviceId]) => {
    // Without the VM device or the connections, home does not know the state of the link.
    const known = Boolean(deviceId && connections);
    const connection = deviceId ? connections?.[deviceId] : undefined;
    const live = connection?.connected ? connection : null;
    return {
      remoteId,
      connected: known ? live !== null : null,
      since: live?.startedAt ?? null,
      address: live?.address ?? null,
      // Syncthing reports zero totals for a device that is not connected.
      sentBytes: live?.outBytesTotal ?? null,
      receivedBytes: live?.inBytesTotal ?? null,
    };
  });
}
