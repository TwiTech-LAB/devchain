// HTTP with migrated SQLite is the cheapest layer for the start guards and durable
// confirmations. A stateful host transport exposes fence lifetime and final races.
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { AppError, ConflictError } from '../../../common/errors/error-types';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { SharedVmOccupancy } from '../dtos/shared-vm.dto';
import { homeIdentity } from '../home-identity';
import { RemoteHostClient, RemoteHostRequestError } from '../operations/remote-host.client';
import { VmOperationsService } from '../operations/vm-operations.service';
import { VmOperationsController } from '../operations/vm-operations.controller';
import { DestroyVmOperation } from '../operations/destroy-vm.operation';
import { ResetVmOperation } from '../operations/reset-vm.operation';
import { RemoteOperationRunner } from '../operations/remote-operation.runner';
import { RemoteOperationsService } from '../operations/remote-operations.service';
import { RemoteOperationsController } from '../operations/remote-operations.controller';
import { RemoteSharedVmService } from './remote-shared-vm.service';
import { RemoteSharedVmStore } from './remote-shared-vm.store';

const instance = (user: string, ids: string[] | 'unknown') => ({
  user,
  port: user === homeIdentity().user ? 3000 : 3001,
  version: '0.25.0',
  connectedCount: ids === 'unknown' ? ('unknown' as const) : ids.length,
  connectedProjectIds: ids,
});

