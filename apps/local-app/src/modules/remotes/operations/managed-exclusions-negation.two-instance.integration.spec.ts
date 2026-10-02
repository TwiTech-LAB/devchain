/**
 * Real Syncthing is needed to verify first-match precedence for bare-directory
 * and glob exclusions against user negations across first, live and final sync.
 * The two apps and their Syncthing processes use isolated temporary directories.
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
if (!binary) {
  console.warn(
    'managed exclusion negation regression: skipped (set SYNCTHING_BIN or put Syncthing v2 on PATH)',
  );
}

jest.setTimeout(180_000);

describeWithBinary('managed exclusions take precedence over user negations', () => {
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
    await waitForValue(async () => {
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
    remoteId = (await pair.registerRemote('negation-regression')).id;
    await waitForValue(
      async () => [pair.home, pair.host].every((i) => i.app.get(SyncthingManager).getConnection()),
      30_000,
    );
  });

  afterAll(async () => {
    await pair?.close();
  });

  it('protects bare directories and globs during first, live and final sync despite user negations', async () => {
    const userIgnores = ['!/state/db/**', '!/uploads/**', ...DEFAULT_FILE_SYNC_IGNORES];
    pair.home.app.get(FileSyncService).setIgnores(projectId, userIgnores);
    pair.home.app.get(FileSyncManagedExclusionsStore).set(projectId, ['/state/db', '/uploads/**']);
    write(code(pair.home, 'state/code.txt'), 'code');
    write(code(pair.home, 'state/db/rows'), 'home-data');
    write(code(pair.home, 'uploads/blob'), 'home-upload');

    await operation('attach');

    expect(readFileSync(code(pair.host, 'state/code.txt'), 'utf8')).toBe('code');
    expect(existsSync(code(pair.host, 'state/db/rows'))).toBe(false);
    expect(existsSync(code(pair.host, 'uploads/blob'))).toBe(false);

    await pair.restartHome();
    await pair.restartHost();
    await waitForValue(
      async () => [pair.home, pair.host].every((i) => i.app.get(SyncthingManager).getConnection()),
      30_000,
    );
    write(code(pair.host, 'state/db/rows'), 'vm-live-data');
    write(code(pair.host, 'uploads/blob'), 'vm-live-upload');
    write(code(pair.host, 'live.txt'), 'live');
    const hostSync = pair.host.app.get(FileSyncService);
    const folderId = `code:${projectId}`;
    await hostSync.rescan(folderId);
    await waitForValue(async () => existsSync(code(pair.home, 'live.txt')), 30_000);
    await waitForValue(async () => (await hostSync.status(folderId)).state === 'idle', 30_000);
    expect(readFileSync(code(pair.home, 'state/db/rows'), 'utf8')).toBe('home-data');
    expect(readFileSync(code(pair.home, 'uploads/blob'), 'utf8')).toBe('home-upload');

    // Pause both sides so only Disconnect's final sync can deliver these edits.
    for (const instance of [pair.home, pair.host]) {
      await instance.app.get(FileSyncService).updateFolder(folderId, { paused: true });
    }
    write(code(pair.host, 'state/db/rows'), 'vm-final-data');
    write(code(pair.host, 'uploads/blob'), 'vm-final-upload');
    write(code(pair.host, 'final.txt'), 'final');
    await operation('detach');

    expect(readFileSync(code(pair.home, 'final.txt'), 'utf8')).toBe('final');
    expect(readFileSync(code(pair.home, 'state/db/rows'), 'utf8')).toBe('home-data');
    expect(readFileSync(code(pair.home, 'uploads/blob'), 'utf8')).toBe('home-upload');
    const response = await fetch(`${pair.home.url}/api/file-sync/projects/${projectId}/ignores`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ignores: userIgnores });
    expect(pair.home.app.get(FileSyncManagedExclusionsStore).get(projectId)).toEqual([
      '/state/db',
      '/uploads/**',
    ]);
  });
});
