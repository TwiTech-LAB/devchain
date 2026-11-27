import { Test } from '@nestjs/testing';
import type { FolderSyncStatus, SyncStatusOptions } from '../../file-sync/file-sync.dto';
import {
  FileSyncService,
  type DeviceConnection,
  type FolderConfigurationSummary,
} from '../../file-sync/file-sync.service';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { SyncthingRestError } from '../../file-sync/syncthing-rest.client';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { FileSyncStatusService, OPEN_FORCE_SYNC_LIMIT } from './file-sync-status.service';
import { RemoteFileSyncService } from './remote-file-sync.service';

// Service units: the reads are stubbed at FileSyncService, so each case controls Syncthing's answers.
const HOME = 'HOME-DEVICE';
const VM = 'VM-DEVICE';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function idle(folderId: string, fields: Partial<FolderSyncStatus> = {}): FolderSyncStatus {
  return {
    folderId,
    state: 'idle',
    localFiles: 2,
    localDirectories: 0,
    globalFiles: 2,
    globalDirectories: 0,
    globalBytes: 20,
    needTotalItems: 0,
    needBytes: 0,
    receiveOnlyChangedFiles: 0,
    peer: {
      deviceId: VM,
      completion: 100,
      needItems: 0,
      needBytes: 0,
      needDeletes: 0,
      remoteState: 'valid',
    },
    ...fields,
  };
}

/** A folder with `items` still to come from the VM. */
function download(folderId: string, items: number): FolderSyncStatus {
  return idle(folderId, { needTotalItems: items, needBytes: items * 10 });
}

