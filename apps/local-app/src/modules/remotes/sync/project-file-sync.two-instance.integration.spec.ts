import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedRemoteProject } from '../../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { codeIgnores } from '../../file-sync/file-sync.dto';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteLiveSyncService } from './remote-live-sync.service';

let binary: string | null = process.env.SYNCTHING_BIN ?? null;
if (!binary) {
  try {
    binary = execFileSync('which', ['syncthing'], { encoding: 'utf8' }).trim();
  } catch {
    /* Optional external binary. */
  }
}

// Real instances are required to prove changed ignores schedule scans and change file transfer in both directions.
const real = binary ? describe : describe.skip;
jest.setTimeout(120_000);
real('live project ignores with two Syncthing instances', () => {
  let pair: TwoInstances;
  let projectId: string;
  let home: FileSyncService;
  let host: FileSyncService;
  let homeRoot: string;
  let hostRoot: string;
  const previousBinary = process.env.SYNCTHING_BIN;

  beforeAll(async () => {
    process.env.SYNCTHING_BIN = binary!;
    pair = await startTwoInstances({
      healthIntervalMs: 200,
      syncIntervalMs: 200,
      fileSyncPaths: (_side, dir) => ({
        syncthingHome: () => join(dir, 'syncthing'),
        codeFolder: (project) => join(dir, 'projects', project.id),
      }),
    });
    projectId = seedRemoteProject(pair.host.sqlite).projectId;
    const remoteId = (await pair.registerRemote()).id;
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
    homeRoot = await home.folderPath(projectId);
    hostRoot = await host.folderPath(projectId);
    mkdirSync(homeRoot, { recursive: true });
    mkdirSync(hostRoot, { recursive: true });
    await home.addPeer(host.device());
    await host.addPeer(home.device());
    for (const [service, peer] of [
      [home, host],
      [host, home],
    ]) {
      await service.ensureFolder({
        projectId,
        kind: 'code',
        type: 'sendreceive',
        peerDeviceId: peer.device().deviceId,
        ignores: codeIgnores([], service.getIgnores(projectId)),
      });
    }
    const live = pair.home.app.get(RemoteLiveSyncService);
    live.start(projectId, remoteId);
    await live.syncNow(projectId);
  });

  afterAll(async () => {
    await pair?.close();
    if (previousBinary === undefined) delete process.env.SYNCTHING_BIN;
    else process.env.SYNCTHING_BIN = previousBinary;
  });

  it('stops new ignored files crossing and automatically scans them when the pattern is removed', async () => {
    const save = async (ignores: string[]) => {
      const current = await pair.home.app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/file-sync/ignores`,
      });
      expect(current.statusCode).toBe(200);
      return pair.home.app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}/file-sync/ignores`,
        payload: { ignores, revision: current.json<{ revision: number }>().revision },
      });
    };
    const add = await save(['/runtime']);
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({ ignores: ['/runtime'], applied: true });
    for (const [root, side] of [
      [homeRoot, 'home'],
      [hostRoot, 'host'],
    ]) {
      mkdirSync(join(root, 'runtime'), { recursive: true });
      writeFileSync(join(root, 'runtime', `${side}.txt`), side);
      writeFileSync(join(root, `${side}-control.txt`), side);
    }
    await Promise.all([home.rescan(`code:${projectId}`), host.rescan(`code:${projectId}`)]);
    await waitForValue(async () => {
      if (
        !existsSync(join(homeRoot, 'host-control.txt')) ||
        !existsSync(join(hostRoot, 'home-control.txt'))
      )
        return false;
      const statuses = await Promise.all([
        home.status(`code:${projectId}`),
        host.status(`code:${projectId}`),
      ]);
      return statuses.every((status) => status.state === 'idle' && status.needTotalItems === 0);
    }, 30_000);
    expect(existsSync(join(homeRoot, 'runtime', 'host.txt'))).toBe(false);
    expect(existsSync(join(hostRoot, 'runtime', 'home.txt'))).toBe(false);

    const remove = await save([]);
    expect(remove.statusCode).toBe(200);
    expect(remove.json()).toMatchObject({ ignores: [], applied: true });
    await waitForValue(
      async () =>
        existsSync(join(homeRoot, 'runtime', 'host.txt')) &&
        existsSync(join(hostRoot, 'runtime', 'home.txt')),
      30_000,
    );
    expect(readFileSync(join(homeRoot, 'runtime', 'host.txt'), 'utf8')).toBe('host');
    expect(readFileSync(join(hostRoot, 'runtime', 'home.txt'), 'utf8')).toBe('home');
  });
});
