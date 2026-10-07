import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { seedRemoteProject } from '../../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { FileSyncAutoFixStore } from '../../file-sync/file-sync-auto-fix.store';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteFileSyncService } from './remote-file-sync.service';
import { RemoteLiveSyncService } from './remote-live-sync.service';

let binary = process.env.SYNCTHING_BIN;
let canChown = false;
try {
  binary ??= execFileSync('which', ['syncthing'], { encoding: 'utf8' }).trim();
  execFileSync('sudo', ['-n', 'true']);
  canChown = process.getuid?.() !== 0;
} catch {
  /* Real permissions require an unprivileged runner with sudo. */
}
const real = binary && canChown ? describe : describe.skip;
if (!binary || !canChown)
  console.warn(
    'Automatic file sync: real tests require Syncthing and a non-root runner with passwordless sudo.',
  );

// Real runners establish root ownership, actual pull backoff and failure recovery after the save.
jest.setTimeout(120_000);
real('automatic exclusions and immediate retry across real peers', () => {
  let pair: TwoInstances;
  let projectId: string;
  let remoteId: string;
  let home: FileSyncService;
  let vm: FileSyncService;
  let homeRoot: string;
  let vmRoot: string;
  let maintenance: RemoteFileSyncService;
  let live: RemoteLiveSyncService;
  const owned: string[] = [];
  const originalBinary = process.env.SYNCTHING_BIN;
  const folderId = () => `code:${projectId}`;
  const tick = () =>
    live.runExclusive(projectId, (active) => maintenance.tick(projectId, remoteId, active));
  const vmClient = () => pair.host.app.get(SyncthingManager).getConnection()!.client;
  const healthy = async () => {
    const statuses = await Promise.all([home.status(folderId()), vm.status(folderId())]);
    return statuses.every(
      (status) =>
        status.state === 'idle' &&
        (status.errors ?? 0) === 0 &&
        (status.pullErrors ?? 0) === 0 &&
        status.needTotalItems === 0,
    );
  };
  const cleared = (timeout: number) =>
    waitForValue(healthy, timeout).catch(async (error: unknown) => {
      throw new Error(
        JSON.stringify({
          error: String(error),
          home: await home.status(folderId(), undefined, { allErrors: true }),
          vm: await vm.status(folderId(), undefined, { allErrors: true }),
          ignores: home.getIgnores(projectId),
          automatic: pair.home.app.get(FileSyncAutoFixStore).get(projectId),
          logs: readFileSync(join(pair.host.dataDir, 'syncthing', 'syncthing.log'), 'utf8')
            .split('\n')
            .slice(-12),
        }),
      );
    });
  const createFailure = async (name: string) => {
    const target = join(vmRoot, name);
    mkdirSync(target);
    owned.push(target);
    execFileSync('sudo', ['-n', 'chown', '0:0', target]);
    execFileSync('sudo', ['-n', 'chmod', '0555', target]);
    mkdirSync(join(homeRoot, name));
    writeFileSync(join(homeRoot, name, 'data.bin'), 'generated output');
    await home.rescan(folderId());
    const failedPull = (status: Awaited<ReturnType<FileSyncService['status']>>) =>
      (status.pullErrors ?? 0) > 0 &&
      status.fileErrors?.some(
        (entry) =>
          (entry.path === name || entry.path.startsWith(name + '/')) &&
          /permission denied|operation not permitted/.test(entry.error),
      );
    await waitForValue(async () => {
      const status = await vm.status(folderId(), undefined, { allErrors: true });
      return status.needTotalItems > 0 || failedPull(status);
    }, 30_000);
    await vm.updateFolder(folderId(), { paused: true });
    await vm.updateFolder(folderId(), { paused: false });
    await waitForValue(async () => {
      const status = await vm.status(folderId(), undefined, { allErrors: true });
      return failedPull(status);
    }, 30_000);
  };

  beforeAll(async () => {
    process.env.SYNCTHING_BIN = binary!;
    pair = await startTwoInstances({
      syncIntervalMs: 60_000,
      fileSyncPaths: (_side, dir) => ({
        syncthingHome: () => join(dir, 'syncthing'),
        codeFolder: (project) => join(dir, 'projects', project.id),
      }),
    });
    jest.spyOn(os, 'homedir').mockReturnValue(pair.rootDir);
    projectId = seedRemoteProject(pair.host.sqlite).projectId;
    remoteId = (await pair.registerRemote()).id;
    await pair.bindProject(projectId, remoteId);
    const health = pair.home.app.get<RemoteHealthPort>(REMOTE_HEALTH_PORT);
    await waitForValue(
      async () =>
        health.getState(remoteId).online &&
        health.getState(remoteId).versionMatches &&
        [pair.home, pair.host].every((instance) =>
          instance.app.get(SyncthingManager).getConnection(),
        ),
      30_000,
    );
    home = pair.home.app.get(FileSyncService);
    vm = pair.host.app.get(FileSyncService);
    homeRoot = await home.folderPath(projectId);
    vmRoot = await vm.folderPath(projectId);
    for (const root of [homeRoot, vmRoot]) {
      mkdirSync(root, { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q']);
      writeFileSync(join(root, '.gitignore'), 'auto-output/\nbackoff-output/\n');
    }
    pair.home.sqlite
      .prepare('UPDATE projects SET root_path = ? WHERE id = ?')
      .run(homeRoot, projectId);
    const inspector = pair.host.app.get(SyncPathInspector);
    const inspect = inspector.inspect.bind(inspector);
    jest
      .spyOn(inspector, 'inspect')
      .mockImplementation((root, scan, paths, patterns) =>
        inspect(root === homeRoot ? vmRoot : root, scan, paths, patterns),
      );
    // This case isolates the code-folder runner; Git inspection still uses both real repositories.
    jest.spyOn(home, 'initialFolders').mockResolvedValue([{ id: folderId(), kind: 'code' }]);
    await home.addPeer(vm.device());
    await vm.addPeer(home.device());
    for (const [files, peer] of [
      [home, vm],
      [vm, home],
    ])
      await files.ensureFolder({
        projectId,
        kind: 'code',
        type: 'sendreceive',
        peerDeviceId: peer.device().deviceId,
        ignores: ['/.git'],
      });
    for (const instance of [pair.home, pair.host])
      await instance.app
        .get(SyncthingManager)
        .getConnection()!
        .client.request('PATCH', `/rest/config/folders/${encodeURIComponent(folderId())}`, {
          ignorePerms: false,
          fsWatcherEnabled: false,
          rescanIntervalS: 3600,
          pullerPauseS: 1,
          pullerDelayS: 0,
        });
    home.setIgnores(projectId, []);
    maintenance = pair.home.app.get(RemoteFileSyncService);
    live = pair.home.app.get(RemoteLiveSyncService);
    live.start(projectId, remoteId);
    await tick();
    await waitForValue(healthy, 30_000);
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    for (const path of owned) {
      execFileSync('sudo', [
        '-n',
        'chown',
        '-R',
        `${process.getuid!()}:${process.getgid!()}`,
        path,
      ]);
      execFileSync('sudo', ['-n', 'chmod', '0755', path]);
    }
    await pair?.close();
    if (originalBinary === undefined) delete process.env.SYNCTHING_BIN;
    else process.env.SYNCTHING_BIN = originalBinary;
  });

  it('automatically excludes a Git-ignored root-owned VM folder after the two-minute grace', async () => {
    expect(pair.home.app.get(FileSyncAutoFixStore).get(projectId).enabled).toBe(true);
    await createFailure('auto-output');
    await tick();
    const now = Date.now.bind(Date);
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now() + 150_000);
    try {
      await tick();

      await cleared(10_000);
      expect(home.getIgnores(projectId)).toEqual(['(?d)auto-output']);
      expect(pair.home.app.get(FileSyncAutoFixStore).get(projectId).actions).toEqual([
        expect.objectContaining({ kind: 'exclude', side: 'vm', patterns: ['(?d)auto-output'] }),
      ]);
    } finally {
      clock.mockRestore();
    }
    maintenance.forget(projectId);
    await tick();
  });

  it('clears a pull failure within ten seconds after a manual save despite a grown retry pause', async () => {
    pair.home.app.get(FileSyncAutoFixStore).setEnabled(projectId, false);
    await createFailure('backoff-output');
    type FolderErrorEvent = {
      time: string;
      data: { folder: string; errors: Array<{ path: string }> };
    };
    const events = await waitForValue(
      async () => {
        const result = (await vmClient().request(
          'GET',
          '/rest/events?events=FolderErrors&since=0&timeout=0&limit=1000',
        )) as FolderErrorEvent[];
        const failures = result.filter(
          (event) =>
            event.data.folder === folderId() &&
            event.data.errors.some(
              (error) =>
                error.path === 'backoff-output' || error.path.startsWith('backoff-output/'),
            ),
        );
        const last = failures.at(-1);
        const previous = failures.at(-2);
        return last && previous && Date.parse(last.time) - Date.parse(previous.time) >= 7_500
          ? failures
          : null;
      },
      60_000,
      100,
    );
    const last = events.at(-1)!;
    const previous = events.at(-2)!;
    const retry = readFileSync(join(pair.host.dataDir, 'syncthing', 'syncthing.log'), 'utf8')
      .split('\n')
      .reverse()
      .find(
        (line) =>
          line.includes('Folder failed to sync, will be retried') && line.includes(folderId()),
      )!;
    const nextPause = Number(/wait=(\d+(?:\.\d+)?)s/.exec(retry)?.[1]) * 1000;
    expect(Date.parse(last.time) - Date.parse(previous.time)).toBeGreaterThanOrEqual(7_500);
    expect(nextPause).toBeGreaterThanOrEqual(15_000);
    const started = Date.now();
    const current = await pair.home.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/file-sync/ignores`,
    });
    expect(current.statusCode).toBe(200);
    const snapshot = current.json<{ ignores: string[]; revision: number }>();
    const ignores = [...snapshot.ignores, '(?d)/backoff-output'];
    const save = await pair.home.app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/file-sync/ignores`,
      payload: { ignores, revision: snapshot.revision },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ applied: true });
    await cleared(10_000);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(10_000);
    process.stdout.write(
      `Native retry verification ${JSON.stringify({ retryGapMs: Date.parse(last.time) - Date.parse(previous.time), nextPauseMs: nextPause, clearedAfterSaveMs: elapsed })}\n`,
    );
    expect(Date.now()).toBeLessThan(Date.parse(last.time) + nextPause);
    expect(readFileSync(join(homeRoot, 'backoff-output/data.bin'), 'utf8')).toBe(
      'generated output',
    );
  });
});
