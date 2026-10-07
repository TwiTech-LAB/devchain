// Real Syncthing and two booted apps are needed to prove index rebuilds, backup contents and restored ownership.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { resetEnvConfig } from '../../../common/config/env.config';
import { seedRemoteProject } from '../../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TestInstance,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { DEFAULT_FILE_SYNC_IGNORES } from '../../file-sync/file-sync.dto';
import { FILE_SYNC_PATHS, type FileSyncPaths } from '../../file-sync/file-sync-paths';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { projectRepository } from '../../file-sync/project-repository';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { SyncthingRestError } from '../../file-sync/syncthing-rest.client';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { ensureProvider } from '../replica/__fixtures__/replica-seed';
import { RemoteFileSyncService } from '../sync/remote-file-sync.service';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import { RemoteHostClient, RemoteHostRequestError } from './remote-host.client';
import type { ForceSyncOperationDetails } from './force-sync.operation';
import { GitOwnerStore, type GitOwner } from '../git-owner.store';
import { FileSyncHandoff } from './file-sync-handoff';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';

let binary = process.env.SYNCTHING_BIN;
try {
  binary ??= execFileSync('which', ['syncthing'], { encoding: 'utf8' }).trim();
  if (!/^syncthing v2\./.test(execFileSync(binary, ['--version'], { encoding: 'utf8' })))
    binary = undefined;
} catch {
  binary = undefined;
}
if (!binary)
  console.warn('Force sync proof: skipped (set SYNCTHING_BIN or put Syncthing v2 on PATH)');
const real = binary ? describe : describe.skip;
jest.setTimeout(180_000);

const markers = new Set(['.stfolder', '.stignore', '.stversions']);
function contents(
  root: string,
  skip: (name: string) => boolean = () => false,
): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (markers.has(entry.name) || skip(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(root, path)] = readFileSync(path);
    }
  };
  walk(root);
  return files;
}
const write = (root: string, name: string, value: string) => {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), value);
};
/** The file's text, or null while a sync replaces it; other read errors still fail. */
const readSynced = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};
const git = (root: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', root, '-c', 'user.name=Force sync test', '-c', 'user.email=sync@example.test', ...args],
    { encoding: 'utf8' },
  ).trim();
const codeContents = (root: string) =>
  contents(root, (name) => ['.git', 'node_modules', 'keep.local'].includes(name));
// Connected Git deliberately leaves hooks/index per side; compare every replicated metadata file.
const gitContents = (root: string) =>
  contents(
    join(root, '.git'),
    (name) => ['hooks', 'index'].includes(name) || name.endsWith('.lock'),
  );
