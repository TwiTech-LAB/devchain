import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import {
  seedRemoteProject,
  type SeededRemoteProject,
} from '../../../common/test/remote-project.fixture';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { GitOwnerStore, type GitOwner } from '../git-owner.store';
import { RemoteFileSyncService } from '../sync/remote-file-sync.service';
import { RemoteLiveSyncService } from '../sync/remote-live-sync.service';
import { FileSyncHandoff } from './file-sync-handoff';
import type { RemoteSession } from './git-owner.dto';
import { GitOwnerOperation } from './git-owner.operation';
import { RemoteOperationRunner } from './remote-operation.runner';
import { RemoteOperationsService } from './remote-operations.service';
import { RemoteOperationsController } from './remote-operations.controller';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Real SQLite, the runner and live queue prove HTTP admission and durable recovery without real peers.
describe('persisted Git switches', () => {
  let app: NestFastifyApplication;
  let database: ReturnType<typeof createTestDatabase>;
  let storage: LocalStorageService;
  let owners: GitOwnerStore;
  let runner: RemoteOperationRunner;
  let live: RemoteLiveSyncService;
  let upkeep: RemoteFileSyncService;
  let seed: SeededRemoteProject;
  let directory: string;
  let remoteId: string;
  let home: FakeFileSyncService;
  let vm: FakeFileSyncService;
  let order: string[];
  let sessions: RemoteSession[];
  let vmGuard: boolean;
  let pcGuard: boolean;
  let staged: string;
  let health: { online: boolean; versionMatches: boolean; apiKeyRejected: boolean };
  let host: {
    listSessions: jest.Mock;
    syncDevice: jest.Mock;
    syncPeer: jest.Mock;
    syncFolderConfiguration: jest.Mock;
    syncStatus: jest.Mock;
    syncScan: jest.Mock;
    syncRevert: jest.Mock;
    syncFolderType: jest.Mock;
    installGitGuard: jest.Mock;
    removeGitGuard: jest.Mock;
    freeze: jest.Mock;
    stopSessions: jest.Mock;
    thaw: jest.Mock;
  };
  let guard: { install: jest.Mock; remove: jest.Mock };
  const gitId = () => `git:${seed.projectId}`;

  beforeEach(async () => {
    database = createTestDatabase();
    directory = mkdtempSync(join(tmpdir(), 'devchain-git-switch-'));
    storage = new LocalStorageService(
      database.db,
      new IntegrationCredentialCipher({
        secretDirectory: directory,
        machineIdentity: 'git-switch:u',
      }),
    );
    seed = seedRemoteProject(database.sqlite);
    remoteId = (
      await storage.createRemote({
        name: 'Git VM',
        kind: 'address',
        baseUrl: 'https://127.0.0.1:4000',
      })
    ).id;
    await storage.createRemoteProjectBinding({ projectId: seed.projectId, remoteId });
    await storage.updateRemoteProjectBinding(seed.projectId, { state: 'remote' });
    owners = new GitOwnerStore(database.db);
    home = new FakeFileSyncService();
    vm = new FakeFileSyncService();
    home.gitProjects.add(seed.projectId);
    home.peers.add(vm.deviceId);
    vm.peers.add(home.deviceId);
    for (const files of [home, vm])
      for (const kind of ['code', 'git'] as const)
        await files.ensureFolder({
          projectId: seed.projectId,
          kind,
          type: kind === 'code' ? 'sendreceive' : files === home ? 'receiveonly' : 'sendonly',
          peerDeviceId: files === home ? vm.deviceId : home.deviceId,
          ignores: [],
        });
    order = [];
    sessions = [];
    vmGuard = false;
    pcGuard = true;
    staged = 'live staged state';
    health = { online: true, versionMatches: true, apiKeyRejected: false };
    const healthPort = { getState: () => health, refresh: async () => health };
    const bindings = { get: (id: string) => storage.getRemoteProjectBinding(id) };
    host = {
      listSessions: jest.fn(async () => sessions),
      syncDevice: jest.fn(async () => vm.device()),
      syncPeer: jest.fn(async () => undefined),
      syncFolderConfiguration: jest.fn((_: string, id: string) => vm.folderConfiguration(id)),
      syncStatus: jest.fn((_: string, id: string, device?: string) => vm.status(id, device)),
      syncScan: jest.fn(async () => undefined),
      syncRevert: jest.fn((_: string, id: string) => vm.revertLocalChanges(id)),
      syncFolderType: jest.fn((_: string, id: string, patch) => vm.updateFolder(id, patch)),
      installGitGuard: jest.fn(async () => {
        const [row] = await storage.listRemoteOperations({
          projectId: seed.projectId,
          states: ['running'],
        });
        expect(row.details.vmGuardInstalled).toBe(true);
        order.push('vm_guard');
        vmGuard = true;
        return { warning: null };
      }),
      removeGitGuard: jest.fn(
        async (_: string, _project: string, options?: { refreshIndex?: boolean }) => {
          vmGuard = false;
          order.push('vm_remove');
          return {
            removed: true,
            indexRefreshed: options?.refreshIndex ? true : null,
            warning: null,
          };
        },
      ),
      freeze: jest.fn(async () => {
        order.push('freeze');
      }),
      stopSessions: jest.fn(async () => {
        order.push('stop');
        sessions = [];
      }),
      thaw: jest.fn(async () => {
        order.push('thaw');
      }),
    };
    guard = {
      install: jest.fn(async () => {
        pcGuard = true;
        return null;
      }),
      remove: jest.fn(async (_project: string, options: { refreshIndex: boolean }) => {
        pcGuard = false;
        if (options.refreshIndex) staged = 'rebuilt index';
        order.push(`pc_remove:${options.refreshIndex}`);
        return { removed: true, indexRefreshed: options.refreshIndex ? true : null, warning: null };
      }),
    };
    const git = { mirroredHead: jest.fn(async () => 'head'), refreshIndexFromHead: jest.fn() };
    upkeep = new RemoteFileSyncService(
      home as never,
      host as never,
      bindings as never,
      healthPort as never,
      { get: () => [] } as never,
      git as never,
      guard as never,
      storage,
      { get: () => ({ enabled: false }) } as never,
      {} as never,
      owners,
    );
    live = new RemoteLiveSyncService(
      healthPort as never,
      bindings as never,
      host as never,
      {} as never,
      {} as never,
      upkeep,
    );
    live.start(seed.projectId, remoteId);
    const handoff = new FileSyncHandoff(
      home as never,
      host as never,
      { get: () => [] } as never,
      guard as never,
      new FakeProcessExecutor(),
      owners,
    );
    const definition = new GitOwnerOperation(
      healthPort as never,
      bindings as never,
      host as never,
      home as never,
      handoff,
      live,
      owners,
      guard as never,
    );
    runner = new RemoteOperationRunner(
      storage,
      { broadcastEvent: jest.fn() },
      { kind: 'attach', steps: [] } as never,
      { kind: 'detach', steps: [] } as never,
      { kind: 'claim', steps: [] } as never,
      { kind: 'update_host', steps: [] } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      definition,
    );
    const service = new RemoteOperationsService(
      storage,
      runner,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      healthPort as never,
      {} as never,
      upkeep,
      definition,
      owners,
      host as never,
    );
    const module = await Test.createTestingModule({
      controllers: [RemoteOperationsController],
      providers: [{ provide: RemoteOperationsService, useValue: service }],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    for (const row of await storage.listRemoteOperations()) await runner.whenIdle(row.id);
    runner.onApplicationShutdown();
    await live.onApplicationShutdown();
    await app.close();
    database.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const start = (owner: GitOwner = 'home', force = false) =>
    app.inject({
      method: 'POST',
      url: `/api/remotes/${remoteId}/git-owner`,
      payload: { projectId: seed.projectId, owner, force },
    });
  const status = () =>
    app.inject({ method: 'GET', url: `/api/remotes/git-owner?projectId=${seed.projectId}` });
  const rows = () => storage.listRemoteOperations({ projectId: seed.projectId });
  const finish = async (id: string) => {
    await runner.whenIdle(id);
    return storage.getRemoteOperation(id);
  };
  const session = (activityState: RemoteSession['activityState'], age: number): RemoteSession => ({
    id: 'vm-session',
    agentId: seed.leadAgentId,
    status: 'running',
    startedAt: new Date(Date.now() - age).toISOString(),
    activityState,
    busySince: new Date(Date.now() - 1000).toISOString(),
  });
  const homeOwner = () => {
    owners.set(seed.projectId, 'home');
    home.folders.get(gitId())!.type = 'sendonly';
    vm.folders.get(gitId())!.type = 'receiveonly';
    vmGuard = true;
    pcGuard = false;
  };

  it.each([
    ['busy', 900_000, 'busy'],
    [null, 599_000, 'starting'],
    [null, 600_000, 'unknown'],
    ['idle', 1000, 'idle'],
  ] as const)('applies agent-state admission for %s at age %i', async (activity, age, state) => {
    sessions = [session(activity, age)];
    const name = (await storage.getAgent(seed.leadAgentId)).name;
    const response = await start();
    if (state === 'busy' || state === 'starting') {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'GIT_TAKE_AGENTS_BUSY',
        details: { agents: [{ agentName: name, state, since: expect.any(String) }] },
      });
      expect(await rows()).toEqual([]);
    } else {
      expect(response.statusCode).toBe(202);
      const done = await finish(response.json<RemoteOperation>().id);
      expect(done.state).toBe('done');
      expect(done.details.unknownAgents).toEqual(
        state === 'unknown'
          ? [{ agentName: name, state: 'unknown', since: sessions[0].startedAt }]
          : [],
      );
    }
  });

  it('saves nothing on busy refusal and takes Git after the agent becomes idle', async () => {
    sessions = [session('busy', 1000)];
    expect((await start()).statusCode).toBe(409);
    expect(await rows()).toEqual([]);
    sessions[0].activityState = 'idle';
    const response = await start();
    expect(response.statusCode).toBe(202);
    expect((await finish(response.json<RemoteOperation>().id)).state).toBe('done');
    expect(owners.get(seed.projectId)).toBe('home');
    expect(vmGuard).toBe(true);
    expect(pcGuard).toBe(false);
    expect(home.folders.get(gitId())!.type).toBe('sendonly');
    expect(vm.folders.get(gitId())!.type).toBe('receiveonly');
    expect((await status()).json()).toMatchObject({
      connected: true,
      remoteId,
      remoteName: 'Git VM',
      owner: 'home',
      open: null,
    });
    expect((await start()).json()).toEqual({ owner: 'home', changed: false });
    expect(await rows()).toHaveLength(1);
  });

  it.each([
    'binding',
    'offline',
    'key',
    'version',
    'peer',
    'git folder',
    'paused',
    'VM read',
    'sessions read',
  ] as const)('refuses %s before writing a switch', async (failure) => {
    const codes = {
      binding: 'GIT_PROJECT_NOT_CONNECTED',
      offline: 'GIT_REMOTE_OFFLINE',
      key: 'HOST_API_KEY_REJECTED',
      version: 'GIT_REMOTE_VERSION_MISMATCH',
      peer: 'GIT_SYNC_DISCONNECTED',
      'git folder': 'GIT_SYNC_FOLDER_MISSING',
      paused: 'GIT_SYNC_NOT_READY',
      'VM read': 'GIT_SYNC_UNAVAILABLE',
      'sessions read': 'GIT_TAKE_AGENTS_UNKNOWN',
    };
    if (failure === 'binding')
      await storage.updateRemoteProjectBinding(seed.projectId, { state: 'detaching' });
    if (failure === 'offline') health.online = false;
    if (failure === 'key') health.apiKeyRejected = true;
    if (failure === 'version') health.versionMatches = false;
    if (failure === 'peer') home.peers.clear();
    if (failure === 'git folder') home.folders.delete(gitId());
    if (failure === 'paused') home.folders.get(gitId())!.paused = true;
    if (failure === 'VM read') host.syncDevice.mockRejectedValueOnce(new Error('offline'));
    if (failure === 'sessions read') host.listSessions.mockRejectedValueOnce(new Error('offline'));
    const response = await start();
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe(codes[failure]);
    expect(await rows()).toEqual([]);
  });

  it('follows a running switch instead of creating another operation', async () => {
    const gate = deferred();
    host.installGitGuard.mockImplementationOnce(async () => {
      await gate.promise;
      return { warning: null };
    });
    const response = await start();
    try {
      const repeated = await start('home', true);
      expect(repeated.statusCode).toBe(202);
      expect(repeated.json<RemoteOperation>().id).toBe(response.json<RemoteOperation>().id);
      expect(await rows()).toHaveLength(1);
    } finally {
      gate.resolve();
    }
    expect((await finish(response.json<RemoteOperation>().id)).state).toBe('done');
  });

  it('forces a refused take in freeze, stop, VM guard, thaw order', async () => {
    sessions = [session('busy', 1000)];
    expect((await start()).statusCode).toBe(409);
    const response = await start('home', true);
    expect(response.statusCode).toBe(202);
    expect((await finish(response.json<RemoteOperation>().id)).state).toBe('done');
    expect(order.slice(0, 4)).toEqual(['freeze', 'stop', 'vm_guard', 'thaw']);
    expect(host.stopSessions).toHaveBeenCalledWith(remoteId, seed.projectId);
    expect(host.listSessions).toHaveBeenCalledTimes(1);
    expect(owners.get(seed.projectId)).toBe('home');
  });

  it('retries cleanup after ownership was saved, retaining the index warning until success', async () => {
    guard.remove.mockResolvedValueOnce({
      removed: true,
      indexRefreshed: false,
      warning: 'index locked',
    });
    const response = await start();
    const id = response.json<RemoteOperation>().id;
    const failed = await finish(id);
    expect(failed.state).toBe('failed');
    expect(failed.details.pcGuardRemove).toMatchObject({
      indexRefreshed: false,
      warning: 'index locked',
    });
    expect(owners.get(seed.projectId)).toBe('home');
    expect((await status()).json()).toMatchObject({
      owner: 'home',
      open: {
        operationId: id,
        owner: 'home',
        state: 'failed',
        step: 'pc_guard_remove',
        error: { code: 'GIT_SWITCH_INDEX_REFRESH_FAILED' },
      },
    });
    health.online = false;
    const refused = await start();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('GIT_REMOTE_OFFLINE');
    expect((await storage.getRemoteOperation(id)).state).toBe('failed');
    health.online = true;
    sessions = [session('busy', 1000)];
    const repeated = await start();
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json<RemoteOperation>().id).toBe(id);
    const done = await finish(id);
    expect(done.state).toBe('done');
    expect(done.details.pcGuardRemove).toMatchObject({ indexRefreshed: true, warning: null });
    expect(host.installGitGuard).toHaveBeenCalledTimes(1);
    expect(host.listSessions).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  it.each(['home', 'vm'] as const)(
    'rolls back a failed switch to %s before the opposite command returns an unchanged owner',
    async (target) => {
      if (target === 'vm') homeOwner();
      const install = target === 'home' ? host.installGitGuard : guard.install;
      install.mockRejectedValueOnce(new Error('partial guard write'));
      const response = await start(target, target === 'home');
      const id = response.json<RemoteOperation>().id;
      expect((await finish(id)).state).toBe('failed');
      const owner = target === 'home' ? 'vm' : 'home';
      const opposite = await start(owner);
      expect(opposite.statusCode).toBe(200);
      expect(opposite.json()).toEqual({ owner, changed: false, cancelledOperationId: id });
      expect((await rows()).map((row) => row.state)).toEqual(['cancelled']);
      expect(staged).toBe('live staged state');
      if (target === 'home') expect(host.thaw).toHaveBeenCalledWith(remoteId, seed.projectId);
      expect(guard.remove.mock.calls.every((call) => call[1].refreshIndex === false)).toBe(true);
      expect(host.removeGitGuard.mock.calls.every((call) => call[2]?.refreshIndex !== true)).toBe(
        true,
      );
    },
  );

  it('propagates a failed rollback, retaining cancelError and starting nothing', async () => {
    host.installGitGuard.mockRejectedValueOnce(new Error('partial guard write'));
    const response = await start();
    const id = response.json<RemoteOperation>().id;
    await finish(id);
    host.removeGitGuard.mockRejectedValueOnce(new Error('VM unavailable'));
    expect((await start('vm')).statusCode).toBe(500);
    expect(await rows()).toHaveLength(1);
    const row = await storage.getRemoteOperation(id);
    expect(row.state).toBe('failed');
    expect(row.details.cancelError).toMatchObject({ message: 'VM unavailable' });
  });

  it.each(['vm direction', 'home direction', 'owner save'] as const)(
    'replays an interrupted flip after %s while upkeep shares its queue',
    async (boundary) => {
      const gate = deferred();
      const oldTick = live.runExclusive(seed.projectId, async (active) => {
        await gate.promise;
        await upkeep.tick(seed.projectId, remoteId, active);
      });
      const ensure = jest.spyOn(home, 'ensureFolder');
      if (boundary === 'vm direction') {
        host.syncFolderType.mockImplementationOnce(async (_r, id, patch) => {
          await vm.updateFolder(id, patch);
          throw new Error('VM direction answer lost');
        });
      } else if (boundary === 'home direction') {
        const update = home.updateFolder.bind(home);
        jest.spyOn(home, 'updateFolder').mockImplementationOnce(async (id, patch) => {
          await update(id, patch);
          throw new Error('PC direction interrupted');
        });
      } else {
        const set = owners.set.bind(owners);
        jest.spyOn(owners, 'set').mockImplementationOnce((id, owner) => {
          set(id, owner);
          throw new Error('Owner save interrupted');
        });
      }
      const response = await start();
      const id = response.json<RemoteOperation>().id;
      expect(home.folders.get(gitId())!.type).toBe('receiveonly');
      gate.resolve();
      await oldTick;
      const failed = await finish(id);
      expect(failed.steps.find((step) => step.id === 'git_flip')?.state).toBe('failed');
      const cancel = await app.inject({
        method: 'POST',
        url: `/api/remotes/operations/${id}/cancel`,
      });
      expect(cancel.statusCode).toBe(409);
      expect(cancel.json().code).toBe('GIT_SWITCH_UNFINISHED');
      expect((await start('vm')).json()).toMatchObject({
        code: 'GIT_SWITCH_UNFINISHED',
        message: expect.stringContaining('devchain git take'),
      });
      const cleanup = deferred();
      guard.remove.mockImplementationOnce(async () => {
        await cleanup.promise;
        return { removed: true, indexRefreshed: true, warning: null };
      });
      const repeated = await start();
      const concurrentTick = live.runExclusive(seed.projectId, (active) =>
        upkeep.tick(seed.projectId, remoteId, active),
      );
      expect(repeated.json<RemoteOperation>().id).toBe(id);
      try {
        await concurrentTick;
      } finally {
        cleanup.resolve();
      }
      expect((await finish(id)).state).toBe('done');
      expect(owners.get(seed.projectId)).toBe('home');
      expect(home.folders.get(gitId())).toMatchObject({ type: 'sendonly', paused: false });
      expect(vm.folders.get(gitId())).toMatchObject({ type: 'receiveonly', paused: false });
      expect(ensure).not.toHaveBeenCalled();
    },
  );

  it('returns Git to the VM without checking agents and rebuilds its index', async () => {
    homeOwner();
    sessions = [session('busy', 1000)];
    const response = await start('vm');
    expect(response.statusCode).toBe(202);
    const row = await finish(response.json<RemoteOperation>().id);
    expect(row.state).toBe('done');
    expect(row.details.vmGuardRemove).toMatchObject({ indexRefreshed: true, warning: null });
    expect(owners.get(seed.projectId)).toBe('vm');
    expect(home.folders.get(gitId())!.type).toBe('receiveonly');
    expect(vm.folders.get(gitId())!.type).toBe('sendonly');
    expect(vmGuard).toBe(false);
    expect(pcGuard).toBe(true);
    expect(host.listSessions).not.toHaveBeenCalled();
  });

  it('fails on a guard warning instead of saving ownership or claiming a successful switch', async () => {
    host.installGitGuard.mockResolvedValueOnce({ warning: 'VM guard skipped: custom hooksPath' });
    const response = await start();
    const row = await finish(response.json<RemoteOperation>().id);
    expect(row.state).toBe('failed');
    expect(row.details).toMatchObject({
      vmGuardInstalled: false,
      vmGuardWarning: 'VM guard skipped: custom hooksPath',
    });
    expect(owners.get(seed.projectId)).toBe('vm');
    expect(guard.remove).not.toHaveBeenCalled();
  });

  it('installs the VM guard again when a forward retry follows a partial cancel', async () => {
    host.syncScan.mockRejectedValueOnce(new Error('scan unavailable'));
    const response = await start('home', true);
    const id = response.json<RemoteOperation>().id;
    const failed = await finish(id);
    expect(failed.state).toBe('failed');
    expect(failed.steps.find((step) => step.id === 'git_settle')?.state).toBe('failed');
    expect(vmGuard).toBe(true);
    host.thaw.mockRejectedValueOnce(new Error('thaw response lost'));
    expect((await start('vm')).statusCode).toBe(500);
    expect(vmGuard).toBe(false);
    expect((await storage.getRemoteOperation(id)).details.cancelError).toBeDefined();
    const repeated = await start('home', true);
    expect(repeated.statusCode).toBe(202);
    expect((await finish(id)).state).toBe('done');
    expect(owners.get(seed.projectId)).toBe('home');
    expect(vmGuard).toBe(true);
  });

  it('installs the VM guard again when a restart resumes a running cancel before git_flip', async () => {
    const thawEntered = deferred();
    const thawRelease = deferred();
    host.thaw.mockImplementationOnce(async () => {
      thawEntered.resolve();
      await thawRelease.promise;
    });
    let snapshot!: RemoteOperation;
    const remove = host.removeGitGuard.getMockImplementation()!;
    host.removeGitGuard.mockImplementationOnce(async (...args) => {
      const result = await remove(...args);
      const [row] = await rows();
      snapshot = await storage.getRemoteOperation(row.id);
      return result;
    });
    const response = await start('home', true);
    const id = response.json<RemoteOperation>().id;
    await thawEntered.promise;
    const cancelling = runner.cancel(id);
    // Let cancel record its request while the successful thaw step is still in flight.
    await new Promise<void>((resolve) => setImmediate(resolve));
    thawRelease.resolve();
    await cancelling;
    await runner.whenIdle(id);
    expect(snapshot.state).toBe('running');
    expect(snapshot.steps.find((step) => step.id === 'vm_guard')?.state).toBe('done');
    expect(snapshot.steps.find((step) => step.id === 'git_flip')?.state).toBe('pending');
    expect(vmGuard).toBe(false);
    // Restore exactly the last durable row at the crash boundary after guard removal,
    // before rollback can mark cancellation complete. External guard removal survives.
    await storage.updateRemoteOperation(id, {
      state: snapshot.state,
      details: snapshot.details,
      steps: snapshot.steps,
    });
    await runner.onApplicationBootstrap();
    expect((await finish(id)).state).toBe('done');
    expect(owners.get(seed.projectId)).toBe('home');
    expect(vmGuard).toBe(true);
  });

  it('refuses a retry of a running switch at once', async () => {
    const entered = deferred();
    const release = deferred();
    const install = host.installGitGuard.getMockImplementation()!;
    host.installGitGuard.mockImplementationOnce(async (...args: unknown[]) => {
      entered.resolve();
      await release.promise;
      return install(...args);
    });
    const id = (await start()).json<RemoteOperation>().id;
    await entered.promise;
    const retry = await app.inject({ method: 'POST', url: `/api/remotes/operations/${id}/retry` });
    expect(retry.statusCode).toBe(409);
    release.resolve();
    expect((await finish(id)).state).toBe('done');
  });
});
