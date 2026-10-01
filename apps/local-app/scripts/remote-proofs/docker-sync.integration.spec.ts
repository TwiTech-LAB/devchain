/** Real two-instance integration is needed to verify ignore persistence and direction changes. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { seedRemoteProject } from '../../src/common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
  type TestInstance,
} from '../../src/common/test/two-instance.fixture';
import {
  FILE_SYNC_PATHS,
  createProductionFileSyncPaths,
  type FileSyncPaths,
} from '../../src/modules/file-sync/file-sync-paths';
import { FileSyncManagedExclusionsStore } from '../../src/modules/file-sync/file-sync-managed-exclusions.store';
import { FileSyncHandoff } from '../../src/modules/remotes/operations/file-sync-handoff';
import { FileSyncService } from '../../src/modules/file-sync/file-sync.service';
import { SyncthingManager } from '../../src/modules/file-sync/syncthing-manager.service';
import { ensureProvider } from '../../src/modules/remotes/replica/__fixtures__/replica-seed';
import type { RemoteOperation } from '../../src/modules/storage/models/domain.models';

jest.setTimeout(180_000);

describe('Docker data exclusions with isolated DevChain instances', () => {
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
  const patterns = ['/state/db', '/manual-data'];
  /** The managed exclusions live in the home settings store, never in `getIgnores`. */
  function managed(patternList: string[] | null = patterns) {
    pair.home.app.get(FileSyncManagedExclusionsStore).set(projectId, patternList);
  }
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
    }, 90_000);
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
    remoteId = (await pair.registerRemote('docker-proof')).id;
    await waitForValue(
      async () => [pair.home, pair.host].every((i) => i.app.get(SyncthingManager).getConnection()),
      30_000,
    );
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await pair?.close();
  });
  it('excludes before first scan and live sync, survives both app restarts, and keeps home data on disconnect', async () => {
    write(code(pair.home, 'state/code.txt'), 'code');
    write(code(pair.home, 'state/db/rows'), 'home-data');
    write(code(pair.home, 'manual-data/rows'), 'manual-home');
    managed();
    await operation('attach');
    expect(existsSync(code(pair.host, 'state/db/rows'))).toBe(false);
    expect(existsSync(code(pair.host, 'manual-data/rows'))).toBe(false);
    expect(readFileSync(code(pair.host, 'state/code.txt'), 'utf8')).toBe('code');
    write(code(pair.host, 'state/db/rows'), 'vm-data');
    write(code(pair.host, 'manual-data/rows'), 'manual-vm');
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
    await waitForValue(async () => (await sync(pair.host).status(id())).state === 'idle', 30_000);
    await operation('detach');
    expect(readFileSync(code(pair.home, 'state/db/rows'), 'utf8')).toBe('home-data');
    expect(readFileSync(code(pair.home, 'manual-data/rows'), 'utf8')).toBe('manual-home');
    for (const rel of ['', 'state'])
      expect(statSync(code(pair.host, rel)).uid).toBe(process.getuid!());
  });
  it('a second connect without managed exclusions replaces old ignores and syncs the data', async () => {
    managed(null);
    await operation('attach');
    expect(readFileSync(code(pair.host, 'state/db/rows'), 'utf8')).toBe('home-data');
    expect(readFileSync(code(pair.host, 'manual-data/rows'), 'utf8')).toBe('manual-home');
    await operation('detach');
  });
  it('changes bind choices and cancels after initial sync without copying excluded data home', async () => {
    const service = sync(pair.home);
    service.setIgnores(projectId, ['/manual-data', ...service.getIgnores(projectId)]);
    write(code(pair.home, 'state/db/rows'), 'changed-home');
    write(code(pair.host, 'manual-data/rows'), 'kept-vm');
    const handoff = pair.home.app.get(FileSyncHandoff);
    const initial = handoff.initial.bind(handoff);
    const fail = jest.spyOn(handoff, 'initial').mockImplementation(async (...args) => {
      await initial(...args);
      throw new Error('synthetic failure after initial sync');
    });
    await expect(operation('attach')).rejects.toThrow('synthetic failure');
    expect(readFileSync(code(pair.host, 'state/db/rows'), 'utf8')).toBe('changed-home');
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
    expect(readFileSync(code(pair.home, 'manual-data/rows'), 'utf8')).toBe('manual-home');
    for (const instance of [pair.home, pair.host]) {
      const client = instance.app.get(SyncthingManager).getConnection()!.client;
      const folders = (await client.request('GET', '/rest/config/folders')) as { id: string }[];
      expect(folders.some((folder) => folder.id === id())).toBe(false);
    }
    fail.mockRestore();
  });
});
