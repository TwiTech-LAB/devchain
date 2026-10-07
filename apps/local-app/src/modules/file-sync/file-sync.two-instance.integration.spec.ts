/**
 * Connect and disconnect moving a project's code files
 * between two booted DevChain apps, each running its own Syncthing.
 * Test layer: two-instance integration with real Syncthing. Direction flips,
 * completion gates and receive-only reverts only prove themselves between two
 * real Syncthing processes. Runs when SYNCTHING_BIN or PATH provides Syncthing
 * v2 and is skipped, with the reason in its title, otherwise.
 */
import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { hostname } from 'os';
import { dirname, join, relative } from 'path';
import { resetEnvConfig } from '../../common/config/env.config';
import {
  seedRemoteProject,
  type SeededRemoteProject,
} from '../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { ensureProvider } from '../remotes/replica/__fixtures__/replica-seed';
import { FileSyncHandoff } from '../remotes/operations/file-sync-handoff';
import { RemoteFileSyncService } from '../remotes/sync/remote-file-sync.service';
import { RemoteBindingsService } from '../remotes/services/remote-bindings.service';
import { GitOwnerStore } from '../remotes/git-owner.store';
import { RemoteLiveSyncService } from '../remotes/sync/remote-live-sync.service';
import { HomeGitGuardService } from './home-git-guard.service';
import type { Remote, RemoteOperation } from '../storage/models/domain.models';
import {
  FILE_SYNC_PATHS,
  createProductionFileSyncPaths,
  type FileSyncPaths,
} from './file-sync-paths';
import { FileSyncService } from './file-sync.service';
import { RemoteNeedSchema } from './file-sync.dto';
import { SyncthingManager } from './syncthing-manager.service';

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
  // Jest does not print a skipped suite's title, so the reason is logged.
  console.warn(`file sync across two instances: skipped (${SKIP_REASON})`);
}

jest.setTimeout(120_000);

/** Each instance gets its own Syncthing home and checkout. */
function pathsFor(dataDir: string): FileSyncPaths {
  return {
    ...createProductionFileSyncPaths(join(dataDir, 'home')),
    syncthingHome: () => join(dataDir, 'syncthing'),
    codeFolder: (project) => join(dataDir, 'projects', project.id),
  };
}

