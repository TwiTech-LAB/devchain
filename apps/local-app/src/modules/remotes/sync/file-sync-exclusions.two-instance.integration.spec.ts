import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { resetEnvConfig } from '../../../common/config/env.config';
import { seedRemoteProject } from '../../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { firstMatch } from '../../file-sync/ignore-pattern-matcher';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import { RemoteHostClient } from '../operations/remote-host.client';
import type { ProjectExclusionSuggestions } from '../../file-sync/sync-path-inspection.dto';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { ensureProvider } from '../replica/__fixtures__/replica-seed';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { ProjectFileSyncFailures } from './remote-file-sync.dto';

let binary = process.env.SYNCTHING_BIN;
try {
  binary ??= execFileSync('which', ['syncthing'], { encoding: 'utf8' }).trim();
  if (!/^syncthing v2\./.test(execFileSync(binary, ['--version'], { encoding: 'utf8' })))
    binary = undefined;
} catch {
  binary = undefined;
}
if (!binary)
  console.warn('file sync exclusions: skipped (set SYNCTHING_BIN or put Syncthing v2 on PATH)');

let canChown = false;
try {
  execFileSync('sudo', ['-n', 'true']);
  canChown = process.getuid?.() !== 0;
} catch {
  canChown = false;
}
if (!canChown)
  console.warn('file sync exclusions: skipped (requires passwordless sudo for root ownership)');

const root = process.geteuid?.() === 0;
if (root) console.warn('file sync exclusions: skipped (root can read mode-0000 files)');

