// Real Syncthing on both apps is the only layer that shows an orphan VM index surviving a new
// share; the remove-first copy must replace VM-only and VM-newer files and back them up.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, relative } from 'node:path';
import { isSyncthingMarker } from '../../../common/constants/syncthing-markers';
import { resetEnvConfig } from '../../../common/config/env.config';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { shareFolderId, shareId } from '../../file-sync/share-paths';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import type { SyncthingRestClient } from '../../file-sync/syncthing-rest.client';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { StopSharingResult } from '../shared-folders/shared-folders.dto';
import { RemoteHostClient, RemoteHostRequestError } from './remote-host.client';
import type { ShareFolderOperationDetails } from './share-folder.operation';

let binary = process.env.SYNCTHING_BIN;
try {
  binary ??= execFileSync('which', ['syncthing'], { encoding: 'utf8' }).trim();
  if (!/^syncthing v2\./.test(execFileSync(binary, ['--version'], { encoding: 'utf8' })))
    binary = undefined;
} catch {
  binary = undefined;
}
if (!binary)
  console.warn('Share folder proof: skipped (set SYNCTHING_BIN or put Syncthing v2 on PATH)');
const real = binary ? describe : describe.skip;
jest.setTimeout(180_000);

function contents(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (isSyncthingMarker(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return files;
}
/** The file's text, or null while a sync replaces it. */
const readSynced = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

real('Share folder through two DevChain apps and private Syncthing peers', () => {
  const savedBinary = process.env.SYNCTHING_BIN;
  let pair: TwoInstances;
  let remoteId: string;
  let home: FileSyncService;
  let vm: FileSyncService;
  /** The shared path as both sides name it: this PC's folder. */
  let sharedPath: string;
  /** Where the VM keeps the folder: both apps run on one machine, so its disk is elsewhere. */
  let vmFolder: string;
  let homeTranslation: jest.SpyInstance;
  let vmTranslation: jest.SpyInstance;
  const folderId = () => shareFolderId(sharedPath);

  function syncthing(instance: TestInstance): SyncthingRestClient {
    return instance.app.get(SyncthingManager).getConnection()!.client;
  }
  async function configuration(instance: TestInstance) {
    return syncthing(instance).request(
      'GET',
      `/rest/config/folders/${encodeURIComponent(folderId())}`,
    ) as Promise<{
      type: string;
      paused: boolean;
      maxConflicts: number;
      versioning: { type: string };
    }>;
  }
  async function operation(id: string): Promise<RemoteOperation> {
    return waitForValue(async () => {
      const response = await pair.home.app.inject({
        method: 'GET',
        url: `/api/remotes/operations/${id}`,
      });
      expect(response.statusCode).toBe(200);
      const row = response.json<RemoteOperation>();
      if (row.state === 'failed' || row.state === 'cancelled')
        throw new Error(JSON.stringify({ details: row.details, steps: row.steps }));
      return row.state === 'done' ? row : null;
    }, 120_000);
  }
  async function share(): Promise<RemoteOperation> {
    const response = await pair.home.app.inject({
      method: 'POST',
      url: `/api/remotes/${remoteId}/shared-folders`,
      payload: { path: sharedPath, ignores: [] },
    });
    expect(response.statusCode).toBe(202);
    return operation(response.json<RemoteOperation>().id);
  }
  async function inSync(): Promise<void> {
    await waitForValue(async () => {
      const statuses = await Promise.all([home.status(folderId()), vm.status(folderId())]);
      return statuses.every(
        (status) => status.state === 'idle' && status.needTotalItems === 0 && !status.error,
      );
    }, 60_000);
  }

  beforeAll(async () => {
    process.env.SYNCTHING_BIN = binary!;
    resetEnvConfig();
    pair = await startTwoInstances({
      syncIntervalMs: 200,
      fileSyncPaths: (side, dir) => ({
        syncthingHome: () => join(dir, 'syncthing'),
        codeFolder: (project) => join(dir, 'projects', project.id),
      }),
    });
    const userHome = join(pair.rootDir, 'user-home');
    sharedPath = join(userHome, 'notes');
    vmFolder = join(pair.rootDir, 'vm-disk', 'notes');
    mkdirSync(sharedPath, { recursive: true });
    mkdirSync(vmFolder, { recursive: true });
    homeTranslation = jest.spyOn(os, 'homedir').mockReturnValue(userHome);
    home = pair.home.app.get(FileSyncService);
    vm = pair.host.app.get(FileSyncService);
    remoteId = (await pair.registerRemote('Share folder VM')).id;
    await waitForValue(async () => {
      const list = await pair.home.app.inject({ method: 'GET', url: '/api/remotes' });
      return (
        list
          .json<{ items: { id: string; online: boolean }[] }>()
          .items.some((remote) => remote.id === remoteId && remote.online) &&
        [pair.home, pair.host].every((instance) =>
          instance.app.get(SyncthingManager).getConnection(),
        )
      );
    }, 30_000);
    // The VM checks and names the folder by the shared path; only its Syncthing record points
    // at the VM's own disk.
    const vmSyncthing = syncthing(pair.host);
    const request = vmSyncthing.request.bind(vmSyncthing);
    vmTranslation = jest
      .spyOn(vmSyncthing, 'request')
      .mockImplementation((method, path, body, ...rest) =>
        request(
          method,
          path,
          method === 'PUT' &&
            path.startsWith('/rest/config/folders/share') &&
            (body as { path?: string }).path === sharedPath
            ? { ...(body as object), path: vmFolder }
            : body,
          ...rest,
        ),
      );
  }, 60_000);

  afterAll(async () => {
    try {
      await pair?.close();
    } finally {
      vmTranslation?.mockRestore();
      homeTranslation?.mockRestore();
      if (savedBinary === undefined) delete process.env.SYNCTHING_BIN;
      else process.env.SYNCTHING_BIN = savedBinary;
      resetEnvConfig();
    }
  }, 60_000);

  it('replaces an orphan VM index with this PC’s files, backs up the VM files and syncs two ways', async () => {
    writeFileSync(join(sharedPath, 'shared.txt'), 'PC version\n');
    writeFileSync(join(sharedPath, 'stable.txt'), 'unchanged\n');
    await share();
    await inSync();
    expect(contents(vmFolder)).toEqual(contents(sharedPath));

    // Stop sharing while the VM does not answer: the VM keeps its folder and its index.
    const client = pair.home.app.get(RemoteHostClient);
    const unreachable = jest.spyOn(client, 'syncRemoveFolder').mockRejectedValueOnce(
      new RemoteHostRequestError('VM is unreachable', {
        remoteId,
        path: '/api/host/sync/folders',
        status: null,
        hostCode: null,
      }),
    );
    try {
      const stop = await pair.home.app.inject({
        method: 'DELETE',
        url: `/api/remotes/${remoteId}/shared-folders/${shareId(sharedPath)}`,
      });
      expect(stop.statusCode).toBe(200);
      expect(stop.json<StopSharingResult>().vmRemoved).toBe(false);
    } finally {
      unreachable.mockRestore();
    }
    expect((await configuration(pair.host)).type).toBe('sendreceive');

    // The VM's index now holds a VM-only file and a VM-newer version of a shared file.
    writeFileSync(join(vmFolder, 'vm-only.txt'), 'VM-only file\n');
    writeFileSync(join(vmFolder, 'shared.txt'), 'VM newer version\n');
    await vm.rescan(folderId());

    const done = await share();
    const details = (done.details as unknown as ShareFolderOperationDetails).shareFolder!;
    expect(details.verified).toBe(true);
    expect(contents(vmFolder)).toEqual(contents(sharedPath));
    expect(existsSync(join(vmFolder, 'vm-only.txt'))).toBe(false);
    expect(readFileSync(join(vmFolder, 'shared.txt'), 'utf8')).toBe('PC version\n');

    const backup = Object.values(contents(details.backupPath!));
    expect(backup).toContain('VM-only file\n');
    expect(backup).toContain('VM newer version\n');

    for (const instance of [pair.home, pair.host])
      expect(await configuration(instance)).toMatchObject({
        type: 'sendreceive',
        paused: false,
        maxConflicts: 10,
        versioning: { type: '' },
      });

    writeFileSync(join(vmFolder, 'stable.txt'), 'VM edit after sharing\n');
    await vm.rescan(folderId());
    await waitForValue(
      async () => readSynced(join(sharedPath, 'stable.txt')) === 'VM edit after sharing\n',
      30_000,
    );
  });
});
