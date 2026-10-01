import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { seedRemoteProject } from '../../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { GitService } from '../../git/services/git.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { RemoteFileSyncService } from './remote-file-sync.service';

// Two booted apps and real Syncthing are needed to prove live ignore changes preserve pending edits.
let binary: string | null = process.env.SYNCTHING_BIN ?? null;
if (!binary) {
  try {
    binary = execFileSync('which', ['syncthing'], { encoding: 'utf8' }).trim();
  } catch {
    /* Optional external binary. */
  }
}
const real = binary ? describe : describe.skip;
jest.setTimeout(120_000);
real('connected file layout migration', () => {
  let pair: TwoInstances;
  let projectId: string;
  let remoteId: string;
  let home: FileSyncService;
  let host: FileSyncService;
  let client: RemoteHostClient;
  let maintenance: RemoteFileSyncService;
  let gitService: GitService;
  let homeRoot: string;
  let hostRoot: string;
  const savedBin = process.env.SYNCTHING_BIN;
  const guard = { install: jest.fn(async () => undefined) };
  const git = (root: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args],
      { encoding: 'utf8' },
    ).trim();
  const read = (root: string, path: string) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
  const tick = () => maintenance.tick(projectId, remoteId, () => true);

  beforeAll(async () => {
    process.env.SYNCTHING_BIN = binary!;
    pair = await startTwoInstances({
      fileSyncPaths: (_side, dir) => ({
        syncthingHome: () => join(dir, 'syncthing'),
        codeFolder: (project) => join(dir, 'projects', project.id),
      }),
    });
    projectId = seedRemoteProject(pair.host.sqlite).projectId;
    remoteId = (await pair.registerRemote()).id;
    await pair.bindProject(projectId, remoteId);
    const health = pair.home.app.get<RemoteHealthPort>(REMOTE_HEALTH_PORT);
    await waitForValue(
      async () =>
        health.getState(remoteId).versionMatches &&
        [pair.home, pair.host].every((instance) =>
          instance.app.get(SyncthingManager).getConnection(),
        ),
      30_000,
    );
    home = pair.home.app.get(FileSyncService);
    host = pair.host.app.get(FileSyncService);
    client = pair.home.app.get(RemoteHostClient);
    gitService = pair.home.app.get(GitService);
    homeRoot = await home.folderPath(projectId);
    hostRoot = await host.folderPath(projectId);
    mkdirSync(homeRoot, { recursive: true });
    git(homeRoot, 'init', '-b', 'main');
    writeFileSync(join(homeRoot, 'file.txt'), 'initial\n');
    git(homeRoot, 'add', 'file.txt');
    git(homeRoot, 'commit', '-m', 'initial');
    await home.addPeer(host.device());
    await host.addPeer(home.device());
    await home.ensureFolder({
      projectId,
      kind: 'code',
      type: 'sendonly',
      peerDeviceId: host.device().deviceId,
      ignores: [],
    });
    await host.ensureFolder({
      projectId,
      kind: 'code',
      type: 'receiveonly',
      peerDeviceId: home.device().deviceId,
      ignores: [],
    });
    await home.waitForComplete(`code:${projectId}`, {
      sender: () => home.status(`code:${projectId}`, host.device().deviceId),
      receiver: () => host.status(`code:${projectId}`),
      timeoutMs: 30_000,
    });
    await home.setFolderType(`code:${projectId}`, 'receiveonly');
    await host.setFolderType(`code:${projectId}`, 'sendonly');
    maintenance = new RemoteFileSyncService(
      home,
      client,
      pair.home.app.get(RemoteBindingsService),
      health,
      pair.home.app.get(FileSyncManagedExclusionsStore),
      gitService,
      guard as never,
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await pair?.close();
    if (savedBin === undefined) delete process.env.SYNCTHING_BIN;
    else process.env.SYNCTHING_BIN = savedBin;
  });

  it('retries each move step in place and delivers an existing receive-only home edit', async () => {
    writeFileSync(join(homeRoot, 'file.txt'), 'pending home edit\n');
    await home.rescan(`code:${projectId}`);
    await waitForValue(
      async () => (await home.status(`code:${projectId}`)).receiveOnlyChangedFiles > 0,
      30_000,
    );
    const failures: string[] = [];
    const ensure = client.syncFolders.bind(client);
    jest.spyOn(client, 'syncFolders').mockImplementationOnce(async (...args) => {
      await ensure(...args);
      failures.push('create');
      throw new Error('lost create response');
    });
    const update = client.syncFolderType.bind(client);
    jest.spyOn(client, 'syncFolderType').mockImplementation(async (...args) => {
      await update(...args);
      if (args[1] !== `code:${projectId}`) return;
      const step = args[2].ignores ? 'ignores' : 'directions';
      if (!failures.includes(step)) {
        failures.push(step);
        throw new Error(`lost ${step} response`);
      }
    });
    guard.install.mockImplementationOnce(async () => {
      failures.push('guard');
      throw new Error('hook temporarily unavailable');
    });
    let warningSeen = false;
    await waitForValue(
      async () => {
        await tick();
        warningSeen ||= maintenance.warning(projectId) !== null;
        return guard.install.mock.calls.length === 2;
      },
      60_000,
      200,
    );
    expect(failures).toEqual(['create', 'ignores', 'directions', 'guard']);
    expect(warningSeen).toBe(true);
    expect(maintenance.warning(projectId)).toBeNull();
    await waitForValue(async () => read(hostRoot, 'file.txt') === 'pending home edit\n', 30_000);
    expect(read(homeRoot, 'file.txt')).toBe('pending home edit\n');
    for (const service of [home, host])
      expect(await service.folderConfiguration(`code:${projectId}`)).toMatchObject({
        type: 'sendreceive',
      });
    expect(await home.folderConfiguration(`git:${projectId}`)).toMatchObject({
      type: 'receiveonly',
    });
    expect(await host.folderConfiguration(`git:${projectId}`)).toMatchObject({ type: 'sendonly' });
    jest.restoreAllMocks();
  });

  it('repairs Git drift without touching hooks/index and settles while an editor runs git status', async () => {
    const refresh = jest.spyOn(gitService, 'refreshIndexFromHead');
    await tick();
    git(hostRoot, 'add', 'file.txt');
    git(hostRoot, 'commit', '-m', 'host commit');
    const head = git(hostRoot, 'rev-parse', 'HEAD');
    await waitForValue(async () => {
      await tick();
      return (
        git(homeRoot, 'rev-parse', 'HEAD') === head &&
        git(homeRoot, 'diff', '--cached', '--name-only') === ''
      );
    }, 30_000);
    expect(refresh).toHaveBeenCalled();
    const hook = join(homeRoot, '.git/hooks/local-only');
    writeFileSync(hook, 'keep hook');
    const index = readFileSync(join(homeRoot, '.git/index'));
    writeFileSync(join(homeRoot, '.git/refs/heads/local-drift'), head + '\n');
    await home.rescan(`git:${projectId}`);
    await waitForValue(
      async () => (await home.status(`git:${projectId}`)).receiveOnlyChangedFiles > 0,
      30_000,
    );
    await waitForValue(async () => {
      await tick();
      return !existsSync(join(homeRoot, '.git/refs/heads/local-drift'));
    }, 30_000);
    expect(readFileSync(hook, 'utf8')).toBe('keep hook');
    expect(readFileSync(join(homeRoot, '.git/index'))).toEqual(index);
    expect(git(homeRoot, 'rev-parse', 'HEAD')).toBe(head);
    const revert = jest.spyOn(home, 'revertLocalChanges');
    refresh.mockClear();
    for (let i = 0; i < 12; i++) {
      git(homeRoot, 'status', '--porcelain');
      await home.rescan(`git:${projectId}`);
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(revert).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect((await home.status(`git:${projectId}`)).receiveOnlyChangedFiles).toBe(0);
  });

  // Real Syncthing proves peer selection excludes home and a paused device is disconnected.
  it('warns after a sustained peer disconnection and clears after reconnection', async () => {
    const rest = pair.home.app.get(SyncthingManager).getConnection()!.client;
    const deviceId = host.device().deviceId;
    const path = `/rest/config/devices/${encodeURIComponent(deviceId)}`;
    await waitForValue(() => home.isConnected(deviceId), 30_000);
    const devices = (await home.folderConfiguration(`code:${projectId}`)).devices;
    expect(devices.map((device) => device.deviceID)).toEqual(
      expect.arrayContaining([home.device().deviceId, deviceId]),
    );
    const realNow = Date.now.bind(Date);
    let offset = 30_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    try {
      await rest.request('PATCH', path, { paused: true });
      await waitForValue(async () => !(await home.isConnected(deviceId)), 30_000);
      await tick();
      expect(maintenance.warning(projectId)).toBeNull();
      offset += 90_000;
      await tick();
      expect(maintenance.warning(projectId)).toBeNull();
      offset += 30_000;
      await tick();
      expect(maintenance.warning(projectId)).toMatch(
        /No file sync connection to the VM since \d{2}:\d{2}/,
      );
      await rest.request('PATCH', path, { paused: false });
      await waitForValue(() => home.isConnected(deviceId), 30_000);
      offset += 30_000;
      await tick();
      expect(maintenance.warning(projectId)).toBeNull();
    } finally {
      clock.mockRestore();
      await rest.request('PATCH', path, { paused: false });
    }
  });
});
