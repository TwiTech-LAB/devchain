// SQLite and the real runner prove persistence/recovery; app.inject covers the start route contract.
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { ForceSyncOperation } from './force-sync.operation';
import { RemoteOperationRunner } from './remote-operation.runner';
import { RemoteOperationsController } from './remote-operations.controller';
import { RemoteOperationsService } from './remote-operations.service';
import type { RemoteOperationStepRun } from './remote-operation.types';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('persisted Force sync', () => {
  let app: NestFastifyApplication;
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let runner: RemoteOperationRunner;
  let service: RemoteOperationsService;
  let directory: string;
  let projectId: string;
  let remoteId: string;
  let order: string[];
  let upkeep: { forceSyncOffer: jest.Mock; forget: jest.Mock };
  let host: { freeze: jest.Mock; stopSessions: jest.Mock; thaw: jest.Mock };
  let handoff: { forceCopy: jest.Mock; restoreConnected: jest.Mock };

  beforeEach(async () => {
    const database = createTestDatabase();
    sqlite = database.sqlite;
    directory = mkdtempSync(join(tmpdir(), 'devchain-force-sync-operation-'));
    storage = new LocalStorageService(
      database.db,
      new IntegrationCredentialCipher({
        secretDirectory: directory,
        machineIdentity: 'force-sync-test:u',
      }),
    );
    const remote = await storage.createRemote({
      name: 'VM',
      kind: 'address',
      baseUrl: 'https://127.0.0.1:4000',
    });
    remoteId = remote.id;
    const project = await storage.createProject({
      name: 'Force sync',
      description: null,
      rootPath: directory,
      isTemplate: false,
    });
    projectId = project.id;
    await storage.createRemoteProjectBinding({ projectId, remoteId });
    await storage.updateRemoteProjectBinding(projectId, { state: 'remote' });
    order = [];
    upkeep = {
      forceSyncOffer: jest.fn(async () => ({
        offered: true,
        reason: null,
        pending: { fromVm: 1, fromHome: 2 },
      })),
      forget: jest.fn(() => {
        order.push('forget');
      }),
    };
    host = {
      freeze: jest.fn(async () => {
        order.push('freeze');
      }),
      stopSessions: jest.fn(async () => {
        order.push('stop');
      }),
      thaw: jest.fn(async () => {
        order.push('thaw');
      }),
    };
    handoff = {
      forceCopy: jest.fn(async (run: RemoteOperationStepRun, _: string, source: string) => {
        order.push('copy');
        await run.progress(
          {
            forceSync: {
              ...(run.details.forceSync as object),
              backups: [
                { side: source === 'home' ? 'vm' : 'home', kind: 'code', path: '/backups/code' },
              ],
              replaced: { count: 2, sample: ['changed'] },
              verified: true,
            },
          },
          { durable: true },
        );
      }),
      restoreConnected: jest.fn(async () => {
        order.push('restore');
      }),
    };
    const facts = { exists: true, repository: true };
    const definition = new ForceSyncOperation(
      storage,
      { refresh: async () => ({ online: true, versionMatches: true }) } as never,
      { get: (id: string) => storage.getRemoteProjectBinding(id) } as never,
      {
        ...host,
        syncDevice: async () => ({ deviceId: 'VM' }),
        syncInspect: async () => facts,
      } as never,
      { isConnected: async () => true, folderPath: async () => directory } as never,
      {
        inspect: async () => {
          order.push('preflight');
          return facts;
        },
      } as never,
      { ...handoff, ensureAvailable: async () => undefined } as never,
      { runExclusive: async (_: string, work: () => Promise<void>) => work() } as never,
      upkeep as never,
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
      definition,
    );
    service = new RemoteOperationsService(
      storage,
      runner,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      upkeep as never,
      {} as never,
      {} as never,
      {} as never,
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
    for (const operation of await storage.listRemoteOperations())
      await runner.whenIdle(operation.id);
    runner.onApplicationShutdown();
    await app.close();
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const start = (source: 'home' | 'vm' = 'home') =>
    app.inject({
      method: 'POST',
      url: `/api/remotes/${remoteId}/force-sync`,
      payload: { projectId, source },
    });
  async function settle(id: string): Promise<RemoteOperation> {
    await runner.whenIdle(id);
    return storage.getRemoteOperation(id);
  }

  it.each(['home', 'vm'] as const)(
    'persists %s and finishes only after restore, warning reset and thaw',
    async (source) => {
      const response = await start(source);
      expect(response.statusCode).toBe(202);
      const done = await settle(response.json().id);
      expect(done.state).toBe('done');
      expect(order).toEqual(['preflight', 'freeze', 'stop', 'copy', 'restore', 'forget', 'thaw']);
      expect(done.steps.map((step) => step.id)).toEqual([
        'preflight',
        'freeze_host',
        'stop_host_sessions',
        'force_copy',
        'restore',
        'thaw_host',
      ]);
      expect(done.steps[3].label).toBe(
        `Copy files from ${source === 'home' ? 'this PC' : 'the VM'}`,
      );
      expect(done.details).toMatchObject({
        source,
        kinds: ['code', 'git'],
        forceSync: {
          source,
          kinds: ['code', 'git'],
          backups: [{ path: '/backups/code' }],
          replaced: { count: 2 },
          verified: true,
        },
      });
      expect(upkeep.forceSyncOffer).toHaveBeenCalledTimes(1);
    },
  );

  it('returns the current offer refusal as 409 without creating an operation', async () => {
    upkeep.forceSyncOffer.mockResolvedValue({
      offered: false,
      reason: 'Repair file permissions before using Force sync.',
    });
    const response = await start();
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('Repair file permissions before using Force sync.');
    expect(await storage.listRemoteOperations()).toEqual([]);
    expect(handoff.forceCopy).not.toHaveBeenCalled();
  });

  it.each([
    { projectId: '', source: 'home' },
    { projectId: undefined, source: 'vm' },
    { source: undefined },
    { source: 'other' },
    { source: 'home', extra: true },
  ])('validates a start body before checking the offer: %j', async (payload) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/remotes/${remoteId}/force-sync`,
      payload: { projectId, ...payload },
    });
    expect(response.statusCode).toBe(400);
    expect(upkeep.forceSyncOffer).not.toHaveBeenCalled();
  });

  it('lets the SQLite project guard reject a second start even if both fresh offers allow it', async () => {
    const ready = deferred();
    const finish = deferred();
    handoff.forceCopy.mockImplementationOnce(async () => {
      ready.resolve();
      await finish.promise;
    });
    const first = await start();
    await ready.promise;
    try {
      const second = await start('vm');
      expect(second.statusCode).toBe(409);
      expect(upkeep.forceSyncOffer).toHaveBeenCalledTimes(2);
      expect(await storage.listRemoteOperations()).toHaveLength(1);
    } finally {
      finish.resolve();
    }
    await settle(first.json().id);
  });

  it.each(['force_copy', 'restore'] as const)(
    'retries a failed %s with the original source and completed predecessors',
    async (failedStep) => {
      const target = failedStep === 'force_copy' ? handoff.forceCopy : handoff.restoreConnected;
      target.mockRejectedValueOnce(new Error(`${failedStep} unavailable`));
      const response = await start('vm');
      const failed = await settle(response.json().id);
      expect(failed.state).toBe('failed');
      expect(failed.steps.find((step) => step.id === failedStep)?.state).toBe('failed');
      expect(host.thaw).not.toHaveBeenCalled();
      expect(upkeep.forget).not.toHaveBeenCalled();
      // Retry must work after the original warning disappears.
      upkeep.forceSyncOffer.mockResolvedValue({
        offered: false,
        reason: 'There is no stuck problem.',
      });
      await runner.retry(failed.id);
      const done = await settle(failed.id);
      expect(done.state).toBe('done');
      expect(done.details).toMatchObject({
        source: 'vm',
        kinds: ['code', 'git'],
        forceSync: { source: 'vm', verified: true, backups: [{ path: '/backups/code' }] },
      });
      expect(upkeep.forceSyncOffer).toHaveBeenCalledTimes(1);
      expect(host.freeze).toHaveBeenCalledTimes(1);
      expect(handoff.forceCopy).toHaveBeenCalledTimes(failedStep === 'force_copy' ? 2 : 1);
      expect(handoff.restoreConnected).toHaveBeenCalledTimes(failedStep === 'restore' ? 2 : 1);
      expect(host.thaw).toHaveBeenCalledTimes(1);
    },
  );

  it('cancels before copy, keeps repository notes and thaws the host', async () => {
    host.stopSessions.mockRejectedValueOnce(new Error('sessions unavailable'));
    const response = await start();
    const failed = await settle(response.json().id);
    await storage.updateRemoteOperation(failed.id, {
      details: {
        ...failed.details,
        gitInit: 'created',
        forceSync: { ...(failed.details.forceSync as object), gitInit: 'created' },
      },
    });
    const cancelled = await runner.cancel(failed.id);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.details).toMatchObject({
      gitInit: 'created',
      forceSync: { gitInit: 'created' },
    });
    expect(host.thaw).toHaveBeenCalledTimes(1);
    expect(handoff.forceCopy).not.toHaveBeenCalled();
  });

  it('refuses Cancel after copying and allows only a forced Disconnect to supersede the failed operation', async () => {
    handoff.restoreConnected.mockRejectedValueOnce(new Error('restore unavailable'));
    const response = await start();
    const failed = await settle(response.json().id);
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/remotes/operations/${failed.id}/cancel`,
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().message).toBe('Force sync is copying; retry it, or force a disconnect.');
    await expect(service.detach(remoteId, projectId, false)).rejects.toThrow('Force sync failed');
    const detach = await service.detach(remoteId, projectId, true);
    await settle(detach.id);
    const superseded = await storage.getRemoteOperation(failed.id);
    expect(superseded.state).toBe('cancelled');
    expect(superseded.details).toMatchObject({
      supersededBy: detach.id,
      forceSync: failed.details.forceSync,
    });
  });
});