describe('Home shared VM destructive-operation guard', () => {
  let database: ReturnType<typeof createTestDatabase>;
  let directory: string;
  let storage: LocalStorageService;
  let store: RemoteSharedVmStore;
  let service: RemoteSharedVmService;
  let app: NestFastifyApplication;
  let remoteId: string;
  let roster: unknown;
  let unavailable: boolean;
  let fence: string | null;
  let fenceFailure: Error | null;
  let loseFenceReply: boolean;
  let deletes: number;
  let trace: string[];
  let host: RemoteHostClient;
  let runner: RemoteOperationRunner;
  let beforeFinal: (() => void) | null;
  let progress: RemoteOperation[];

  beforeEach(async () => {
    database = createTestDatabase();
    directory = mkdtempSync(join(tmpdir(), 'shared-vm-home-'));
    storage = new LocalStorageService(
      database.db,
      new IntegrationCredentialCipher({ secretDirectory: directory, machineIdentity: 'shared-vm' }),
    );
    const connection = await storage.createVmProviderConnection({
      kind: 'proxmox',
      name: 'Lab',
      apiUrl: 'https://pve.example',
      node: 'hw',
      pool: 'devchain',
      storage: 'local-lvm',
      imageStorage: 'local',
      bridge: 'vmbr0',
      vmidMin: 100,
      vmidMax: 200,
      namePrefix: 'dc-',
      tag: 'devchain',
      sslFingerprint: 'a'.repeat(64),
      tokenId: 'root@pam!devchain',
      tokenSecret: 'test-token',
    });
    const remote = await storage.createRemote({
      kind: 'proxmox',
      name: 'Shared VM',
      baseUrl: 'http://vm.example:3000',
      vmProviderConnectionId: connection.id,
      vmIdentity: '12345678-1234-1234-1234-123456789abc',
      vmSpec: { cores: 2, memory: 2048, disk: 16 },
    });
    remoteId = remote.id;
    roster = { instances: [instance(homeIdentity().user, []), instance('bob', [])] };
    unavailable = false;
    fence = null;
    fenceFailure = null;
    loseFenceReply = false;
    deletes = 0;
    trace = [];
    host = {
      sharedVmRoster: async () => {
        trace.push('roster');
        if (unavailable) throw new Error('offline');
        return roster;
      },
      sharedVmFence: async (_id: string, input: { mode: string; operationId: string }) => {
        trace.push(input.mode);
        if (fenceFailure) throw fenceFailure;
        fence = input.mode === 'set' ? input.operationId : null;
        if (input.mode === 'set' && loseFenceReply) throw new Error('lost fence response');
        return { fence: null };
      },
      sharedVmNotify: async () => ({ results: [{ user: 'bob', delivered: true }] }),
    } as unknown as RemoteHostClient;
    store = new RemoteSharedVmStore(database.db);
    service = new RemoteSharedVmService(storage, host, store);
    beforeFinal = null;
    progress = [];
    const destroyDefinition = new DestroyVmOperation(
      storage,
      {
        forConnection: async () => ({
          assertOwnedVmIdentity: async () => 101,
          confirmsVmIdle: async () => false,
          destroyVm: async () => {
            expect(fence).not.toBeNull();
            deletes += 1;
          },
        }),
      } as never,
      {
        pullFamiliesNow: async () => {
          beforeFinal?.();
          return { pulled: true, families: [] };
        },
      } as never,
      {} as never,
      service,
    );
    runner = new RemoteOperationRunner(
      storage,
      {
        broadcastEvent: (_topic: string, type: string, payload: RemoteOperation) => {
          if (type === 'progress') progress.push(payload);
        },
      } as never,
      { kind: 'attach' } as never,
      { kind: 'detach' } as never,
      { kind: 'claim' } as never,
      { kind: 'update_host' } as never,
      undefined,
      undefined,
      destroyDefinition,
    );
    const remoteOperations = new RemoteOperationsService(
      storage,
      runner,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      host,
    );
    const vm = new VmOperationsService(
      storage,
      {
        start: (input: Parameters<LocalStorageService['createRemoteOperation']>[0]) =>
          storage.createRemoteOperation({ ...input, steps: [] }),
        supersedeFailedVmOperation: async () => null,
      } as never,
      {
        assertNoOpenHostOperation: async () => undefined,
        lastInstallDockerChoice: async () => false,
        claimDetails: async () => ({ providerAuth: {}, userName: homeIdentity().user }),
      } as never,
      { familiesOfRemote: async () => [] } as never,
      { forConnection: async () => ({ getOwnedVm: async () => ({ name: 'dc-shared' }) }) } as never,
      {} as never,
      {} as never,
      service,
    );
    const module = await Test.createTestingModule({
      controllers: [VmOperationsController, RemoteOperationsController],
      providers: [
        { provide: VmOperationsService, useValue: vm },
        { provide: RemoteSharedVmService, useValue: service },
        { provide: RemoteOperationsService, useValue: remoteOperations },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app?.close();
    runner?.onApplicationShutdown();
    database.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function occupancy(ids: string[] | 'unknown'): SharedVmOccupancy {
    return { unavailable: false, instances: [instance('bob', ids)] };
  }

  function others(ids: string[] | 'unknown'): void {
    roster = { instances: [instance(homeIdentity().user, []), instance('bob', ids)] };
  }

  async function operation(details: Record<string, unknown> = {}): Promise<RemoteOperation> {
    return storage.createRemoteOperation({
      kind: 'destroy_vm',
      remoteId,
      projectId: null,
      details,
      steps: [],
    });
  }

  async function destroy(
    op: RemoteOperation,
    extra: Partial<Parameters<RemoteSharedVmService['fencedDestroy']>[0]> = {},
  ): Promise<void> {
    await service.fencedDestroy({
      operation: op,
      details: op.details,
      confirmedIdle: async () => false,
      destroy: async () => {
        trace.push('delete');
        deletes += 1;
      },
      ...extra,
    });
  }

  it.each(['reset', 'destroy-vm'])(
    'refuses %s with users and counts before creating an operation',
    async (action) => {
      others(['b1', 'b2']);
      const response = await app.inject({
        method: 'POST',
        url: `/api/remotes/${remoteId}/${action}`,
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'VM_SHARED_PROJECTS_CONNECTED' });
      expect(response.json().message).toContain('bob (2 projects)');
      expect(await storage.listRemoteOperations({ remoteId })).toEqual([]);
    },
  );

  it.each(['reset', 'destroy-vm'])(
    'allows %s when every other user has zero projects',
    async (action) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/remotes/${remoteId}/${action}`,
        payload: {},
      });
      expect(response.statusCode).toBe(202);
      const saved = await storage.getRemoteOperation(response.json().id);
      expect(saved.details.confirmedOccupancy).toEqual(occupancy([]));
      expect(fence).toBeNull();
    },
  );

  it.each(['reset', 'destroy-vm'])(
    'keeps login force separate from occupancy force for %s',
    async (action) => {
      others(['b1']);
      const refused = await app.inject({
        method: 'POST',
        url: `/api/remotes/${remoteId}/${action}`,
        payload: { force: true },
      });
      expect(refused.statusCode).toBe(409);
      const accepted = await app.inject({
        method: 'POST',
        url: `/api/remotes/${remoteId}/${action}`,
        payload: { forceOccupied: true, confirmedOccupancy: occupancy(['b1']) },
      });
      expect(accepted.statusCode).toBe(202);
      expect((await storage.getRemoteOperation(accepted.json().id)).details).toMatchObject({
        force: false,
        forceOccupied: true,
        confirmedOccupancy: occupancy(['b1']),
      });
    },
  );

  it.each(['offline', 'legacy', 'invalid', 'missing-own', 'duplicate-user'])(
    'treats %s occupancy as unknown and requires explicit force',
    async (mode) => {
      if (mode === 'offline') unavailable = true;
      if (mode === 'legacy')
        roster = {
          instances: [
            instance(homeIdentity().user, []),
            { user: 'bob', port: 3001, version: null, connectedCount: 0 },
          ],
        };
      if (mode === 'invalid')
        roster = {
          instances: [
            instance(homeIdentity().user, []),
            { ...instance('bob', []), connectedCount: 1 },
          ],
        };
      if (mode === 'missing-own') roster = { instances: [instance('bob', [])] };
      if (mode === 'duplicate-user')
        roster = {
          instances: [instance(homeIdentity().user, []), instance('bob', []), instance('bob', [])],
        };
      await expect(service.assertAllowed(remoteId, {})).rejects.toMatchObject({
        code: 'VM_SHARED_PROJECTS_CONNECTED',
      });
      const confirmation = await service.assertAllowed(remoteId, { forceOccupied: true });
      expect(
        confirmation.unavailable ||
          confirmation.instances.some((i) => i.connectedProjectIds === 'unknown'),
      ).toBe(true);
    },
  );

  it('retains last roster across a store restart but never uses it as empty live occupancy', async () => {
    await service.context(remoteId);
    const restarted = new RemoteSharedVmStore(database.db);
    expect(restarted.read(remoteId)).toMatchObject({ ownUser: homeIdentity().user, roster });
    unavailable = true;
    const response = await app.inject({ url: `/api/remotes/${remoteId}/shared-vm` });
    expect(response.json()).toMatchObject({
      occupancy: { unavailable: true, instances: [] },
      lastRoster: { roster },
    });
    await expect(service.assertAllowed(remoteId, {})).rejects.toBeInstanceOf(AppError);
  });

  it('returns per-user Notify delivery results through the home endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/remotes/${remoteId}/shared-vm/notify`,
      payload: { action: 'reset', message: 'Please save work' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ results: [{ user: 'bob', delivered: true }] });
  });

  it('rechecks Reset occupancy in preflight before nested Disconnects or fencing', async () => {
    const remote = await storage.getRemote(remoteId);
    const confirmedOccupancy = await service.assertAllowed(remoteId, {});
    const details = {
      connectionId: remote.vmProviderConnectionId,
      oldIdentity: remote.vmIdentity,
      spec: { cores: 2, memory: 4096, disk: 16 },
      projectIds: [],
      force: false,
      confirmedOccupancy,
    };
    const op = await storage.createRemoteOperation({
      kind: 'reset_vm',
      remoteId,
      projectId: null,
      details,
      steps: [],
    });
    const reset = new ResetVmOperation(
      storage,
      {} as never,
      {} as never,
      { steps: [] } as never,
      { steps: [] } as never,
      { steps: [] } as never,
      {} as never,
      {} as never,
      service,
    );
    others(['new-project']);
    const preflight = reset.stepsFor(details).find((step) => step.id === 'preflight')!;
    await expect(
      preflight.run({ operation: op, details, progress: async () => undefined }),
    ).rejects.toMatchObject({ code: 'VM_SHARED_PROJECTS_CONNECTED' });
    expect(fence).toBeNull();
    expect(deletes).toBe(0);
    others([]);
    await expect(
      preflight.run({ operation: op, details, progress: async () => undefined }),
    ).resolves.toBeUndefined();
    expect(fence).toBeNull();
  });

  it.each(['equal-count-replacement', 'new-project', 'new-user', 'unknown-set', 'offline'])(
    'clears the final fence and refuses %s before deletion',
    async (change) => {
      others(['b1']);
      const confirmedOccupancy = await service.assertAllowed(remoteId, { forceOccupied: true });
      const op = await operation({ forceOccupied: true, confirmedOccupancy });
      if (change === 'equal-count-replacement') others(['b2']);
      if (change === 'new-project') others(['b1', 'b2']);
      if (change === 'new-user')
        roster = {
          instances: [
            instance(homeIdentity().user, []),
            instance('bob', ['b1']),
            instance('carol', []),
          ],
        };
      if (change === 'unknown-set') others('unknown');
      if (change === 'offline') unavailable = true;
      trace = [];
      await expect(destroy(op)).rejects.toMatchObject({ code: 'VM_SHARED_PROJECTS_CONNECTED' });
      expect(trace).toEqual(['set', 'roster', 'clear']);
      expect(fence).toBeNull();
      expect(deletes).toBe(0);
    },
  );

  it('admits fewer projects from the confirmed set and holds the fence through deletion', async () => {
    others(['b1']);
    const op = await operation({
      forceOccupied: true,
      confirmedOccupancy: occupancy(['b1', 'b2']),
    });
    await destroy(op, {
      destroy: async () => {
        expect(fence).toBe(op.id);
        trace.push('delete');
        deletes += 1;
      },
    });
    expect(deletes).toBe(1);
    expect(trace).toEqual(['set', 'roster', 'delete']);
    expect(fence).toBe(op.id);
  });

  it('allows explicit unknown force when the host and fence are unreachable', async () => {
    unavailable = true;
    fenceFailure = new Error('host unreachable');
    const op = await operation({
      forceOccupied: true,
      confirmedOccupancy: { unavailable: true, instances: [] },
    });
    await destroy(op);
    expect(deletes).toBe(1);
  });

  it('does not let force bypass a definitive owner-only fence refusal', async () => {
    fenceFailure = new RemoteHostRequestError('owner only', {
      remoteId,
      path: '/api/host/shared-vm/fence',
      status: 403,
      hostCode: 'HOST_OWNER_REQUIRED',
    });
    const op = await operation({
      forceOccupied: true,
      confirmedOccupancy: { unavailable: true, instances: [] },
    });
    await expect(destroy(op)).rejects.toBe(fenceFailure);
    expect(deletes).toBe(0);
  });

  it.each([false, true])(
    'retains an uncertain fence and clears only a proved idle failure (%s)',
    async (idle) => {
      const op = await operation({ confirmedOccupancy: occupancy([]) });
      await expect(
        destroy(op, {
          confirmedIdle: async () => idle,
          destroy: async () => {
            throw new Error('lost PVE response');
          },
        }),
      ).rejects.toThrow('lost PVE response');
      expect(fence).toBe(idle ? null : op.id);
      // A retry refused by the roster keeps the fence while the first deletion can still finish.
      others('unknown');
      await expect(
        destroy(op, {
          previouslyAttempted: true,
          confirmedGone: async () => false,
          confirmedIdle: async () => idle,
        }),
      ).rejects.toMatchObject({ code: 'VM_SHARED_PROJECTS_CONNECTED' });
      expect(fence).toBe(idle ? null : op.id);
      expect(deletes).toBe(0);
    },
  );

  it('retains the fence when a post-failure outcome lookup also fails', async () => {
    const op = await operation({ confirmedOccupancy: occupancy([]) });
    await expect(
      destroy(op, {
        confirmedIdle: async () => {
          throw new Error('PVE offline');
        },
        destroy: async () => {
          throw new Error('lost response');
        },
      }),
    ).rejects.toThrow('lost response');
    expect(fence).toBe(op.id);
  });

  it('clears a written fence with a lost acknowledgement after a proved idle deletion failure', async () => {
    loseFenceReply = true;
    const op = await operation({ forceOccupied: true, confirmedOccupancy: occupancy([]) });
    await expect(
      destroy(op, {
        confirmedIdle: async () => true,
        destroy: async () => {
          throw new Error('PVE refused');
        },
      }),
    ).rejects.toThrow('PVE refused');
    expect(fence).toBeNull();
  });

  it('clears an initial ownership refusal without requiring a task lookup', async () => {
    const op = await operation({ confirmedOccupancy: occupancy([]) });
    await expect(
      destroy(op, {
        destroy: async () => {
          throw new ConflictError('Not owned');
        },
      }),
    ).rejects.toThrow('Not owned');
    expect(fence).toBeNull();
  });

  it('renews the same fence on retry and completes a confirmed-gone retry without contacting the deleted host', async () => {
    const op = await operation({ confirmedOccupancy: occupancy([]) });
    await expect(
      destroy(op, {
        destroy: async () => {
          throw new Error('timeout');
        },
      }),
    ).rejects.toThrow('timeout');
    trace = [];
    await destroy(op, { previouslyAttempted: true, confirmedGone: async () => false });
    expect(trace).toEqual(['set', 'roster', 'delete']);
    trace = [];
    unavailable = true;
    fenceFailure = new Error('VM gone');
    await destroy(op, { previouslyAttempted: true, confirmedGone: async () => true });
    expect(trace).toEqual(['delete']);
    expect(deletes).toBe(2);
  });

  it('refuses after preflight, keeps the old confirmation on Retry, and resumes the same step after explicit re-confirmation', async () => {
    const remote = await storage.getRemote(remoteId);
    beforeFinal = () => others(['new-project']);
    const started = await runner.start({
      kind: 'destroy_vm',
      remoteId,
      projectId: null,
      details: {
        connectionId: remote.vmProviderConnectionId,
        vmIdentity: remote.vmIdentity,
        expectedRemoteIdentity: remote.vmIdentity,
        force: false,
        confirmedOccupancy: occupancy([]),
      },
    });
    await runner.whenIdle(started.id);
    const stopped = await storage.getRemoteOperation(started.id);
    expect(stopped.steps.find((step) => step.id === 'preflight')?.state).toBe('done');
    expect(stopped.steps.find((step) => step.id === 'destroy')).toMatchObject({
      state: 'failed',
      error: { code: 'VM_SHARED_PROJECTS_CONNECTED' },
    });
    expect(fence).toBeNull();
    expect(deletes).toBe(0);
    const retry = await app.inject({
      method: 'POST',
      url: `/api/remotes/operations/${started.id}/retry`,
      payload: {},
    });
    expect(retry.statusCode).toBe(202);
    await runner.whenIdle(started.id);
    expect((await storage.getRemoteOperation(started.id)).state).toBe('failed');
    expect(deletes).toBe(0);
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/remotes/operations/${started.id}/retry`,
      payload: {
        vm: { forceOccupied: true, confirmedOccupancy: occupancy(['new-project']) },
      },
    });
    expect(confirmed.statusCode).toBe(202);
    await runner.whenIdle(started.id);
    const done = progress.find((item) => item.id === started.id && item.state === 'done')!;
    expect(done.id).toBe(started.id);
    expect(done.state).toBe('done');
    expect(done.details).toMatchObject({
      force: false,
      forceOccupied: true,
      confirmedOccupancy: occupancy(['new-project']),
    });
    expect(deletes).toBe(1);
    expect(fence).toBe(started.id);
    await expect(storage.getRemote(remoteId)).rejects.toThrow();
  });
});
