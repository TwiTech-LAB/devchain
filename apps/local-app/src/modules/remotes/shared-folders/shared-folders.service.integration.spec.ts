// Real SQLite holds the entries, so the one-transaction overlap check and the stored
// `patternsApplied` flag are tested as they run; Syncthing and the VM are fakes.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../../../common/errors/error-types';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import type { FolderSyncStatus } from '../../file-sync/file-sync.dto';
import type { FileSyncService } from '../../file-sync/file-sync.service';
import { shareFolderId, shareId } from '../../file-sync/share-paths';
import { SyncthingRestError } from '../../file-sync/syncthing-rest.client';
import type { RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { RemoteHostRequestError, type RemoteHostClient } from '../operations/remote-host.client';
import type { RemoteOperationsService } from '../operations/remote-operations.service';
import type { RemoteHealthPort } from '../ports/remote-health.port';
import { SharedFoldersLifecycle } from './shared-folders.lifecycle';
import { SharedFoldersService } from './shared-folders.service';
import { SharedFoldersStore } from './shared-folders.store';

const vm = '22222222-2222-4222-8222-222222222222';
const otherVm = '33333333-3333-4333-8333-333333333333';
const root = mkdtempSync(join(tmpdir(), 'devchain-shared-folders-'));
const notes = join(root, 'notes');
mkdirSync(join(notes, 'sub'), { recursive: true });
mkdirSync(join(root, 'photos'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const status = (patch: Partial<FolderSyncStatus> = {}): FolderSyncStatus => ({
  folderId: 'share:x',
  state: 'idle',
  localFiles: 1,
  localDirectories: 0,
  globalFiles: 1,
  globalDirectories: 0,
  needTotalItems: 0,
  needBytes: 0,
  receiveOnlyChangedFiles: 0,
  peer: null,
  ...patch,
});

const hostError = (status: number | null) =>
  new RemoteHostRequestError('VM request failed', {
    remoteId: vm,
    path: '/api/host/sync',
    status,
    hostCode: null,
  });

function operation(patch: Partial<RemoteOperation>): RemoteOperation {
  return {
    id: 'op-1',
    kind: 'share_folder',
    remoteId: vm,
    projectId: null,
    state: 'running',
    steps: [],
    details: { shareId: shareId(notes) },
    createdAt: '',
    updatedAt: '',
    ...patch,
  };
}

let database: ReturnType<typeof createTestDatabase>;
let store: SharedFoldersStore;
let operations: RemoteOperation[];
let online: boolean;
const files = {
  assertSharePath: jest.fn(async (path: string) => path),
  status: jest.fn(async () => status()),
  removeFolder: jest.fn(async () => undefined),
  updateFolder: jest.fn(async () => undefined),
};
const host = {
  syncStatus: jest.fn(async () => status()),
  syncRemoveFolder: jest.fn(async () => undefined),
  syncShareIgnores: jest.fn(async () => undefined),
};
const remoteOperations = {
  shareFolder: jest.fn(async (remoteId: string) => operation({ id: 'started', remoteId })),
};
let service: SharedFoldersService;

beforeEach(() => {
  jest.clearAllMocks();
  database = createTestDatabase();
  store = new SharedFoldersStore(database.db);
  operations = [];
  online = true;
  const storage = {
    getRemote: jest.fn(async (id: string) => ({ id })),
    listRemoteOperations: jest.fn(async () => operations),
  };
  service = new SharedFoldersService(
    storage as unknown as RemoteStorage,
    { getState: () => ({ online }) } as unknown as RemoteHealthPort,
    store,
    files as unknown as FileSyncService,
    host as unknown as RemoteHostClient,
    remoteOperations as unknown as RemoteOperationsService,
  );
});
afterEach(() => database.sqlite.close());

describe('share', () => {
  it('adds the entry with no patterns and starts the operation', async () => {
    const started = await service.share(vm, notes, []);
    expect(started.id).toBe('started');
    expect(remoteOperations.shareFolder).toHaveBeenCalledWith(vm, {
      path: notes,
      ignores: [],
    });
    expect(store.list(vm)).toEqual([
      expect.objectContaining({ id: shareId(notes), path: notes, patternsApplied: true }),
    ]);
  });

  it('keeps the written path when the home folder is a link', async () => {
    // Home `/home/u` → `/data/u`: the check returns the resolved path. Storing it would put the
    // share outside `homedir()` for the operation's preflight and at a different path on the VM.
    files.assertSharePath.mockResolvedValueOnce(join('/data', notes));
    await service.share(vm, notes, []);
    expect(remoteOperations.shareFolder).toHaveBeenCalledWith(
      vm,
      expect.objectContaining({ path: notes }),
    );
    expect(store.list(vm)).toEqual([expect.objectContaining({ path: notes })]);
  });

  it('checks the path against the shares of every VM', async () => {
    store.add(otherVm, join(root, 'photos'), []);
    await service.share(vm, notes, []);
    expect(files.assertSharePath).toHaveBeenCalledWith(notes, [join(root, 'photos')]);
  });

  it('refuses a double submit of the same path', async () => {
    const results = await Promise.allSettled([
      service.share(vm, notes, []),
      service.share(vm, notes, []),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(remoteOperations.shareFolder).toHaveBeenCalledTimes(1);
    expect(store.list()).toHaveLength(1);
  });

  it.each([
    ['a folder inside', join(notes, 'sub'), vm],
    ['the parent', root, vm],
    ['the same path for another VM', notes, otherVm],
  ])('refuses %s an existing share', async (_what, path, remoteId) => {
    await service.share(vm, notes, []);
    await expect(service.share(remoteId, path, [])).rejects.toMatchObject({
      code: 'SHARED_FOLDER_OVERLAP',
      statusCode: 409,
    });
  });

  it('refuses a folder missing on this PC', async () => {
    await expect(service.share(vm, join(root, 'missing'), [])).rejects.toMatchObject({
      code: 'SHARED_FOLDER_MISSING',
      statusCode: 404,
      message: expect.stringContaining('does not exist on this PC'),
    });
    expect(store.list()).toEqual([]);
  });

  it('passes on a refused path and keeps no entry', async () => {
    files.assertSharePath.mockRejectedValueOnce(
      new AppError(
        'Cannot share: it overlaps a project folder',
        'FILE_SYNC_SHARE_PATH_REFUSED',
        403,
      ),
    );
    await expect(service.share(vm, notes, [])).rejects.toMatchObject({
      code: 'FILE_SYNC_SHARE_PATH_REFUSED',
    });
    expect(store.list()).toEqual([]);
  });

  it('forgets the entry when the operation does not start', async () => {
    remoteOperations.shareFolder.mockRejectedValueOnce(new Error('VM has no address'));
    await expect(service.share(vm, notes, [])).rejects.toThrow('VM has no address');
    expect(store.list()).toEqual([]);
  });
});

describe('list', () => {
  beforeEach(() => store.add(vm, notes, []));
  const state = async () => (await service.list(vm))[0].state;

  it.each([
    ['sharing', operation({ state: 'running' }), { kind: 'sharing', operationId: 'op-1' }],
    [
      'failed',
      operation({
        state: 'failed',
        steps: [
          {
            id: 'copy',
            label: 'Copy',
            state: 'failed',
            startedAt: null,
            endedAt: null,
            error: { message: 'Copy stalled', code: null },
          },
        ],
      }),
      { kind: 'failed', operationId: 'op-1', message: 'Copy stalled' },
    ],
  ])('reports %s from the open operation', async (_kind, open, expected) => {
    operations = [open];
    expect(await state()).toEqual(expected);
    expect(host.syncStatus).not.toHaveBeenCalled();
  });

  it('ignores the operation of another share', async () => {
    operations = [operation({ details: { shareId: shareId(join(root, 'photos')) } })];
    expect(await state()).toEqual({ kind: 'in-sync' });
  });

  it('asks both sides for the share folder status', async () => {
    expect(await state()).toEqual({ kind: 'in-sync' });
    expect(host.syncStatus).toHaveBeenCalledWith(vm, shareFolderId(notes));
    expect(files.status).toHaveBeenCalledWith(shareFolderId(notes));
  });

  it.each([
    [
      'syncing',
      status({ needTotalItems: 2 }),
      status({ needTotalItems: 3 }),
      { kind: 'syncing', needItems: 5 },
    ],
    [
      'failing',
      status({
        errors: 2,
        fileErrors: [
          { path: 'a', error: 'permission denied' },
          { path: 'b', error: 'permission denied' },
        ],
      }),
      status({ needTotalItems: 1 }),
      { kind: 'failing', failedFiles: 2 },
    ],
    [
      'error',
      status(),
      status({ error: 'folder marker missing', needTotalItems: 1 }),
      { kind: 'error', message: 'VM: folder marker missing' },
    ],
  ])('reports %s', async (_kind, home, remote, expected) => {
    files.status.mockResolvedValueOnce(home);
    host.syncStatus.mockResolvedValueOnce(remote);
    expect(await state()).toEqual(expected);
  });

  it('reports vm-offline without asking an offline VM', async () => {
    online = false;
    expect(await state()).toEqual({ kind: 'vm-offline' });
    expect(host.syncStatus).not.toHaveBeenCalled();
  });

  it.each<[string, Error | null, Error | null, object]>([
    ['vm-offline when the VM does not answer', hostError(null), null, { kind: 'vm-offline' }],
    ['not-on-vm when the VM has no such folder', hostError(404), null, { kind: 'not-on-vm' }],
    [
      'an error when this PC has no such folder',
      null,
      new SyncthingRestError('missing', { path: '/rest/db/status', status: 404 }),
      { kind: 'error', message: 'The folder is not shared on this PC.' },
    ],
  ])('reports %s', async (_case, vmFailure, homeFailure, expected) => {
    if (vmFailure) host.syncStatus.mockRejectedValueOnce(vmFailure);
    if (homeFailure) files.status.mockRejectedValueOnce(homeFailure);
    expect(await state()).toEqual(expected);
  });

  it('lists only the shares of the VM', async () => {
    store.add(otherVm, join(root, 'photos'), []);
    expect((await service.list(vm)).map((item) => item.path)).toEqual([notes]);
  });
});

describe('stop', () => {
  let id: string;
  beforeEach(() => {
    id = store.add(vm, notes, []).id;
  });

  it('removes the share on the VM, then here, then the entry', async () => {
    const order: string[] = [];
    host.syncRemoveFolder.mockImplementationOnce(async () => void order.push('vm'));
    files.removeFolder.mockImplementationOnce(async () => void order.push('home'));
    expect(await service.stop(vm, id)).toMatchObject({ vmRemoved: true });
    expect(order).toEqual(['vm', 'home']);
    expect(host.syncRemoveFolder).toHaveBeenCalledWith(vm, shareFolderId(notes));
    expect(store.list()).toEqual([]);
  });

  it('removes the home share and the entry when the VM does not answer, and says so', async () => {
    host.syncRemoveFolder.mockRejectedValueOnce(hostError(null));
    expect(await service.stop(vm, id)).toEqual({
      vmRemoved: false,
      message: expect.stringContaining('The VM did not answer'),
    });
    expect(files.removeFolder).toHaveBeenCalledWith(shareFolderId(notes));
    expect(store.list()).toEqual([]);
  });

  it('keeps everything when the VM answers with an error', async () => {
    host.syncRemoveFolder.mockRejectedValueOnce(hostError(500));
    await expect(service.stop(vm, id)).rejects.toBeInstanceOf(RemoteHostRequestError);
    expect(files.removeFolder).not.toHaveBeenCalled();
    expect(store.list()).toHaveLength(1);
  });

  it.each(['running', 'failed'] as const)('refuses while the operation is %s', async (state) => {
    operations = [operation({ state })];
    await expect(service.stop(vm, id)).rejects.toMatchObject({ statusCode: 409 });
    expect(host.syncRemoveFolder).not.toHaveBeenCalled();
  });

  it('answers 404 for a share of another VM', async () => {
    await expect(service.stop(otherVm, id)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('updateIgnores', () => {
  let id: string;
  beforeEach(() => {
    id = store.add(vm, notes, []).id;
  });

  it('applies the patterns on the VM, then here', async () => {
    const entry = await service.updateIgnores(vm, id, ['*.tmp']);
    expect(entry).toMatchObject({ ignores: ['*.tmp'], patternsApplied: true });
    expect(host.syncShareIgnores).toHaveBeenCalledWith(vm, shareFolderId(notes), ['*.tmp']);
    expect(files.updateFolder).toHaveBeenCalledWith(shareFolderId(notes), { ignores: ['*.tmp'] });
    expect(host.syncShareIgnores.mock.invocationCallOrder[0]).toBeLessThan(
      files.updateFolder.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['the VM', 'vm', () => host.syncShareIgnores.mockRejectedValueOnce(hostError(null))],
    [
      'this PC',
      'home',
      () => files.updateFolder.mockRejectedValueOnce(new Error('Syncthing down')),
    ],
  ])(
    'keeps the list unapplied when %s fails, and Save again fixes it',
    async (_side, side, fail) => {
      fail();
      await expect(service.updateIgnores(vm, id, ['*.tmp'])).rejects.toMatchObject({
        code: 'SHARED_FOLDER_PATTERNS_NOT_APPLIED',
        statusCode: 503,
        details: { side, retryable: true },
      });
      expect(store.get(vm, id)).toMatchObject({ ignores: ['*.tmp'], patternsApplied: false });
      expect((await service.list(vm))[0].patternsApplied).toBe(false);

      await service.updateIgnores(vm, id, ['*.tmp']);
      expect(store.get(vm, id).patternsApplied).toBe(true);
    },
  );

  it('refuses while the operation is open', async () => {
    operations = [operation({ state: 'running' })];
    await expect(service.updateIgnores(vm, id, ['*.tmp'])).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(store.get(vm, id).ignores).toEqual([]);
  });
});

describe('store', () => {
  it('serves the operation port: every path, and remove by VM and path', () => {
    store.add(vm, notes, []);
    store.add(otherVm, join(root, 'photos'), []);
    expect(store.sharedPaths().sort()).toEqual([notes, join(root, 'photos')].sort());
    store.remove(otherVm, notes);
    expect(store.list()).toHaveLength(2);
    store.remove(vm, `${notes}/`);
    expect(store.sharedPaths()).toEqual([join(root, 'photos')]);
  });

  it('skips malformed entries and survives broken JSON', () => {
    database.sqlite
      .prepare(
        'INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('s', 'remotes.sharedFolders', 'broken-json', '', '');
    expect(store.list()).toEqual([]);
    expect(store.add(vm, notes, []).path).toBe(notes);
  });
});

describe('Connect overlap', () => {
  it.each([
    ['is the shared folder', notes, true],
    ['sits inside it', join(notes, 'sub'), true],
    ['contains it', root, true],
    ['sits beside it', join(root, 'photos'), false],
  ])('refuses a project whose root %s, for a share of any VM', async (_case, rootPath, refused) => {
    store.add(otherVm, notes, []);
    const lifecycle = new SharedFoldersLifecycle(
      { getRemote: async (id: string) => ({ id, name: 'vm-b' }) } as unknown as RemoteStorage,
      store,
      { folderPath: async () => rootPath } as unknown as FileSyncService,
    );
    const check = lifecycle.assertProjectOutsideShares('p1');
    if (refused)
      await expect(check).rejects.toMatchObject({
        code: 'PROJECT_OVERLAPS_SHARED_FOLDER',
        message: expect.stringContaining(`${notes}, which is shared with the VM vm-b`),
      });
    else await expect(check).resolves.toBeUndefined();
  });
});