/** PIDs of the Syncthing processes (monitor and worker) serving `home`. */
function syncthingPids(home: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', '--', `--home=${home}`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function listFiles(root: string, skip: (name: string) => boolean = () => false): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(root, path));
    }
  };
  walk(root);
  return files.sort();
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describeWithBinary(
  `file sync across two instances${binary ? '' : ` (skipped: ${SKIP_REASON})`}`,
  () => {
    const savedBin = process.env.SYNCTHING_BIN;
    let instances: TwoInstances;
    let remote: Remote;
    let seed: SeededRemoteProject;
    let syncthingHomes: string[] = [];
    let rootDir: string;

    const project = () => ({ id: seed.projectId, rootPath: `/tmp/${seed.projectId}` });
    const paths = (instance: TestInstance) => instance.app.get<FileSyncPaths>(FILE_SYNC_PATHS);
    const code = (instance: TestInstance, rel = '') =>
      join(paths(instance).codeFolder(project()), rel);
    const codeId = () => `code:${seed.projectId}`;
    const gitId = () => `git:${seed.projectId}`;
    const git = (instance: TestInstance, ...args: string[]) =>
      execFileSync(
        'git',
        [
          '-C',
          code(instance),
          '-c',
          'user.name=Sync Test',
          '-c',
          'user.email=sync@example.test',
          ...args,
        ],
        { encoding: 'utf8' },
      ).trim();

    async function folderConfig(instance: TestInstance, id: string) {
      const folder = (await instance.app
        .get(SyncthingManager)
        .getConnection()!
        .client.request('GET', `/rest/config/folders/${encodeURIComponent(id)}`)) as {
        type: string;
        paused: boolean;
      };
      return { type: folder.type, paused: folder.paused };
    }

    async function run(
      kind: 'attach' | 'detach',
      force = false,
      expected = 'done',
    ): Promise<RemoteOperation> {
      const started = await fetch(`${instances.home.url}/api/remotes/${remote.id}/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectId: seed.projectId,
          ...(kind === 'detach' ? { force } : {}),
        }),
      });
      expect(started.status).toBe(202);
      const { id } = (await started.json()) as RemoteOperation;
      return waitForValue(async () => {
        const response = await fetch(`${instances.home.url}/api/remotes/operations/${id}`);
        const operation = (await response.json()) as RemoteOperation;
        if (operation.state === 'failed' && expected !== 'failed') {
          throw new Error(`${kind} failed: ${JSON.stringify(operation.steps)}`);
        }
        return operation.state === expected ? operation : null;
      }, 60_000);
    }

    beforeAll(async () => {
      process.env.SYNCTHING_BIN = binary ?? '';
      resetEnvConfig();
      instances = await startTwoInstances({ fileSyncPaths: (_name, dataDir) => pathsFor(dataDir) });
      rootDir = instances.rootDir;
      seed = seedRemoteProject(instances.home.sqlite);
      ensureProvider(instances.host.sqlite, 'host-claude', seed.providerName, null);
      remote = await instances.registerRemote('vm-1');
      await waitForValue(
        async () =>
          [instances.home, instances.host].every(
            (instance) => instance.app.get(SyncthingManager).getConnection() !== null,
          ),
        30_000,
      );
      await waitForValue(async () => {
        const response = await fetch(`${instances.home.url}/api/remotes`);
        const list = (await response.json()) as { items: { id: string; online: boolean }[] };
        return list.items.find((item) => item.id === remote.id)?.online;
      }, 30_000);
      syncthingHomes = [instances.home, instances.host].map((i) => paths(i).syncthingHome());
    }, 60_000);

    afterAll(async () => {
      await instances?.close();
      if (savedBin === undefined) delete process.env.SYNCTHING_BIN;
      else process.env.SYNCTHING_BIN = savedBin;
      resetEnvConfig();
      // Nothing may outlive the run: both Syncthing processes and the temp root.
      for (const home of syncthingHomes) {
        await waitForValue(async () => syncthingPids(home).length === 0, 15_000, 100);
      }
      expect(existsSync(rootDir)).toBe(false);
    }, 60_000);

    afterEach(() => jest.restoreAllMocks());

    it('gives each instance its own Syncthing home, device and folder roots', () => {
      const { home, host } = instances;

      expect(paths(home).syncthingHome()).toBe(join(home.dataDir, 'syncthing'));
      expect(paths(host).syncthingHome()).toBe(join(host.dataDir, 'syncthing'));
      expect(code(home)).toBe(join(home.dataDir, 'projects', seed.projectId));
      expect(code(host)).toBe(join(host.dataDir, 'projects', seed.projectId));
      const [homeState, hostState] = [home, host].map((i) =>
        i.app.get(SyncthingManager).getState(),
      );
      expect(homeState.deviceId).not.toBe(hostState.deviceId);
      expect(homeState.apiPort).not.toBe(hostState.apiPort);
      for (const home of syncthingHomes) expect(syncthingPids(home).length).toBeGreaterThan(0);
    });

    it('syncs code both ways and Git from host, restores cancellation, and drains both copies on disconnect', async () => {
      const { home, host } = instances;
      const homeSync = home.app.get(FileSyncService);
      const isMarker = (name: string) =>
        ['.git', '.stfolder', '.stignore', '.stversions'].includes(name);

      // A checkout with nested directories, dependencies and a secret.
      write(code(home, 'src/app/main.ts'), 'export const owner = "home";\n');
      write(code(home, 'src/lib/deep/nested/util.ts'), 'export {};\n');
      write(code(home, 'packages/ui/package.json'), '{}\n');
      write(code(home, '.env'), 'API_KEY=local\n');
      write(code(home, 'node_modules/dep/index.js'), 'dependency\n');
      write(code(home, 'packages/ui/node_modules/dep/index.js'), 'dependency\n');
      write(code(home, 'dist/bundle.js'), 'built\n');

      git(home, 'init', '-b', 'main');
      git(home, 'add', 'src', 'packages/ui/package.json');
      git(home, 'commit', '-m', 'initial');
      write(code(home, '.git/hooks/synthetic-hook'), 'initial hook');

      // Ownership moves only once the remote holds home's files.
      const bindings = home.app.get(RemoteBindingsService);
      const update = bindings.update.bind(bindings);
      const atBind: (string | null)[] = [];
      jest.spyOn(bindings, 'update').mockImplementation(async (projectId, patch) => {
        if (patch.state === 'remote') {
          atBind.push(read(code(host, 'src/app/main.ts')));
        }
        return update(projectId, patch);
      });

      const attach = await run('attach');

      expect(atBind).toEqual(['export const owner = "home";\n']);
      expect(attach.details.fileSync).toMatchObject({
        folders: {
          [codeId()]: { completion: 100, needItems: 0, needBytes: 0 },
        },
      });
      expect(listFiles(code(host), isMarker)).toEqual([
        '.env',
        'packages/ui/package.json',
        'src/app/main.ts',
        'src/lib/deep/nested/util.ts',
      ]);
      for (const id of [codeId()]) {
        await expect(folderConfig(host, id)).resolves.toEqual({
          type: 'sendreceive',
          paused: false,
        });
        await expect(folderConfig(home, id)).resolves.toEqual({
          type: 'sendreceive',
          paused: false,
        });
      }

      // The remote writes; home receives only through Syncthing.
      write(code(host, 'src/app/remote.ts'), 'export const written = "on host";\n');
      expect(read(code(home, 'src/app/remote.ts'))).toBeNull();
      await waitForValue(
        async () => read(code(home, 'src/app/remote.ts')) === 'export const written = "on host";\n',
        30_000,
        100,
      );

      await expect(folderConfig(host, gitId())).resolves.toEqual({
        type: 'sendonly',
        paused: false,
      });
      await expect(folderConfig(home, gitId())).resolves.toEqual({
        type: 'receiveonly',
        paused: false,
      });
      expect(read(code(host, '.git/hooks/synthetic-hook'))).toBe('initial hook');
      git(host, 'add', 'src/app/remote.ts');
      git(host, 'commit', '-m', 'host commit');
      await waitForValue(
        async () => git(home, 'rev-parse', 'HEAD') === git(host, 'rev-parse', 'HEAD'),
        30_000,
      );

      write(code(home, 'src/app/home.ts'), 'written at home\n');
      await homeSync.rescan(codeId());
      await waitForValue(
        async () => read(code(host, 'src/app/home.ts')) === 'written at home\n',
        30_000,
      );

      const handoff = home.app.get(FileSyncHandoff);
      const flip = handoff.flipToHome.bind(handoff);
      jest.spyOn(handoff, 'flipToHome').mockImplementationOnce(async (...args) => {
        await flip(...args);
        throw new Error('lost response after flip');
      });
      const failed = await run('detach', false, 'failed');
      const cancelled = await fetch(`${home.url}/api/remotes/operations/${failed.id}/cancel`, {
        method: 'POST',
      });
      expect(cancelled.status).toBe(200);
      for (const instance of [home, host]) {
        await expect(folderConfig(instance, codeId())).resolves.toEqual({
          type: 'sendreceive',
          paused: false,
        });
      }
      await expect(folderConfig(host, gitId())).resolves.toEqual({
        type: 'sendonly',
        paused: false,
      });
      await expect(folderConfig(home, gitId())).resolves.toEqual({
        type: 'receiveonly',
        paused: false,
      });

      // Disconnect: home holds the remote's last changes before it owns the project again.
      write(code(host, 'src/app/main.ts'), 'export const owner = "host";\n');
      const remove = bindings.delete.bind(bindings);
      const atUnbind: (string | null)[] = [];
      jest.spyOn(bindings, 'delete').mockImplementation(async (projectId) => {
        atUnbind.push(read(code(home, 'src/app/main.ts')));
        return remove(projectId);
      });

      write(code(home, 'src/app/last-save.ts'), 'saved immediately before disconnect\n');
      await run('detach');
      expect(read(code(host, 'src/app/last-save.ts'))).toBe(
        'saved immediately before disconnect\n',
      );
      expect(read(code(home, 'src/app/last-save.ts'))).toBe(
        'saved immediately before disconnect\n',
      );

      expect(atUnbind).toEqual(['export const owner = "host";\n']);
      for (const id of [codeId(), gitId()]) {
        await expect(folderConfig(home, id)).resolves.toEqual({ type: 'sendonly', paused: true });
        await expect(folderConfig(host, id)).resolves.toEqual({
          type: 'receiveonly',
          paused: true,
        });
      }
    });

    // Only real Syncthing can prove retained indexes merge deletes and create conflict copies.
    it('brings disconnected VM edits home on reconnect and releases the VM Git guard', async () => {
      const { home, host } = instances;
      home.sqlite
        .prepare("UPDATE project_workspaces SET name = 'Connected handoff' WHERE id = ?")
        .run(seed.workspaceId);
      seed = seedRemoteProject(home.sqlite);

      for (const name of ['vm-edit.txt', 'vm-delete.txt', 'home-edit.txt', 'shared.txt']) {
        write(code(home, name), `initial ${name}\n`);
      }
      const initialTime = new Date(Date.now() - 120_000);
      utimesSync(code(home, 'shared.txt'), initialTime, initialTime);
      git(home, 'init', '-b', 'main');
      git(home, 'add', '.');
      git(home, 'commit', '-m', 'initial reconnect tree');
      await run('attach');
      const detached = await run('detach');
      expect(detached.details.vmGuardInstalled).toBe(true);
      const head = git(host, 'rev-parse', 'HEAD');
      const refused = spawnSync(
        'git',
        [
          '-C',
          code(host),
          '-c',
          'user.name=Sync Test',
          '-c',
          'user.email=sync@example.test',
          'commit',
          '--allow-empty',
          '-m',
          'refused while disconnected',
        ],
        { encoding: 'utf8' },
      );
      expect(refused.error).toBeUndefined();
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain(`This project is now on the PC '${hostname()}'.`);
      expect(refused.stderr).toContain(
        'At the next Connect, DevChain brings your edits to the PC.',
      );
      expect(refused.stderr).toContain(
        'are blocked here. Make them on the PC. To use Git on this VM, connect the project to it again from the PC.',
      );
      expect(git(host, 'rev-parse', 'HEAD')).toBe(head);

      write(code(host, 'vm-edit.txt'), 'edited on VM while disconnected\n');
      write(code(host, 'vm-added.txt'), 'added on VM while disconnected\n');
      unlinkSync(code(host, 'vm-delete.txt'));
      write(code(home, 'home-edit.txt'), 'edited at home while disconnected\n');
      write(code(host, 'shared.txt'), 'older VM version\n');
      write(code(home, 'shared.txt'), 'newer home version\n');
      // Distinct mtimes make Syncthing's winner independent of filesystem timestamp precision.
      const older = new Date(Date.now() - 60_000);
      const newer = new Date();
      utimesSync(code(host, 'shared.txt'), older, older);
      utimesSync(code(home, 'shared.txt'), newer, newer);

      const attached = await run('attach');

      for (const instance of [home, host]) {
        expect(read(code(instance, 'vm-edit.txt'))).toBe('edited on VM while disconnected\n');
        expect(read(code(instance, 'vm-added.txt'))).toBe('added on VM while disconnected\n');
        expect(read(code(instance, 'vm-delete.txt'))).toBeNull();
        expect(read(code(instance, 'home-edit.txt'))).toBe('edited at home while disconnected\n');
        expect(read(code(instance, 'shared.txt'))).toBe('newer home version\n');
      }
      const conflicts = readdirSync(code(home)).filter((name) =>
        /^shared\.sync-conflict-.*\.txt$/.test(name),
      );
      expect(conflicts).toHaveLength(1);
      expect(read(code(home, conflicts[0]))).toBe('older VM version\n');
      expect(attached.details).toMatchObject({
        fileSyncMode: 'merge',
        vmGuardRemoved: true,
        vmEdits: { total: 4, deleted: 1 },
        fileSyncConflicts: { total: 1, sample: conflicts },
        fileSync: {
          folders: { [codeId()]: { completion: 100, needItems: 0, needBytes: 0 } },
        },
      });
      const vmEdits = RemoteNeedSchema.parse(attached.details.vmEdits);
      expect(vmEdits.sample).toHaveLength(4);
      expect(vmEdits.sample).toEqual(
        expect.arrayContaining([
          { path: 'vm-edit.txt', deleted: false },
          { path: 'vm-added.txt', deleted: false },
          { path: 'vm-delete.txt', deleted: true },
          { path: 'shared.txt', deleted: false },
        ]),
      );
      for (const hook of ['reference-transaction', 'post-checkout']) {
        expect(existsSync(code(host, `.git/hooks/${hook}`))).toBe(false);
      }
      git(host, 'commit', '--allow-empty', '-m', 'VM owns Git after reconnect');
      expect(git(host, 'rev-parse', 'HEAD')).not.toBe(head);
      await run('detach');
    });

    // Real peers plus Git are needed to prove final transfer keeps both the owner's refs and index.
    it('disconnects PC-owned Git without losing its pending commit or staged changes', async () => {
      const { home, host } = instances;
      home.sqlite
        .prepare("UPDATE project_workspaces SET name = 'Previous PC ownership' WHERE id = ?")
        .run(seed.workspaceId);
      seed = seedRemoteProject(home.sqlite);
      ensureProvider(host.sqlite, 'host-claude', seed.providerName, null);
      write(code(home, 'file.txt'), 'baseline\n');
      git(home, 'init', '-b', 'main');
      git(home, 'add', '.');
      git(home, 'commit', '-m', 'baseline');
      await run('attach');
      await home.app.get(RemoteLiveSyncService).runExclusive(seed.projectId, async () => {
        await home.app.get(HomeGitGuardService).remove(seed.projectId, { refreshIndex: true });
        home.app.get(GitOwnerStore).set(seed.projectId, 'home');
        await home.app.get(FileSyncHandoff).flipBackToHost(remote.id, seed.projectId, false);
      });
      write(code(home, 'file.txt'), 'PC commit\n');
      git(home, 'add', 'file.txt');
      git(home, 'commit', '-m', 'pending PC commit');
      write(code(home, 'staged.txt'), 'PC staged change\n');
      git(home, 'add', 'staged.txt');
      const staged = git(home, 'diff', '--cached');
      const head = git(home, 'rev-parse', 'HEAD');
      expect(staged).toContain('PC staged change');
      await run('detach');
      expect(git(home, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(host, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(home, 'diff', '--cached')).toBe(staged);
      expect(git(home, 'show', 'HEAD:file.txt')).toBe('PC commit');
      expect(read(code(host, 'staged.txt'))).toBe('PC staged change\n');
    });

    it('creates Git at home, copies unborn HEAD, syncs without warnings and disconnects', async () => {
      instances.home.sqlite
        .prepare("UPDATE project_workspaces SET name = 'Previous handoff' WHERE id = ?")
        .run(seed.workspaceId);
      seed = seedRemoteProject(instances.home.sqlite);
      write(code(instances.home, 'plain.txt'), 'one folder');
      expect(existsSync(code(instances.home, '.git'))).toBe(false);
      const connected = await run('attach');
      expect(connected.details.gitInit).toBe('created');
      expect(existsSync(code(instances.host, '.git/HEAD'))).toBe(true);
      expect(read(code(instances.host, '.git/HEAD'))).toBe(read(code(instances.home, '.git/HEAD')));
      expect(
        spawnSync('git', ['-C', code(instances.host), 'rev-parse', '--verify', 'HEAD']).status,
      ).toBe(128);
      expect(await instances.home.app.get(FileSyncService).projectFolders(seed.projectId)).toEqual([
        { id: codeId(), kind: 'code' },
        { id: gitId(), kind: 'git' },
      ]);
      const live = instances.home.app.get(RemoteFileSyncService);
      for (let tick = 0; tick < 4; tick++) await live.tick(seed.projectId, remote.id, () => true);
      expect(live.warning(seed.projectId)).toBeNull();
      await run('detach');
      await expect(folderConfig(instances.home, codeId())).resolves.toEqual({
        type: 'sendonly',
        paused: true,
      });
    });
  },
);