async function setup() {
  const syncthing = { running: true, version: 'v2.1.5', error: null as string | null };
  const binding = { remoteId: 'vm' };
  const operations: { projectId: string; state: string }[] = [];
  // Like the storage delegate: newest first, an optional project filter, and a row limit.
  const storage = {
    listRemoteOperations: jest.fn(async (filter: { projectId?: string; limit?: number } = {}) =>
      operations
        .filter(({ projectId }) => !filter.projectId || projectId === filter.projectId)
        .slice(0, filter.limit ?? 100),
    ),
  };
  const configs: FolderConfigurationSummary[] = [A, B].flatMap((projectId) =>
    (['code', 'git'] as const).map((kind) => ({
      id: `${kind}:${projectId}`,
      type: 'sendreceive',
      paused: false,
      devices: [{ deviceID: HOME }, { deviceID: VM }],
    })),
  );
  const statuses = new Map<string, FolderSyncStatus | Error>(
    configs.map((config) => [config.id, idle(config.id)]),
  );
  const connection: DeviceConnection = {
    connected: true,
    address: '10.0.0.2:22000',
    type: 'tcp-client',
    startedAt: '2026-11-24T10:00:00Z',
    inBytesTotal: 100,
    outBytesTotal: 200,
  };
  const files = {
    device: () => ({ deviceId: HOME, address: '' }),
    folderConfigurations: jest.fn(async () => configs),
    connections: jest.fn(async () => ({ [VM]: connection })),
    folderStats: jest.fn(async () => ({})),
    status: jest.fn(async (folderId: string, _peer?: string, _options?: SyncStatusOptions) => {
      const value = statuses.get(folderId)!;
      if (value instanceof Error) throw value;
      return value;
    }),
    needSample: jest.fn(async () => []),
    remoteNeedSample: jest.fn(async () => []),
  };
  const module = await Test.createTestingModule({
    providers: [
      FileSyncStatusService,
      { provide: FileSyncService, useValue: files },
      { provide: SyncthingManager, useValue: { getState: () => ({ ...syncthing }) } },
      {
        provide: RemoteBindingsService,
        useValue: {
          list: async () =>
            [A, B].map((projectId) => ({
              projectId,
              remoteId: binding.remoteId,
              state: 'remote',
            })),
        },
      },
      { provide: RemoteFileSyncService, useValue: { upkeepState: () => null } },
      {
        provide: REMOTE_HEALTH_PORT,
        useValue: { getState: () => ({ online: true, versionMatches: true }) },
      },
      { provide: STORAGE_SERVICE, useValue: storage },
    ],
  }).compile();
  return {
    service: module.get(FileSyncStatusService),
    syncthing,
    statuses,
    files,
    binding,
    operations,
    storage,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

describe('FileSyncStatusService', () => {
  afterEach(() => jest.useRealTimers());

  it.each([
    [
      'a folder status read',
      (s: Setup) =>
        s.statuses.set(
          `git:${A}`,
          new SyncthingRestError('Syncthing answered 500', { path: '', status: 500 }),
        ),
    ],
    [
      'a pending file name read',
      (s: Setup) => {
        s.statuses.set(`code:${A}`, idle(`code:${A}`, { needTotalItems: 1, needBytes: 5 }));
        s.files.needSample.mockRejectedValue(new Error('timeout') as never);
      },
    ],
  ])(
    'gives a project whose %s fails `unknown` and leaves the other projects unchanged',
    async (_name, fail) => {
      const s = await setup();
      fail(s);

      const { scopes } = await s.service.status({ details: true });

      expect(scopes).toEqual([
        expect.objectContaining({
          projectId: A,
          verdict: 'unknown',
          reason: 'DevChain could not read the file sync status.',
          toVm: null,
          files: null,
          folders: [],
        }),
        expect.objectContaining({ projectId: B, verdict: 'in-sync', files: 4, bytes: 40 }),
      ]);
    },
  );

  it('keeps the link facts of a VM whose only project could not be read', async () => {
    const s = await setup();
    s.statuses.set(`code:${A}`, new Error('timeout'));

    const answer = await s.service.status({ projectId: A });

    expect(answer.scopes[0].verdict).toBe('unknown');
    expect(answer.links).toEqual([
      {
        remoteId: 'vm',
        connected: true,
        since: '2026-11-24T10:00:00Z',
        address: '10.0.0.2:22000',
        sentBytes: 200,
        receivedBytes: 100,
      },
    ]);
  });

  it('answers null link facts for a VM device that is not connected', async () => {
    const s = await setup();
    s.files.connections.mockResolvedValue({
      [VM]: {
        connected: false,
        address: '',
        type: '',
        startedAt: '0001-01-01T00:00:00Z',
        inBytesTotal: 0,
        outBytesTotal: 0,
      },
    });

    const answer = await s.service.status({ projectId: A });

    expect(answer.scopes[0].verdict).toBe('disconnected');
    expect(answer.links).toEqual([
      {
        remoteId: 'vm',
        connected: false,
        since: null,
        address: null,
        sentBytes: null,
        receivedBytes: null,
      },
    ]);
  });

  it('gives every project `unknown` when the folder stats cannot be read', async () => {
    const s = await setup();
    s.files.folderStats.mockRejectedValue(new Error('timeout'));

    const { scopes } = await s.service.status({});

    expect(scopes.map((scope) => scope.verdict)).toEqual(['unknown', 'unknown']);
  });

  it('counts a 404 for a folder paused after the config read as paused, not as a failed read', async () => {
    const { service, statuses } = await setup();
    statuses.set(
      `git:${A}`,
      new SyncthingRestError(
        'Syncthing answered 404 to GET /rest/db/completion: folder is paused',
        {
          path: '/rest/db/completion',
          status: 404,
        },
      ),
    );

    const { scopes } = await service.status({ projectId: A, details: true });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      verdict: 'busy',
      reason: 'File sync is paused on this PC.',
      files: 2,
      folders: [
        { id: `code:${A}`, paused: false },
        { id: `git:${A}`, paused: true, state: null },
      ],
    });
  });

  it('answers null counts and an empty link while Syncthing does not run', async () => {
    const { service, syncthing, files } = await setup();
    Object.assign(syncthing, { running: false, error: 'Syncthing is not installed' });

    const answer = await service.status({ projectId: A });

    expect(answer.syncthing).toEqual({
      running: false,
      version: 'v2.1.5',
      error: 'Syncthing is not installed',
    });
    expect(answer.links).toEqual([
      {
        remoteId: 'vm',
        connected: null,
        since: null,
        address: null,
        sentBytes: null,
        receivedBytes: null,
      },
    ]);
    expect(answer.scopes[0]).toMatchObject({
      verdict: 'unknown',
      reason: 'Syncthing is not installed',
      toVm: null,
      fromVm: null,
      failed: { home: null, vm: null },
      files: null,
      bytes: null,
      lastReceived: null,
    });
    expect(files.folderConfigurations).not.toHaveBeenCalled();
  });

  it('answers null for the counts an older Syncthing answer lacks', async () => {
    const { service, statuses } = await setup();
    statuses.set(`git:${A}`, idle(`git:${A}`, { globalBytes: undefined }));
    statuses.set(`code:${A}`, idle(`code:${A}`, { errors: 3 }));

    const { scopes } = await service.status({ projectId: A, details: true });

    expect(scopes[0]).toMatchObject({ files: 4, bytes: null });
    expect(scopes[0].folders?.map(({ bytes, errors }) => ({ bytes, errors }))).toEqual([
      { bytes: 20, errors: 3 },
      { bytes: null, errors: null },
    ]);
  });

  it('shows `syncing` when the pending count is lower than in the previous request', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-24T12:00:00Z') });
    const { service, statuses } = await setup();
    statuses.set(`code:${A}`, download(`code:${A}`, 5));
    const first = await service.status({ projectId: A });
    jest.advanceTimersByTime(5_000);
    statuses.set(`code:${A}`, download(`code:${A}`, 2));

    const second = await service.status({ projectId: A });

    expect(first.scopes[0].verdict).toBe('waiting');
    expect(second.scopes[0]).toMatchObject({
      verdict: 'syncing',
      fromVm: { items: 2, bytes: 20 },
    });
  });

  it('gives a project `unknown` when the sample of its failed files cannot be read', async () => {
    const { service, files } = await setup();
    // The reader's contract: only a strict read rejects; otherwise an unreadable sample is no sample.
    files.status.mockImplementation(async (folderId, _peer, options) => {
      if (folderId !== `code:${A}`) return idle(folderId);
      if (options?.strictErrors) throw new Error('errors unavailable');
      return idle(folderId, { errors: 1 });
    });

    const { scopes } = await service.status({});

    expect(scopes.map(({ verdict }) => verdict)).toEqual(['unknown', 'in-sync']);
  });

  it('shows no progress when a slow details read ends after a newer read saw a longer queue', async () => {
    const { service, statuses, files } = await setup();
    const code = `code:${A}`;
    statuses.set(code, download(code, 1));
    let release!: (names: string[]) => void;
    files.needSample.mockReturnValueOnce(
      new Promise<string[]>((resolve) => (release = resolve)) as never,
    );
    const slow = service.status({ projectId: A, details: true });
    // The details read holds its counters (1 item) and waits for the names.
    while (files.needSample.mock.calls.length === 0) await new Promise(setImmediate);

    statuses.set(code, download(code, 4));
    const summary = await service.status({ projectId: A });
    release(['src/a.ts']);
    const details = await slow;
    statuses.set(code, download(code, 3));
    const next = await service.status({ projectId: A });

    expect(summary.scopes[0].verdict).toBe('waiting');
    expect(details.scopes[0].verdict).toBe('waiting');
    // The baseline is still the newer sample of 4 items, so 3 items is a measured decrease.
    expect(next.scopes[0].verdict).toBe('syncing');
  });

  it('keeps the order of the counters when a held read overlaps a later details read', async () => {
    const { service, statuses, files } = await setup();
    const code = `code:${A}`;
    const upload = (needItems: number) =>
      idle(code, {
        peer: { ...idle(code).peer!, completion: 90, needItems, needBytes: needItems * 10 },
      });
    const read = files.status.getMockImplementation()!;
    let releaseCounters!: () => void;
    let held = false;
    // Only the first counter read of the code folder waits; it answers with the value at release.
    files.status.mockImplementation(async (folderId, ...rest) => {
      if (folderId === code && !held) {
        held = true;
        await new Promise<void>((resolve) => (releaseCounters = resolve));
      }
      return read(folderId, ...rest);
    });
    let releaseNames!: (names: string[]) => void;
    files.remoteNeedSample.mockReturnValueOnce(
      new Promise<string[]>((resolve) => (releaseNames = resolve)) as never,
    );
    statuses.set(code, upload(1));
    const summary = service.status({ projectId: A });
    const details = service.status({ projectId: A, details: true });
    for (let turn = 0; turn < 5; turn += 1) await new Promise(setImmediate);

    statuses.set(code, upload(4));
    releaseCounters();
    const first = await summary;
    while (files.remoteNeedSample.mock.calls.length === 0) await new Promise(setImmediate);
    releaseNames(['src/a.ts']);
    const second = await details;
    statuses.set(code, upload(3));
    const third = await service.status({ projectId: A });

    expect(
      [first, second, third].map(({ scopes }) => [scopes[0].toVm?.items, scopes[0].verdict]),
    ).toEqual([
      [4, 'waiting'],
      [4, 'waiting'],
      [3, 'syncing'],
    ]);
  });

  it('takes the first sample on another VM as a new baseline, not as progress', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-24T12:00:00Z') });
    const { service, statuses, binding } = await setup();
    statuses.set(`code:${A}`, download(`code:${A}`, 5));
    await service.status({ projectId: A });
    jest.advanceTimersByTime(5_000);
    binding.remoteId = 'vm-2';
    statuses.set(`code:${A}`, download(`code:${A}`, 1));

    const moved = await service.status({ projectId: A });

    expect(moved.scopes[0]).toMatchObject({ remoteId: 'vm-2', verdict: 'waiting' });
  });

  it('reads the open Force sync operations once for all projects and takes the newest of each', async () => {
    const { service, operations, storage } = await setup();
    operations.push(
      { projectId: A, state: 'failed' },
      { projectId: A, state: 'running' },
      { projectId: B, state: 'running' },
    );

    const { scopes } = await service.status({});

    expect(storage.listRemoteOperations).toHaveBeenCalledTimes(1);
    expect(scopes.map(({ verdict }) => verdict)).toEqual(['problem', 'busy']);
  });

  it('finds the open Force sync of a project beyond the cap of the read of all projects', async () => {
    const { service, operations } = await setup();
    operations.push(
      ...Array.from({ length: OPEN_FORCE_SYNC_LIMIT }, (_, index) => ({
        projectId: `other-${index}`,
        state: 'failed',
      })),
      { projectId: B, state: 'failed' },
    );

    const { scopes } = await service.status({});

    expect(scopes.map(({ verdict }) => verdict)).toEqual(['in-sync', 'problem']);
  });

  it('reads pending file names only with details and only for a direction with pending work', async () => {
    const { service, statuses, files } = await setup();
    statuses.set(`code:${A}`, idle(`code:${A}`, { needTotalItems: 1, needBytes: 5 }));
    files.needSample.mockResolvedValue(['src/a.ts'] as never);

    const plain = await service.status({ projectId: A });
    const detailed = await service.status({ projectId: A, details: true });

    expect(plain.scopes[0].folders).toBeUndefined();
    expect(detailed.scopes[0].folders?.[0].pending).toEqual([
      { direction: 'fromVm', path: 'src/a.ts' },
    ]);
    expect(files.needSample).toHaveBeenCalledTimes(1);
    expect(files.remoteNeedSample).not.toHaveBeenCalled();
  });
});