const processes = (home: string): number[] => {
  try {
    return execFileSync('pgrep', ['-f', '--', `--home=${home}`], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map(Number);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
};

real('Force sync through two DevChain apps and private Syncthing peers', () => {
  const savedBinary = process.env.SYNCTHING_BIN;
  let pair: TwoInstances;
  let remoteId: string;
  let projectId: string;
  let homeRoot: string;
  let vmRoot: string;
  let home: FileSyncService;
  let vm: FileSyncService;
  let live: RemoteLiveSyncService;
  let maintenance: RemoteFileSyncService;
  let homes: string[] = [];
  let inspectTranslation: jest.SpyInstance;
  let homeTranslation: jest.SpyInstance;
  let verification: unknown[] = [];
  let statusObservers: jest.SpyInstance[] = [];
  const codeId = () => `code:${projectId}`;
  const gitId = () => `git:${projectId}`;
  const tick = () =>
    live.runExclusive(projectId, (active) => maintenance.tick(projectId, remoteId, active));

  async function configuration(instance: TestInstance, id: string) {
    return instance.app
      .get(SyncthingManager)
      .getConnection()!
      .client.request('GET', `/rest/config/folders/${encodeURIComponent(id)}`) as Promise<{
      type: string;
      paused: boolean;
      maxConflicts: number;
      versioning: { type: string; fsPath: string };
    }>;
  }
  async function operation(id: string, state: RemoteOperation['state'] = 'done') {
    return waitForValue(async () => {
      const response = await pair.home.app.inject({
        method: 'GET',
        url: `/api/remotes/operations/${id}`,
      });
      expect(response.statusCode).toBe(200);
      const row = response.json<RemoteOperation>();
      if (row.state === 'failed' && state !== 'failed') {
        if (row.kind === 'force_sync') {
          const checked = verification.slice(-4);
          const statuses = await Promise.allSettled([
            home.status(codeId(), vm.device().deviceId, { allErrors: true }),
            home.status(gitId(), vm.device().deviceId, { allErrors: true }),
            vm.status(codeId(), home.device().deviceId, { allErrors: true }),
            vm.status(gitId(), home.device().deviceId, { allErrors: true }),
            home.localChanges(gitId()),
            vm.localChanges(gitId()),
          ]);
          const records = await Promise.allSettled(
            [pair.home, pair.host].flatMap((instance) =>
              [codeId(), gitId()].map(async (id) => ({
                id,
                configuration: await configuration(instance, id),
                ignores: await instance.app
                  .get(SyncthingManager)
                  .getConnection()!
                  .client.request('GET', `/rest/db/ignores?folder=${encodeURIComponent(id)}`),
              })),
            ),
          );
          console.error('Force sync verification snapshots:', JSON.stringify(checked));
          console.error(
            'Force sync failed peer statuses (home code/git, VM code/git, local Git changes):',
            JSON.stringify(statuses),
          );
          console.error(
            'Force sync final records/ignores (home code/git, VM code/git):',
            JSON.stringify(records),
          );
        }
        throw new Error(JSON.stringify({ details: row.details, steps: row.steps }));
      }
      return row.state === state ? row : null;
    }, 90_000);
  }
  async function start(source: 'home' | 'vm', state: RemoteOperation['state'] = 'done') {
    const response = await pair.home.app.inject({
      method: 'POST',
      url: `/api/remotes/${remoteId}/force-sync`,
      payload: { projectId, source },
    });
    expect(response.statusCode).toBe(202);
    return operation(response.json<RemoteOperation>().id, state);
  }
  async function connectedConfiguration(owner: GitOwner = 'vm') {
    // Upkeep briefly pauses Git while recreating connected records; drain its queue before sampling.
    await live.runExclusive(projectId, async () => {
      for (const instance of [pair.home, pair.host]) {
        expect(await configuration(instance, codeId())).toMatchObject({
          type: 'sendreceive',
          paused: false,
          versioning: { type: '' },
        });
        expect(await configuration(instance, gitId())).toMatchObject({
          type: (instance === pair.home) === (owner === 'home') ? 'sendonly' : 'receiveonly',
          paused: false,
          maxConflicts: 0,
          versioning: { type: '' },
        });
        const client = instance.app.get(SyncthingManager).getConnection()!.client;
        expect(
          await client.request('GET', `/rest/db/ignores?folder=${encodeURIComponent(codeId())}`),
        ).toMatchObject({
          ignore: ['/.git', ...DEFAULT_FILE_SYNC_IGNORES, '/keep.local'],
        });
        expect(
          await client.request('GET', `/rest/db/ignores?folder=${encodeURIComponent(gitId())}`),
        ).toMatchObject({
          ignore: ['*.lock', '/hooks', '/index'],
        });
      }
    });
  }
  async function pausedHomeProblem() {
    await live.runExclusive(projectId, async () => {
      for (const id of [codeId(), gitId()]) await home.updateFolder(id, { paused: true });
    });
    await agedProblem();
  }
  async function agedProblem() {
    // Age only the product's warning clock; real transfers and process timers keep running.
    const now = Date.now.bind(Date);
    let elapsed = 31_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
    try {
      await tick();
      elapsed += 150_000;
      await tick();
      expect(['error', 'setup']).toContain(maintenance.problem(projectId));
      expect(await maintenance.forceSyncOffer(projectId)).toMatchObject({ offered: true });
    } finally {
      clock.mockRestore();
    }
  }

  beforeAll(async () => {
    process.env.SYNCTHING_BIN = binary!;
    resetEnvConfig();
    pair = await startTwoInstances({
      syncIntervalMs: 200,
      fileSyncPaths: (side, dir) => ({
        syncthingHome: () => join(dir, 'syncthing'),
        codeFolder: (project) => join(dirname(dir), 'shared-home', side, project.id),
      }),
    });
    homeTranslation = jest.spyOn(os, 'homedir').mockReturnValue(join(pair.rootDir, 'shared-home'));
    home = pair.home.app.get(FileSyncService);
    vm = pair.host.app.get(FileSyncService);
    live = pair.home.app.get(RemoteLiveSyncService);
    maintenance = pair.home.app.get(RemoteFileSyncService);
    const inspector = pair.host.app.get(SyncPathInspector);
    const inspect = inspector.inspect.bind(inspector);
    const logicalHome = join(pair.rootDir, 'shared-home', 'home');
    const physicalVm = join(pair.rootDir, 'shared-home', 'host');
    // Both apps share an OS; translate VM paths while retaining real inspection and repository reads.
    inspectTranslation = jest
      .spyOn(inspector, 'inspect')
      .mockImplementation((root, scan, paths) =>
        inspect(
          root.startsWith(logicalHome + '/') ? join(physicalVm, relative(logicalHome, root)) : root,
          scan,
          paths,
        ),
      );
    remoteId = (await pair.registerRemote('Force sync VM')).id;
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
    homes = [pair.home, pair.host].map((instance) =>
      instance.app.get<FileSyncPaths>(FILE_SYNC_PATHS).syncthingHome(),
    );
    for (const instance of [pair.home, pair.host]) {
      const manager = instance.app.get(SyncthingManager);
      for (const port of [
        manager.getState().apiPort,
        Number(new URL(instance.app.get(FileSyncService).device().address).port),
      ]) {
        expect(port).not.toBe(3000);
        expect(port).not.toBe(22000);
      }
    }
  }, 60_000);

  beforeEach(async () => {
    for (const instance of [pair.home, pair.host])
      instance.sqlite
        .prepare("UPDATE project_workspaces SET name = 'Previous ' || id WHERE name = 'Handoff'")
        .run();
    const seed = seedRemoteProject(pair.home.sqlite);
    projectId = seed.projectId;
    ensureProvider(pair.host.sqlite, 'host-claude', seed.providerName, null);
    homeRoot = await home.folderPath(projectId);
    vmRoot = join(pair.rootDir, 'shared-home', 'host', projectId);
    pair.home.sqlite
      .prepare('UPDATE projects SET root_path = ? WHERE id = ?')
      .run(homeRoot, projectId);
    home.setIgnores(projectId, [...DEFAULT_FILE_SYNC_IGNORES, '/keep.local']);
    write(homeRoot, 'file.txt', 'original file\n');
    write(homeRoot, 'restore.txt', 'restore this source file\n');
    git(homeRoot, 'init', '-b', 'main');
    git(homeRoot, 'add', '.');
    git(homeRoot, 'commit', '-m', 'source baseline');
    const response = await pair.home.app.inject({
      method: 'POST',
      url: `/api/remotes/${remoteId}/attach`,
      payload: { projectId },
    });
    expect(response.statusCode).toBe(202);
    await operation(response.json<RemoteOperation>().id);
    await waitForValue(async () => {
      await live.syncNow(projectId);
      const statuses = await Promise.all([
        home.status(codeId()),
        home.status(gitId()),
        vm.status(codeId()),
        vm.status(gitId()),
      ]);
      return (
        statuses.every(
          (status) => status.state === 'idle' && status.needTotalItems === 0 && !status.error,
        ) && git(homeRoot, 'rev-parse', 'HEAD') === git(vmRoot, 'rev-parse', 'HEAD')
      );
    }, 30_000);
    await live.syncNow(projectId);
    await connectedConfiguration();
    verification = [];
    statusObservers = [home, vm].map((files, side) => {
      const status = files.status.bind(files);
      return jest.spyOn(files, 'status').mockImplementation(async (...args) => {
        const result = await status(...args);
        if (args[2]?.allErrors) {
          verification.push({ side: side === 0 ? 'home' : 'vm', id: args[0], status: result });
          verification = verification.slice(-4);
        }
        return result;
      });
    });
  });

  afterEach(async () => {
    await live?.stop(projectId);
    for (const observer of statusObservers) observer.mockRestore();
  });
  afterAll(async () => {
    try {
      await pair?.close();
    } finally {
      inspectTranslation?.mockRestore();
      homeTranslation?.mockRestore();
      if (savedBinary === undefined) delete process.env.SYNCTHING_BIN;
      else process.env.SYNCTHING_BIN = savedBinary;
      resetEnvConfig();
    }
    for (const path of homes)
      await waitForValue(async () => processes(path).length === 0, 15_000, 100);
    if (pair) expect(existsSync(pair.rootDir)).toBe(false);
  }, 60_000);

  it('rebuilds missing home Git from the VM and clears the real folder-path error', async () => {
    const expectedHead = git(vmRoot, 'rev-parse', 'HEAD');
    const sourceCode = codeContents(vmRoot);
    const sourceGit = gitContents(vmRoot);
    rmSync(join(homeRoot, '.git'), { recursive: true, force: true });
    await home.rescan(gitId()).catch((error: unknown) => {
      if (!(error instanceof SyncthingRestError) || error.status !== 500) throw error;
    });
    await waitForValue(
      async () => /folder path missing/i.test((await home.status(gitId())).error ?? ''),
      30_000,
    );
    await agedProblem();
    const done = await start('vm');
    expect((done.details as unknown as ForceSyncOperationDetails).forceSync.verified).toBe(true);
    expect(await projectRepository(homeRoot)).toBe('repository');
    expect(git(homeRoot, 'rev-parse', 'HEAD')).toBe(expectedHead);
    expect(gitContents(homeRoot)).toEqual(sourceGit);
    expect(codeContents(vmRoot)).toEqual(sourceCode);
    expect(gitContents(vmRoot)).toEqual(sourceGit);
    await connectedConfiguration();
    await live.syncNow(projectId);
    expect(maintenance.warning(projectId)).toBeNull();
  });

  it('makes this PC win, backs up replaced code/Git and restores normal ownership with the ignored-file exception', async () => {
    await pausedHomeProblem();
    const sourceCode = codeContents(homeRoot);
    const sourceGit = gitContents(homeRoot);
    write(vmRoot, 'file.txt', 'VM replacement\n');
    write(vmRoot, 'added.txt', 'VM-only file\n');
    unlinkSync(join(vmRoot, 'restore.txt'));
    write(vmRoot, 'vm-only/plain.txt', 'VM-only nested file\n');
    write(vmRoot, 'vm-only/node_modules/dependency', 'deletable ignored child\n');
    write(vmRoot, 'keep.local', 'keep ignored root file\n');
    git(vmRoot, 'switch', '-c', 'vm-work');
    git(vmRoot, 'add', 'file.txt', 'added.txt', 'restore.txt', 'vm-only/plain.txt');
    git(vmRoot, 'commit', '-m', 'divergent VM metadata');
    const vmHeadFile = readFileSync(join(vmRoot, '.git/HEAD'));
    const vmRef = readFileSync(join(vmRoot, '.git/refs/heads/vm-work'));
    const vmIndex = readFileSync(join(vmRoot, '.git/index'));
    const receiverConfigs: unknown[] = [];
    const ensure = vm.ensureFolder.bind(vm);
    const observe = jest.spyOn(vm, 'ensureFolder').mockImplementation(async (request) => {
      const result = await ensure(request);
      if (request.kind === 'git' && request.forceCopy)
        receiverConfigs.push(await configuration(pair.host, gitId()));
      return result;
    });
    let done: RemoteOperation;
    try {
      done = await start('home');
    } finally {
      observe.mockRestore();
    }
    expect(receiverConfigs).toEqual([
      expect.objectContaining({
        maxConflicts: -1,
        versioning: expect.objectContaining({ type: 'trashcan' }),
      }),
    ]);
    expect(codeContents(vmRoot)).toEqual(sourceCode);
    expect(gitContents(vmRoot)).toEqual(sourceGit);
    expect(codeContents(homeRoot)).toEqual(sourceCode);
    expect(gitContents(homeRoot)).toEqual(sourceGit);
    expect(readFileSync(join(vmRoot, 'keep.local'), 'utf8')).toBe('keep ignored root file\n');
    expect(existsSync(join(vmRoot, 'vm-only/node_modules'))).toBe(false);
    const details = (done.details as unknown as ForceSyncOperationDetails).forceSync;
    expect(details.replaced?.count).toBeGreaterThan(0);
    expect(details.backups).toHaveLength(2);
    const codeBackup = details.backups!.find(
      (backup) => backup.side === 'vm' && backup.kind === 'code',
    )!;
    const gitBackup = details.backups!.find(
      (backup) => backup.side === 'vm' && backup.kind === 'git',
    )!;
    expect(codeBackup.path).toBe(
      join(pair.host.dataDir, 'sync-backups', projectId, done.id, 'code'),
    );
    const savedCode = Object.values(contents(codeBackup.path));
    for (const value of ['VM replacement\n', 'VM-only file\n', 'VM-only nested file\n'])
      expect(savedCode).toContainEqual(Buffer.from(value));
    expect(savedCode).not.toContainEqual(Buffer.from('deletable ignored child\n'));
    const savedGit = Object.values(contents(gitBackup.path));
    for (const value of [vmHeadFile, vmRef, vmIndex]) expect(savedGit).toContainEqual(value);
    await connectedConfiguration();
    write(vmRoot, 'file.txt', 'VM edit after repair\n');
    await vm.rescan(codeId());
    await waitForValue(
      async () => readSynced(join(homeRoot, 'file.txt')) === 'VM edit after repair\n',
      30_000,
    );
    git(vmRoot, 'add', 'file.txt');
    git(vmRoot, 'commit', '-m', 'VM owns Git after repair');
    const head = git(vmRoot, 'rev-parse', 'HEAD');
    await vm.rescan(gitId());
    await waitForValue(async () => {
      const status = await home.status(gitId());
      return (
        status.state === 'idle' &&
        status.needTotalItems === 0 &&
        git(homeRoot, 'rev-parse', 'HEAD') === head
      );
    }, 30_000);
    expect(git(homeRoot, 'show', 'HEAD:file.txt')).toBe('VM edit after repair');
  });

  // The existing real-peer fixture catches guard hooks/backups crossing with the full Git copy.
  it.each(['home', 'vm'] as const)(
    'keeps PC Git ownership and clean user hooks after Force sync from %s',
    async (source) => {
      const hook = (side: 'home' | 'vm') => `#!/bin/sh\n# user hook from ${side}\nexit 0\n`;
      await live.runExclusive(projectId, async () => {
        await pair.home.app.get(HomeGitGuardService).remove(projectId, { refreshIndex: true });
        for (const [side, root] of [
          ['home', homeRoot],
          ['vm', vmRoot],
        ] as const)
          for (const name of ['reference-transaction', 'post-checkout']) {
            write(root, `.git/hooks/${name}`, hook(side));
            chmodSync(join(root, '.git/hooks', name), 0o755);
          }
        pair.home.app.get(GitOwnerStore).set(projectId, 'home');
        await pair.home.app.get(FileSyncHandoff).flipBackToHost(remoteId, projectId, false);
      });
      await pausedHomeProblem();
      const expectedHead = git(source === 'home' ? homeRoot : vmRoot, 'rev-parse', 'HEAD');
      const done = await start(source);
      expect((done.details as unknown as ForceSyncOperationDetails).forceSync.verified).toBe(true);
      expect(git(homeRoot, 'rev-parse', 'HEAD')).toBe(expectedHead);
      await connectedConfiguration('home');
      for (const name of ['reference-transaction', 'post-checkout']) {
        expect(readFileSync(join(homeRoot, '.git/hooks', name), 'utf8')).toBe(hook(source));
        expect(existsSync(join(homeRoot, '.git/hooks', `${name}.devchain-saved`))).toBe(false);
        expect(readFileSync(join(vmRoot, '.git/hooks', `${name}.devchain-saved`), 'utf8')).toBe(
          hook(source),
        );
      }
      const refused = spawnSync('git', ['-C', vmRoot, 'tag', 'must-refuse'], { encoding: 'utf8' });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('devchain git return');
      write(homeRoot, 'after-force.txt', 'PC can commit after repair\n');
      git(homeRoot, 'add', 'after-force.txt');
      git(homeRoot, 'commit', '-m', 'PC still owns Git');
      expect(pair.home.app.get(GitOwnerStore).get(projectId)).toBe('home');
    },
  );

  it('holds an interrupted rebuild across live-sync restart, rejects ignore saves and retries the whole copy', async () => {
    await pausedHomeProblem();
    write(vmRoot, 'file.txt', 'VM change before interruption\n');
    write(vmRoot, 'loser-only.txt', 'remove on retry\n');
    const sourceCode = codeContents(homeRoot);
    const sourceGit = gitContents(homeRoot);
    const client = pair.home.app.get(RemoteHostClient);
    const create = client.syncFolders.bind(client);
    let injected = false;
    const failure = jest.spyOn(client, 'syncFolders').mockImplementation(async (...args) => {
      const result = await create(...args);
      if (args[1].kind === 'git' && args[1].forceCopy && !injected) {
        injected = true;
        throw new RemoteHostRequestError('VM create response lost after rebuilding records', {
          remoteId,
          path: '/api/host/sync/folders',
          status: null,
          hostCode: null,
        });
      }
      return result;
    });
    let failed: RemoteOperation;
    try {
      failed = await start('home', 'failed');
    } finally {
      failure.mockRestore();
    }
    expect(failed.steps.find((step) => step.id === 'force_copy')?.state).toBe('failed');
    expect((failed.details as unknown as ForceSyncOperationDetails).forceSync).toMatchObject({
      verified: false,
      backups: expect.any(Array),
    });
    const layout = () =>
      Promise.all([
        configuration(pair.home, codeId()),
        configuration(pair.home, gitId()),
        configuration(pair.host, codeId()),
        configuration(pair.host, gitId()),
      ]);
    const held = await layout();
    expect(held.map((folder) => folder.type)).toEqual([
      'sendonly',
      'sendonly',
      'receiveonly',
      'receiveonly',
    ]);
    expect(held.map((folder) => folder.paused)).toEqual([true, true, true, true]);
    await live.stop(projectId);
    live.start(projectId, remoteId);
    const upkeep = jest.spyOn(home, 'ensureFolder');
    try {
      await live.syncNow(projectId);
      expect(upkeep).not.toHaveBeenCalled();
      expect(await layout()).toEqual(held);
      const ignores = home.getIgnores(projectId);
      const save = await pair.home.app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/file-sync/ignores`,
        payload: {
          ignores: ['/new-ignore'],
          revision: (
            await pair.home.app.inject({
              method: 'GET',
              url: `/api/projects/${projectId}/file-sync/ignores`,
            })
          ).json<{ revision: number }>().revision,
        },
      });
      expect(save.statusCode).toBe(409);
      expect(home.getIgnores(projectId)).toEqual(ignores);
    } finally {
      upkeep.mockRestore();
    }
    const retry = await pair.home.app.inject({
      method: 'POST',
      url: `/api/remotes/operations/${failed.id}/retry`,
      payload: {},
    });
    expect(retry.statusCode).toBe(202);
    const done = await operation(failed.id);
    expect((done.details as unknown as ForceSyncOperationDetails).forceSync.verified).toBe(true);
    expect(codeContents(vmRoot)).toEqual(sourceCode);
    expect(gitContents(vmRoot)).toEqual(sourceGit);
    expect(codeContents(homeRoot)).toEqual(sourceCode);
    expect(gitContents(homeRoot)).toEqual(sourceGit);
    await connectedConfiguration();
    await live.syncNow(projectId);
    expect(maintenance.warning(projectId)).toBeNull();
  });
});
