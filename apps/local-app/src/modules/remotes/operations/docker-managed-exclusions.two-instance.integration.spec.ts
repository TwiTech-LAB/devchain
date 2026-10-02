/**
 * Managed Docker exclusions and the import inventory across real connect and
 * disconnect cycles between two booted DevChain apps, each running its own
 * Syncthing: the excluded in-project data folders stay out of the first sync
 * and live sync, survive app restarts on both sides, are recomputed when the
 * selection changes or empties, are cleared by an attach rollback, and never
 * appear in the user's editable ignore list. The Docker import inventory
 * survives unbind keyed by (projectId, remoteId). Test layer: two-instance
 * integration with real Syncthing. Runs when SYNCTHING_BIN or PATH provides
 * Syncthing v2 and is skipped, with the reason in its title, otherwise.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { seedRemoteProject } from '../../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import {
  FILE_SYNC_PATHS,
  createProductionFileSyncPaths,
  type FileSyncPaths,
} from '../../file-sync/file-sync-paths';
import { DEFAULT_FILE_SYNC_IGNORES } from '../../file-sync/file-sync-ignores.store';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { ensureProvider } from '../replica/__fixtures__/replica-seed';
import { DockerImportInventoryStore } from './docker-import-inventory.store';
import { FileSyncHandoff } from './file-sync-handoff';
import type { RemoteOperation } from '../../storage/models/domain.models';

function findBinary(): string | null {
  if (process.env.SYNCTHING_BIN) return process.env.SYNCTHING_BIN;
  try {
    return execFileSync('which', ['syncthing'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const binary = findBinary();
const describeWithBinary = binary ? describe : describe.skip;
const SKIP_REASON = 'set SYNCTHING_BIN or put Syncthing v2 on PATH';
if (!binary) {
  console.warn(`managed exclusions across two instances: skipped (${SKIP_REASON})`);
}

jest.setTimeout(300_000);

describeWithBinary('managed Docker exclusions with two DevChain instances', () => {
  let pair: TwoInstances;
  let projectId: string;
  let remoteId: string;
  const code = (instance: TestInstance, rel = '') =>
    join(
      instance.app
        .get<FileSyncPaths>(FILE_SYNC_PATHS)
        .codeFolder({ id: projectId, rootPath: '/unused' }),
      rel,
    );
  const write = (file: string, value: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  const sync = (instance: TestInstance) => instance.app.get(FileSyncService);
  const id = () => `code:${projectId}`;
  const managedExclusions = () => pair.home.app.get(FileSyncManagedExclusionsStore);

  async function operation(kind: 'attach' | 'detach') {
    await waitForValue(async () => {
      const list = (await (await fetch(`${pair.home.url}/api/remotes`)).json()) as {
        items: { id: string; online: boolean }[];
      };
      return list.items.find((r) => r.id === remoteId)?.online;
    }, 30_000);
    const response = await fetch(`${pair.home.url}/api/remotes/${remoteId}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId }),
    });
    expect(response.status).toBe(202);
    const started = (await response.json()) as RemoteOperation;
    return waitForValue(async () => {
      const result = (await (
        await fetch(`${pair.home.url}/api/remotes/operations/${started.id}`)
      ).json()) as RemoteOperation;
      if (result.state === 'failed') throw new Error(JSON.stringify(result.steps));
      return result.state === 'done' ? result : null;
    }, 120_000);
  }

  beforeAll(async () => {
    pair = await startTwoInstances({
      fileSyncPaths: (_name, dir) => ({
        ...createProductionFileSyncPaths(join(dir, 'home')),
        syncthingHome: () => join(dir, 'syncthing'),
        codeFolder: (project) => join(dir, 'projects', project.id),
      }),
    });
    const seed = seedRemoteProject(pair.home.sqlite);
    projectId = seed.projectId;
    ensureProvider(pair.host.sqlite, 'host-claude', seed.providerName, null);
    remoteId = (await pair.registerRemote('managed-exclusions')).id;
    await waitForValue(
      async () => [pair.home, pair.host].every((i) => i.app.get(SyncthingManager).getConnection()),
      30_000,
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await pair?.close();
  });

  it('excludes before the first scan and live sync, survives both restarts, keeps home data on disconnect, and stays out of the user ignore list', async () => {
    write(code(pair.home, 'state/code.txt'), 'code');
    write(code(pair.home, 'state/db/rows'), 'home-data');
    write(code(pair.home, 'manual-data/rows'), 'manual-home');
    managedExclusions().set(projectId, ['/state/db', '/manual-data']);
    await operation('attach');

    expect(existsSync(code(pair.host, 'state/db/rows'))).toBe(false);
    expect(existsSync(code(pair.host, 'manual-data/rows'))).toBe(false);
    expect(readFileSync(code(pair.host, 'state/code.txt'), 'utf8')).toBe('code');

    write(code(pair.host, 'state/db/rows'), 'vm-data');
    await pair.restartHome();
    await pair.restartHost();
    await waitForValue(
      async () => [pair.home, pair.host].every((i) => i.app.get(SyncthingManager).getConnection()),
      30_000,
    );

    write(code(pair.host, 'live.txt'), 'live');
    await sync(pair.host).rescan(id());
    await waitForValue(async () => existsSync(code(pair.home, 'live.txt')), 30_000);
    expect(readFileSync(code(pair.home, 'state/db/rows'), 'utf8')).toBe('home-data');
    expect(managedExclusions().get(projectId)).toEqual(['/state/db', '/manual-data']);

    const ignores = (await (
      await fetch(`${pair.home.url}/api/file-sync/projects/${projectId}/ignores`)
    ).json()) as { ignores: string[] };
    expect(ignores.ignores).toEqual([...DEFAULT_FILE_SYNC_IGNORES]);

    await waitForValue(async () => (await sync(pair.host).status(id())).state === 'idle', 30_000);

    pair.home.app.get(DockerImportInventoryStore).set(projectId, remoteId, {
      items: [
        {
          name: 'web',
          imageId: 'sha256:5f1c7b',
          volumes: [{ name: 'web-data', sizeBytes: 4096 }],
          bindPaths: ['/state/db'],
          sizeBytes: 4096,
        },
      ],
      importedAt: new Date().toISOString(),
    });
    await operation('detach');

    expect(readFileSync(code(pair.home, 'state/db/rows'), 'utf8')).toBe('home-data');
    expect(readFileSync(code(pair.home, 'manual-data/rows'), 'utf8')).toBe('manual-home');
    expect(managedExclusions().get(projectId)).toEqual(['/state/db', '/manual-data']);
    const inventory = pair.home.app.get(DockerImportInventoryStore);
    expect(inventory.get(projectId, remoteId)).toMatchObject({
      items: [{ name: 'web', bindPaths: ['/state/db'] }],
    });
    expect(inventory.get(projectId, 'never-registered')).toBeNull();
  });

  it('recomputes the exclusions when the selection changes on the next connect', async () => {
    managedExclusions().set(projectId, ['/state/db']);
    write(code(pair.home, 'manual-data/rows'), 'manual-home-2');
    await operation('attach');

    expect(readFileSync(code(pair.host, 'manual-data/rows'), 'utf8')).toBe('manual-home-2');
    write(code(pair.host, 'state/db/rows'), 'vm-2');
    await sync(pair.host).rescan(id());
    await waitForValue(async () => (await sync(pair.host).status(id())).state === 'idle', 30_000);
    expect(readFileSync(code(pair.home, 'state/db/rows'), 'utf8')).toBe('home-data');

    await operation('detach');
  });

  it('syncs the data folders again once the selection is empty', async () => {
    managedExclusions().set(projectId, null);
    await operation('attach');

    expect(readFileSync(code(pair.host, 'state/db/rows'), 'utf8')).toBe('home-data');

    await operation('detach');
  });

  it('keeps exclusions the cancelled attempt did not change, without copying excluded data home', async () => {
    managedExclusions().set(projectId, ['/manual-data']);
    write(code(pair.host, 'manual-data/rows'), 'kept-vm');
    const handoff = pair.home.app.get(FileSyncHandoff);
    const initial = handoff.initial.bind(handoff);
    const fail = jest.spyOn(handoff, 'initial').mockImplementation(async (...args) => {
      await initial(...args);
      throw new Error('synthetic failure after initial sync');
    });

    await expect(operation('attach')).rejects.toThrow('synthetic failure');
    expect(readFileSync(code(pair.host, 'manual-data/rows'), 'utf8')).toBe('kept-vm');

    const list = (await (await fetch(`${pair.home.url}/api/remotes/operations`)).json()) as {
      items: RemoteOperation[];
    };
    const failed = list.items.find(
      (item) => item.projectId === projectId && item.state === 'failed',
    )!;
    expect(failed).toBeDefined();
    const cancelled = await fetch(`${pair.home.url}/api/remotes/operations/${failed.id}/cancel`, {
      method: 'POST',
    });
    expect(cancelled.status).toBe(200);

    // An earlier import may own them; only an attempt that replaced the set restores it.
    expect(managedExclusions().get(projectId)).toEqual(['/manual-data']);
    expect(readFileSync(code(pair.home, 'manual-data/rows'), 'utf8')).toBe('manual-home-2');
    for (const instance of [pair.home, pair.host]) {
      const client = instance.app.get(SyncthingManager).getConnection()!.client;
      const folders = (await client.request('GET', '/rest/config/folders')) as { id: string }[];
      expect(folders.some((folder) => folder.id === id())).toBe(false);
    }
    fail.mockRestore();
  });
});