// Only real peers can prove permission failures clear and tracked negations still transfer files.
const real = binary && !root && canChown ? describe : describe.skip;
jest.setTimeout(120_000);
real('suggested and fixed exclusions across two Syncthing instances', () => {
  const savedBinary = process.env.SYNCTHING_BIN;
  let pair: TwoInstances;
  let projectId: string;
  let remoteId: string;
  let homeRoot: string;
  let hostRoot: string;
  let home: FileSyncService;
  let host: FileSyncService;
  const unreadableFiles: string[] = [];
  const owned: string[] = [];
  let syncthingHomes: string[] = [];
  const folderId = () => `code:${projectId}`;
  const write = (root: string, path: string, contents: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const readWhenAvailable = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', homeRoot, '-c', 'user.name=Sync Test', '-c', 'user.email=sync@example.test', ...args],
      { encoding: 'utf8' },
    );
  const save = async (ignores: string[], applied: boolean) => {
    const current = await pair.home.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/file-sync/ignores`,
    });
    expect(current.statusCode).toBe(200);
    const response = await pair.home.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/file-sync/ignores`,
      payload: { ignores, revision: current.json<{ revision: number }>().revision },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ignores, applied });
  };
  const failed = async (): Promise<ProjectFileSyncFailures> => {
    const response = await pair.home.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/file-sync/failed`,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const settled = async () => {
    const statuses = await Promise.all([home.status(folderId()), host.status(folderId())]);
    return statuses.every(
      (status) =>
        status.state === 'idle' && status.needTotalItems === 0 && (status.errors ?? 0) === 0,
    );
  };
  const run = async (kind: 'attach' | 'detach') => {
    const response = await pair.home.app.inject({
      method: 'POST',
      url: `/api/remotes/${remoteId}/${kind}`,
      payload: { projectId },
    });
    expect(response.statusCode).toBe(202);
    const { id } = response.json<RemoteOperation>();
    return waitForValue(async () => {
      const poll = await pair.home.app.inject({
        method: 'GET',
        url: `/api/remotes/operations/${id}`,
      });
      expect(poll.statusCode).toBe(200);
      const operation = poll.json<RemoteOperation>();
      if (operation.state === 'failed') throw new Error(JSON.stringify(operation.steps));
      return operation.state === 'done' ? operation : null;
    }, 60_000);
  };

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
    // Jest's process.env is isolated from the native environment read by os.homedir().
    jest.spyOn(os, 'homedir').mockReturnValue(join(pair.rootDir, 'shared-home'));
    const seed = seedRemoteProject(pair.home.sqlite);
    projectId = seed.projectId;
    ensureProvider(pair.host.sqlite, 'host-claude', seed.providerName, null);
    remoteId = (await pair.registerRemote()).id;
    await waitForValue(async () => {
      const response = await pair.home.app.inject({ method: 'GET', url: '/api/remotes' });
      return (
        response
          .json<{ items: { id: string; online: boolean }[] }>()
          .items.some((remote) => remote.id === remoteId && remote.online) &&
        [pair.home, pair.host].every((instance) =>
          instance.app.get(SyncthingManager).getConnection(),
        )
      );
    }, 30_000);
    home = pair.home.app.get(FileSyncService);
    host = pair.host.app.get(FileSyncService);
    homeRoot = await home.folderPath(projectId);
    hostRoot = join(pair.rootDir, 'shared-home', 'host', projectId);
    pair.home.sqlite
      .prepare('UPDATE projects SET root_path = ? WHERE id = ?')
      .run(homeRoot, projectId);
    syncthingHomes = [pair.home, pair.host].map((instance) => join(instance.dataDir, 'syncthing'));
    // The apps share a filesystem; translate the VM's logical checkout to its isolated physical tree.
    const inspector = pair.host.app.get(SyncPathInspector);
    const inspect = inspector.inspect.bind(inspector);
    jest
      .spyOn(inspector, 'inspect')
      .mockImplementation((root, scan, paths, patterns) =>
        inspect(root === homeRoot ? hostRoot : root, scan, paths, patterns),
      );
  }, 60_000);

  afterAll(async () => {
    try {
      for (const path of owned) {
        if (existsSync(path))
          execFileSync('sudo', [
            '-n',
            'chown',
            '-R',
            `${process.getuid!()}:${process.getgid!()}`,
            path,
          ]);
      }
      for (const path of unreadableFiles) if (existsSync(path)) chmodSync(path, 0o644);
    } finally {
      try {
        await pair?.close();
      } finally {
        jest.restoreAllMocks();
        if (savedBinary === undefined) delete process.env.SYNCTHING_BIN;
        else process.env.SYNCTHING_BIN = savedBinary;
        resetEnvConfig();
      }
    }
    if (pair) expect(existsSync(pair.rootDir)).toBe(false);
    for (const path of syncthingHomes) {
      await waitForValue(async () => {
        try {
          execFileSync('pgrep', ['-f', '--', `--home=${path}`]);
          return false;
        } catch (error) {
          if ((error as { status?: number }).status === 1) return true;
          throw error;
        }
      }, 15_000);
    }
  }, 60_000);

  it('connects with a suggested exclusion, fixes a home permission failure, and preserves tracked files through disconnect', async () => {
    write(homeRoot, '.gitignore', '/runtime/\n');
    write(homeRoot, 'cache/.gitignore', '*\n!.gitignore\n');
    write(homeRoot, 'cache/a.bin', 'cache output');
    write(homeRoot, 'runtime/keep.txt', 'tracked initial contents');
    write(homeRoot, 'packages/.gitignore', '*.egg-info/\n');
    write(homeRoot, 'packages/a.egg-info/PKG-INFO', 'root generated output');
    write(homeRoot, 'packages/deep/b.egg-info/PKG-INFO', 'nested generated output');
    const protectedPath = 'packages/keep.egg-info/source.txt';
    write(homeRoot, protectedPath, 'tracked glob exception');
    git('init', '-b', 'main');
    git('add', '.gitignore', 'cache/.gitignore', 'packages/.gitignore');
    git('add', '-f', 'runtime/keep.txt', protectedPath);
    git('commit', '-m', 'initial');
    for (const path of ['cache/a.bin', 'packages/a.egg-info', 'packages/deep/b.egg-info']) {
      const target = join(homeRoot, path);
      owned.push(target);
      execFileSync('sudo', ['-n', 'chown', '-R', '0:0', target]);
    }
    const response = await pair.home.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/file-sync/suggestions`,
      payload: { remoteId },
    });
    expect(response.statusCode).toBe(200);
    const suggestions = response.json<ProjectExclusionSuggestions>();
    expect(suggestions.vm).not.toBe('unavailable');
    const cacheGroup = suggestions.groups.find((group) => group.path === 'cache/a.bin');
    expect(cacheGroup).toMatchObject({
      selected: true,
      reasonKind: 'foreignOwner',
      patterns: ['!/cache/.gitignore', '(?d)/cache/*', '(?d)/cache/**/*'],
      patternChecksPassed: true,
    });
    const pairGroup = suggestions.groups.find((group) =>
      group.pathSample?.includes('packages/a.egg-info'),
    );
    expect(pairGroup).toMatchObject({
      pathCount: 2,
      pathSample: ['packages/a.egg-info', 'packages/deep/b.egg-info'],
      patternChecksPassed: true,
      patterns: [`!/${protectedPath}`, '(?d)/packages/*.egg-info', '(?d)/packages/**/*.egg-info'],
      selected: true,
    });
    const ignores = [...cacheGroup!.patterns, ...pairGroup!.patterns];
    await save(ignores, false);
    await run('attach');
    const patternInspection = await pair.home.app.get(RemoteHostClient).syncInspect(remoteId, {
      path: homeRoot,
      scan: false,
      paths: [],
      patterns: ['(?d)/cache'],
    });
    expect(patternInspection.patternChecks).toEqual({
      state: 'checked',
      results: [
        {
          pattern: '(?d)/cache',
          tracked: { count: 1, files: ['cache/.gitignore'], complete: true },
          kept: { count: 0, sample: [] },
        },
      ],
    });
    expect(existsSync(join(hostRoot, 'cache/a.bin'))).toBe(false);
    expect(readFileSync(join(hostRoot, 'runtime/keep.txt'), 'utf8')).toBe(
      'tracked initial contents',
    );
    expect(readFileSync(join(hostRoot, protectedPath), 'utf8')).toBe('tracked glob exception');
    expect(existsSync(join(hostRoot, 'packages/a.egg-info/PKG-INFO'))).toBe(false);
    expect(existsSync(join(hostRoot, 'packages/deep/b.egg-info/PKG-INFO'))).toBe(false);

    const globPaths = [
      protectedPath,
      'packages/new.egg-info/output',
      'packages/deep/new.egg-info/output',
      'elsewhere/new.egg-info/output',
    ];
    for (const path of globPaths) write(hostRoot, path, 'VM glob match verification');
    write(hostRoot, 'glob-sync-barrier.txt', 'glob scan completed');
    await host.rescan(folderId());
    await waitForValue(
      async () =>
        readWhenAvailable(join(homeRoot, protectedPath)) === 'VM glob match verification' &&
        existsSync(join(homeRoot, 'glob-sync-barrier.txt')) &&
        (await settled()),
      30_000,
    );
    for (const path of globPaths) {
      const match = firstMatch(pairGroup!.patterns, path);
      const ignored = match.kind === 'matched' && match.ignored;
      expect(existsSync(join(homeRoot, path))).toBe(!ignored);
    }

    write(hostRoot, 'cache/.gitignore', '*\n!.gitignore\n# VM tracked edit\n');
    write(hostRoot, 'cache/b.bin', 'ignored VM cache output');
    write(hostRoot, 'cache-control.txt', 'cache sync barrier');
    await host.rescan(folderId());
    await waitForValue(
      async () =>
        existsSync(join(homeRoot, 'cache-control.txt')) &&
        readWhenAvailable(join(homeRoot, 'cache/.gitignore')) ===
          '*\n!.gitignore\n# VM tracked edit\n' &&
        (await settled()),
      30_000,
    );
    expect(existsSync(join(homeRoot, 'cache/b.bin'))).toBe(false);

    const failedPath = 'runtime/locked/data.bin';
    const unreadable = join(homeRoot, failedPath);
    write(homeRoot, failedPath, 'unreadable home output');
    unreadableFiles.push(unreadable);
    chmodSync(unreadable, 0o000);
    await home.rescan(folderId());
    await waitForValue(async () => {
      const status = await home.status(folderId(), undefined, { allErrors: true });
      return (
        (status.errors ?? 0) >= 1 &&
        status.fileErrors?.some(
          (entry) => entry.path === failedPath && /hashing:.*permission denied/i.test(entry.error),
        )
      );
    }, 30_000);
    const failures = await waitForValue(async () => {
      const result = await failed();
      return result.home.entries.some(
        (entry) => entry.path === failedPath && /permission denied/i.test(entry.error),
      )
        ? result
        : null;
    }, 30_000);
    expect(failures.home.readError).toBeUndefined();
    expect(failures.vm).toEqual({ entries: [] });
    expect(failures.groups.map(({ path, patterns }) => ({ path, patterns }))).toEqual(
      expect.arrayContaining([{ path: 'runtime/locked', patterns: ['(?d)/runtime/locked'] }]),
    );
    const runtime = failures.groups.find((group) => group.path === 'runtime/locked');
    await save([...ignores, ...runtime!.patterns], true);
    await waitForValue(async () => {
      const result = await failed();
      return (
        !result.home.readError &&
        !result.vm.readError &&
        result.home.entries.length === 0 &&
        result.vm.entries.length === 0 &&
        (await settled())
      );
    }, 30_000);
    write(hostRoot, 'runtime/keep.txt', 'VM tracked edit');
    write(hostRoot, 'runtime/locked/other.txt', 'untracked VM output');
    write(hostRoot, 'control.txt', 'sync barrier');
    await host.rescan(folderId());
    await waitForValue(
      async () =>
        existsSync(join(homeRoot, 'control.txt')) &&
        readWhenAvailable(join(homeRoot, 'runtime/keep.txt')) === 'VM tracked edit' &&
        (await settled()),
      30_000,
    );
    expect(existsSync(join(homeRoot, 'runtime/locked/other.txt'))).toBe(false);
    expect(existsSync(join(hostRoot, failedPath))).toBe(false);
    await run('detach');
  });
});
