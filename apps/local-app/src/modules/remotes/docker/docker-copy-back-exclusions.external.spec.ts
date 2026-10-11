import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { seedRemoteProject } from '../../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import { SyncthingManager } from '../../file-sync/syncthing-manager.service';
import { ignoreListExcludesSubtree } from '../../file-sync/ignore-pattern-matcher';
import { FileSyncHandoff } from '../operations/file-sync-handoff';
import type { RemoteOperationStepRun } from '../operations/remote-operation.types';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import { DockerCopyBackExclusions } from './docker-copy-back-exclusions';

// Opt-in proof with two real workers, real Git inspection, and the authenticated VM ignore route.
const real = process.env.SYNCTHING_DISCONNECT_PROOF === '1' ? describe : describe.skip;
jest.setTimeout(120_000);
real('Disconnect exclusions across real Syncthing peers', () => {
  let pair: TwoInstances;
  let owned: string | undefined;
  afterEach(async () => {
    if (pair) {
      const evidence = process.env.SYNCTHING_DISCONNECT_EVIDENCE_DIR;
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const side of [pair.home, pair.host]) {
        for (const file of ['syncthing.log', 'syncthing.out.log']) {
          const path = join(side.dataDir, 'syncthing', file);
          if (existsSync(path)) {
            if (evidence) copyFileSync(path, join(evidence, `${side.name}-${file}`));
            console.info(
              `${side.name} Syncthing log tail`,
              readFileSync(path, 'utf8').split('\n').slice(-10).join('\n'),
            );
          }
        }
      }
    }
    if (owned)
      execFileSync('sudo', [
        '-n',
        'chown',
        '-R',
        `${process.getuid!()}:${process.getgid!()}`,
        owned,
      ]);
    jest.restoreAllMocks();
    await pair?.close();
  });

  it('confirms fresh VM output before home replacement, repeats safely, and preserves exclusions through final sync', async () => {
    pair = await startTwoInstances({
      syncIntervalMs: 60_000,
      claimedHost: { key: `dck_${'p'.repeat(43)}` },
      fileSyncPaths: (_side, dir) => ({
        syncthingHome: () => join(dir, 'syncthing'),
        codeFolder: (project) => join(dir, 'projects', project.id),
      }),
    });
    jest.spyOn(os, 'homedir').mockReturnValue(pair.rootDir);
    const projectId = seedRemoteProject(pair.host.sqlite).projectId;
    const remoteId = (await pair.registerRemote()).id;
    await pair.bindProject(projectId, remoteId, 'detaching');
    pair.home.app.get(RemoteLiveSyncService).stop(projectId);
    await waitForValue(
      async () =>
        [pair.home, pair.host].every((instance) =>
          instance.app.get(SyncthingManager).getConnection(),
        ),
      30_000,
    );
    const processes = readdirSync('/proc')
      .filter((entry) => /^\d+$/.test(entry))
      .flatMap((pid) => {
        try {
          const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
          if (
            ![pair.home, pair.host].some((side) =>
              argv.includes(`--home=${join(side.dataDir, 'syncthing')}`),
            )
          )
            return [];
          const status = readFileSync(`/proc/${pid}/status`, 'utf8');
          const env = Object.fromEntries(
            readFileSync(`/proc/${pid}/environ`, 'utf8')
              .split('\0')
              .map((line) => {
                const separator = line.indexOf('=');
                return [line.slice(0, separator), line.slice(separator + 1)];
              }),
          );
          return [
            {
              pid,
              argv,
              parent: /^PPid:\s*(\d+)$/m.exec(status)?.[1],
              capEff: /^CapEff:\s*(\S+)$/m.exec(status)?.[1],
              uid: /^Uid:\s*(.*)$/m.exec(status)?.[1],
              environment: {
                HOME: env.HOME,
                USER: env.USER,
                LOGNAME: env.LOGNAME,
                STNOUPGRADE: env.STNOUPGRADE,
                STNODEFAULTFOLDER: env.STNODEFAULTFOLDER,
                guiKeyPresent: Boolean(env.STGUIAPIKEY),
              },
            },
          ];
        } catch {
          return [];
        }
      });
    console.info('Disconnect worker processes', JSON.stringify(processes));
    expect(processes.length).toBeGreaterThanOrEqual(2);
    expect(processes.every((proc) => proc.capEff === '0000000000000000')).toBe(true);
    const home = pair.home.app.get(FileSyncService);
    const vm = pair.host.app.get(FileSyncService);
    const homeRoot = await home.folderPath(projectId);
    const vmRoot = await vm.folderPath(projectId);
    for (const root of [homeRoot, vmRoot]) {
      mkdirSync(root, { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q']);
      writeFileSync(join(root, '.gitignore'), 'data/\n');
    }
    pair.home.sqlite
      .prepare('UPDATE projects SET root_path = ? WHERE id = ?')
      .run(homeRoot, projectId);
    const inspector = pair.host.app.get(SyncPathInspector);
    const inspect = inspector.inspect.bind(inspector);
    jest
      .spyOn(inspector, 'inspect')
      .mockImplementation((root, scan, paths, patterns, skipIgnores) =>
        inspect(root === homeRoot ? vmRoot : root, scan, paths, patterns, skipIgnores),
      );
    await home.addPeer(vm.device());
    await vm.addPeer(home.device());
    const folderId = `code:${projectId}`;
    home.setIgnores(projectId, []);
    for (const [files, peer] of [
      [home, vm],
      [vm, home],
    ]) {
      await files.ensureFolder({
        projectId,
        kind: 'code',
        type: 'sendreceive',
        paused: true,
        peerDeviceId: peer.device().deviceId,
        ignores: ['/.git'],
      });
      await (files === home ? pair.home : pair.host).app
        .get(SyncthingManager)
        .getConnection()!
        .client.request('PATCH', `/rest/config/folders/${encodeURIComponent(folderId)}`, {
          fsWatcherEnabled: false,
          rescanIntervalS: 3600,
        });
    }
    // The binding is already detaching before the new VM output appears.
    owned = join(vmRoot, 'data');
    const target = join(homeRoot, 'data');
    mkdirSync(owned);
    mkdirSync(target);
    writeFileSync(join(owned, 'source'), 'VM source must remain intact');
    writeFileSync(join(target, 'old'), 'home data before copy');
    execFileSync('sudo', ['-n', 'chown', '-R', '0:0', owned]);
    const barrier = pair.home.app.get(DockerCopyBackExclusions);
    const proof = await barrier.prepare(
      projectId,
      remoteId,
      homeRoot,
      [target],
      new AbortController().signal,
    );
    expect(proof.confirmed).toEqual([target]);
    const ignores = home.getIgnores(projectId);
    for (const files of [home, vm])
      expect(
        ignoreListExcludesSubtree((await files.installedIgnores(folderId)).ignore, 'data'),
      ).toBe(true);
    expect(
      await barrier.prepare(projectId, remoteId, homeRoot, [target], new AbortController().signal),
    ).toMatchObject({ revision: proof.revision, confirmed: [target] });
    expect(home.getIgnores(projectId)).toEqual(ignores);
    for (const files of [home, vm]) await files.updateFolder(folderId, { paused: false });
    await waitForValue(
      async () =>
        (await home.isConnected(vm.device().deviceId)) &&
        (await vm.isConnected(home.device().deviceId)),
      30_000,
    );
    expect(
      await barrier.confirm(
        projectId,
        remoteId,
        homeRoot,
        [target],
        proof.revision,
        new AbortController().signal,
      ),
    ).toEqual([target]);
    rmSync(target, { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, 'restored'), 'copied home');
    writeFileSync(join(homeRoot, 'ordinary'), 'ordinary sync still works');
    await home.rescan(folderId);
    await vm.rescan(folderId);
    await waitForValue(async () => existsSync(join(vmRoot, 'ordinary')), 30_000);
    expect(readFileSync(join(owned, 'source'), 'utf8')).toBe('VM source must remain intact');
    expect(existsSync(join(owned, 'restored'))).toBe(false);
    expect(existsSync(join(target, 'source'))).toBe(false);
    const details: Record<string, unknown> = {};
    const run = {
      operation: { id: 'disconnect-proof', remoteId, projectId },
      details,
      progress: async (patch: Record<string, unknown>) => {
        Object.assign(details, patch);
      },
    } as RemoteOperationStepRun;
    await pair.home.app.get(FileSyncHandoff).final(run, projectId);
    for (const files of [home, vm]) {
      expect(
        ignoreListExcludesSubtree((await files.installedIgnores(folderId)).ignore, 'data'),
      ).toBe(true);
      const status = await files.status(folderId);
      expect(status.errors ?? 0).toBe(0);
      expect(status.pullErrors ?? 0).toBe(0);
    }
    expect(readFileSync(join(owned, 'source'), 'utf8')).toBe('VM source must remain intact');
    console.info(
      JSON.stringify({
        proof,
        stored: ignores,
        home: await home.installedIgnores(folderId),
        vm: await vm.installedIgnores(folderId),
        roots: { home: homeRoot, vm: vmRoot },
      }),
    );
  });
});
