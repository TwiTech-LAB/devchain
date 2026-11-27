import { createTestDatabase } from '../../../common/test/test-database.helper';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { resetEnvConfig } from '../../../common/config/env.config';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { EpicsController } from '../controllers/epics.controller';
import { EpicRelationsService } from './epic-relations.service';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AppError, OptimisticLockError } from '../../../common/errors/error-types';
import { externalImportIdempotencyKey } from '../../storage/local/helpers/external-import-key';
import { eventCatalog, type EventName } from '../../events/catalog';
import { CommittedEventStore } from '../../events/services/committed-event.store';
import { DurableEventDispatcherService } from '../../events/services/durable-event-dispatcher.service';
import {
  DurableEventRegistryService,
  type DurableEventSubscriber,
  type PreparedEvent,
} from '../../events/services/durable-event-registry.service';
import type { EventsService } from '../../events/services/events.service';
import { ExternalProviderError } from '../../external-integrations/errors/external-provider.errors';
import { ExternalTaskProviderRegistry } from '../../external-integrations/external-task-provider.registry';
import { ProviderOperationGate } from '../../external-integrations/sessions/provider-operation-gate';
import { ExternalSubtaskSyncSubscriber } from '../../external-integrations/subscribers/external-subtask-sync.subscriber';
import { ManagedProjectionLock } from '../../external-integrations/subscribers/managed-projection-lock';
import {
  fakeSubtaskSyncProvider,
  type FakeSubtaskSyncProvider,
} from '../../external-integrations/testing/fake-subtask-sync-provider.fixture';
import type { SettingsService } from '../../settings/services/settings.service';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import type {
  ExternalTaskLinkInput,
  IntegrationConnection,
} from '../../storage/models/domain.models';
import { createProjectWriteGateStub } from '../../storage/write-gate/testing/project-write-gate.stub';
import { EpicsService, type EpicOperationContext } from './epics.service';
import { markLinkProjectsSeeded } from '../../storage/local/helpers/external-link-receipts';
import { summarizeExternalTaskChange } from '../../mcp/services/handlers/external-task-resolution';
import { EpicEstimateLoggingService } from '../../epic-time/services/epic-estimate-logging.service';
import { EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE } from '../../epic-time/models/epic-time.models';
import { timeEntryNoteFingerprint } from '../../external-integrations/sessions/external-time-mutation.store';
import { RemoteHostRequestError } from '../../remotes/transport/host-transport';

// Layer: backend integration. Link safety depends on real SQLite transactions,
// durable delivery rows, and managed-subtask rows; only the vendor is faked.
describe('EpicsService external task links', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let secretDirectory: string;
  let storage: LocalStorageService;
  let vendor: FakeSubtaskSyncProvider;
  let lock: ManagedProjectionLock;
  let subscriber: ExternalSubtaskSyncSubscriber;
  let registry: DurableEventRegistryService;
  let dispatcher: DurableEventDispatcherService;
  let service: EpicsService;
  let announced: PreparedEvent[];
  let connection: IntegrationConnection;
  let projectId: string;
  let parentId: string;
  let childId: string;
  /** Relation writes need an agent actor. */
  let agentContext: EpicOperationContext;
  let claimedHost: boolean;

  /** Delivery only through the durable store: an announce that never ran changes nothing. */
  function startInstance(): void {
    registry = new DurableEventRegistryService();
    const store = new CommittedEventStore(db, registry);
    storage = new LocalStorageService(
      db,
      new IntegrationCredentialCipher({ secretDirectory, machineIdentity: 'link-test:user' }),
      store,
    );
    const events = {
      prepareCommitted: (name: EventName, payload: unknown) => ({
        id: randomUUID(),
        name,
        payload: eventCatalog[name].parse(payload),
        requestId: null,
        publishedAt: new Date().toISOString(),
      }),
      emitCommitted: (event: PreparedEvent) => announced.push(event),
      publish: jest.fn().mockResolvedValue(null),
      registerDurableSubscriber: (subscriber: DurableEventSubscriber) =>
        registry.register(subscriber),
    } as unknown as EventsService;
    lock = new ManagedProjectionLock();
    subscriber = new ExternalSubtaskSyncSubscriber(
      storage,
      events,
      new ExternalTaskProviderRegistry([vendor.adapter]),
      new ProviderOperationGate(),
      lock,
      { isClaimedHost: () => false },
    );
    subscriber.onModuleInit();
    dispatcher = new DurableEventDispatcherService(store, registry);
    service = new EpicsService(
      storage,
      events,
      { getAutoCleanStatusIds: jest.fn().mockReturnValue([]) } as unknown as SettingsService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      createProjectWriteGateStub() as never,
      {} as never,
      { pullNow: jest.fn() } as never,
      lock,
      { isClaimedHost: () => claimedHost },
      { write: jest.fn() },
    );
  }

  beforeEach(async () => {
    ({ sqlite, db } = createTestDatabase());
    sqlite.pragma('foreign_keys = ON');
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-external-link-'));
    vendor = fakeSubtaskSyncProvider('clickup');
    announced = [];
    claimedHost = false;
    startInstance();

    const project = await storage.createProject({
      name: 'Link project',
      rootPath: '/home/project-owner/link-project',
      description: null,
      isTemplate: false,
    });
    projectId = project.id;
    connection = await storage.replaceIntegrationConnection(
      {
        projectId,
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'clickup-token' },
        subtaskSyncEnabled: true,
      },
      async () => undefined,
    );
    const provider = await storage.createProvider({ name: 'provider-link-agent' });
    const profile = await storage.createAgentProfile({ projectId, name: 'Link agent profile' });
    const config = await storage.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: 'default',
      options: null,
      env: null,
    });
    const agent = await storage.createAgent({
      projectId,
      profileId: profile.id,
      providerConfigId: config.id,
      name: 'Link agent',
      isProjectOwner: true,
    });
    agentContext = { actor: { type: 'agent', id: agent.id } };
    parentId = (await service.createEpicForProject(projectId, { title: 'Parent' })).id;
    childId = (await service.createEpicForProject(projectId, { title: 'Child', parentId })).id;
    await dispatcher.dispatchAvailable();
  });

  afterEach(() => {
    sqlite.close();
    rmSync(secretDirectory, { recursive: true, force: true });
  });

  function link(remoteTaskId: string, generation = connection.generation): ExternalTaskLinkInput {
    return {
      connectionId: connection.id,
      connectionGeneration: generation,
      provider: 'clickup',
      remoteScopeKey: 'workspace-clickup',
      remoteTaskId,
      sourceSnapshot: {
        remoteKey: remoteTaskId,
        title: `Remote ${remoteTaskId}`,
        description: null,
        webUrl: `https://app.clickup.com/t/${remoteTaskId}`,
        workAreaId: 'list-clickup',
        workAreaName: 'ClickUp List',
        statusName: 'Open',
      },
    };
  }

  async function setLink(epicId: string, remoteTaskId: string) {
    const epic = await storage.getEpic(epicId);
    return service.updateEpicWithOutcome(
      epicId,
      { externalTask: { set: link(remoteTaskId) } },
      epic.version,
    );
  }

  async function clearLink(epicId: string) {
    const epic = await storage.getEpic(epicId);
    return service.updateEpic(epicId, { externalTask: { clear: true } }, epic.version);
  }

  /**
   * Disconnect as `IntegrationConnectionsService.disconnectConnection` does, with
   * its durable `integration.connection.deleted` delivery, then connect the same
   * workspace again: the link keeps no connection.
   */
  async function reconnect() {
    await storage.disconnectIntegrationConnection(
      { projectId, provider: 'clickup' },
      (retired) => ({
        id: randomUUID(),
        name: 'integration.connection.deleted',
        payload: eventCatalog['integration.connection.deleted'].parse({
          connectionId: retired.id,
          projectId,
          provider: retired.provider,
          generation: retired.generation,
          subtaskSyncEnabled: retired.subtaskSyncEnabled,
          syncSettingRevision: retired.syncSettingRevision,
          deletedAt: new Date().toISOString(),
        }),
        requestId: null,
        publishedAt: new Date().toISOString(),
      }),
    );
    await dispatcher.dispatchAvailable();
    connection = await storage.replaceIntegrationConnection(
      {
        projectId,
        provider: 'clickup',
        credentials: { provider: 'clickup', token: 'clickup-token-2' },
        subtaskSyncEnabled: true,
      },
      async () => undefined,
    );
  }

  function count(table: string): number {
    return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  function pendingDeliveries(): number {
    return (
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM event_handlers WHERE status != 'delivered'`)
        .get() as { n: number }
    ).n;
  }

  /** Projects the child under a linked parent and returns its confirmed row. */
  async function projectChildUnderLinkedParent() {
    await setLink(parentId, 'clickup-parent');
    await dispatcher.dispatchAvailable();
    const [row] = await storage.listExternalManagedSubtaskLinksForEpicSnapshot(childId);
    expect(row).toMatchObject({ operationPhase: 'confirmed' });
    return row!;
  }

  it('creates an epic with its relations and its link in one transaction', async () => {
    const epic = await service.createEpicForProject(
      projectId,
      {
        title: 'Linked',
        relations: [{ relatedEpicId: parentId, relation: 'related' }],
        externalTaskLink: link('clickup-new'),
      },
      agentContext,
    );

    expect(await storage.listExternalTaskLinksForEpic(epic.id)).toEqual([
      expect.objectContaining({ remoteTaskId: 'clickup-new', connectionId: connection.id }),
    ]);
    expect((await storage.listEpicRelations(epic.id)).items).toHaveLength(1);
    expect(announced.map((event) => event.name)).toEqual(
      expect.arrayContaining(['epic.created', 'epic.external_link.changed']),
    );
  });

  it('refuses a task already linked in the project, names its epic and creates nothing', async () => {
    await setLink(parentId, 'clickup-parent');
    const epics = count('epics');

    await expect(
      service.createEpicForProject(
        projectId,
        {
          title: 'Duplicate',
          relations: [{ relatedEpicId: childId, relation: 'related' }],
          externalTaskLink: link('clickup-parent'),
        },
        agentContext,
      ),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_TASK_ALREADY_LINKED',
      details: { epicId: parentId },
    });
    expect(count('epics')).toBe(epics);
    expect((await storage.listEpicRelations(childId)).items).toHaveLength(0);
  });

  it('links and unlinks together with other edits under the version check', async () => {
    const before = await storage.getEpic(parentId);
    const linked = await service.updateEpicWithOutcome(
      parentId,
      { title: 'Linked parent', externalTask: { set: link('clickup-parent') } },
      before.version,
    );
    const linkId = linked.outcome.externalTask!.link.id;
    expect(linked.epic).toMatchObject({ title: 'Linked parent', version: before.version + 1 });
    expect(announced.find((event) => event.name === 'epic.updated')?.payload).toMatchObject({
      changes: {
        title: { current: 'Linked parent' },
        externalTask: { previous: null, current: linkId, currentKey: 'clickup-parent' },
      },
    });

    await expect(
      service.updateEpic(parentId, { externalTask: { clear: true } }, before.version),
    ).rejects.toThrow(OptimisticLockError);
    expect(await storage.listExternalTaskLinksForEpic(parentId)).toHaveLength(1);

    const unlinked = await service.updateEpic(
      parentId,
      { description: 'Unlinked', externalTask: { clear: true } },
      linked.epic.version,
    );
    expect(unlinked).toMatchObject({ description: 'Unlinked', version: before.version + 2 });
    expect(await storage.listExternalTaskLinksForEpic(parentId)).toEqual([]);
  });

  it.each([
    ['a second ordinary link', 'EPIC_ALREADY_LINKED', () => link('clickup-other'), false],
    [
      'the same task again while its link has a connection',
      'EPIC_ALREADY_LINKED',
      () => link('clickup-parent'),
      false,
    ],
    ['another task on a detached link', 'EPIC_ALREADY_LINKED', () => link('clickup-other'), true],
    [
      'a task read through a replaced connection',
      'INTEGRATION_CONNECTION_CHANGED',
      () => link('clickup-other', connection.generation + 1),
      false,
    ],
  ])('refuses %s without changing the epic', async (_name, code, input, detached) => {
    await setLink(parentId, 'clickup-parent');
    if (detached) {
      await reconnect();
    }
    const before = await storage.getEpic(parentId);
    const links = await storage.listExternalTaskLinksForEpic(parentId);

    await expect(
      service.updateEpic(
        parentId,
        { title: 'Changed', externalTask: { set: input() } },
        before.version,
      ),
    ).rejects.toMatchObject({ code });
    expect(await storage.getEpic(parentId)).toMatchObject({
      title: 'Parent',
      version: before.version,
    });
    expect(await storage.listExternalTaskLinksForEpic(parentId)).toEqual(links);
  });

  it('projects the existing sub-epics of a newly linked parent when sync is on', async () => {
    await projectChildUnderLinkedParent();

    expect(vendor.calls).toEqual(['clickup:create']);
    expect(pendingDeliveries()).toBe(0);
  });

  it('never deletes or updates the remote children of an unlinked parent', async () => {
    const row = await projectChildUnderLinkedParent();

    await clearLink(parentId);
    await dispatcher.dispatchAvailable();
    const child = await storage.getEpic(childId);
    await service.updateEpic(childId, { title: 'Edited child' }, child.version);
    await dispatcher.dispatchAvailable();
    await service.deleteEpic(childId);
    await dispatcher.dispatchAvailable();

    expect(vendor.calls).toEqual(['clickup:create']);
    expect(vendor.remotes.has(row.remoteTaskId!)).toBe(true);
    expect(count('external_managed_subtask_links')).toBe(0);
    expect(count('external_task_links')).toBe(0);
    expect(pendingDeliveries()).toBe(0);
  });

  it('unlinks only the exact link it names and refuses stale and managed links', async () => {
    await projectChildUnderLinkedParent();
    const [recognition] = await service.listExternalTaskSources(childId);
    expect(recognition).toMatchObject({ managed: true });
    await expect(service.unlinkExternalTaskSource(childId, recognition!.id)).rejects.toMatchObject({
      code: 'EXTERNAL_TASK_LINK_MANAGED',
    });
    // Home refuses it before an unlink of a VM project opens an attempt or reaches the VM.
    await expect(storage.beginExternalLinkRelease(childId, recognition!.id)).rejects.toMatchObject({
      code: 'EXTERNAL_TASK_LINK_MANAGED',
    });

    const [original] = await service.listExternalTaskSources(parentId);
    expect(original).toMatchObject({ managed: false, remoteKey: 'clickup-parent' });
    await service.unlinkExternalTaskSource(parentId, original!.id);
    await setLink(parentId, 'clickup-newer');
    const { version } = await storage.getEpic(parentId);

    await expect(service.unlinkExternalTaskSource(parentId, original!.id)).rejects.toMatchObject({
      code: 'EXTERNAL_TASK_LINK_STALE',
      statusCode: 409,
    });
    expect(await service.listExternalTaskSources(parentId)).toEqual([
      expect.objectContaining({ remoteKey: 'clickup-newer', managed: false }),
    ]);
    expect((await storage.getEpic(parentId)).version).toBe(version);
  });

  describe('DELETE /api/epics/:id/external-sources/:linkId', () => {
    const originalEnv = process.env;
    let app: NestFastifyApplication;

    beforeEach(async () => {
      process.env = { ...originalEnv };
      delete process.env.HOST;
      resetEnvConfig();
      const moduleRef = await Test.createTestingModule({
        controllers: [EpicsController],
        providers: [
          { provide: EpicsService, useValue: service },
          { provide: EpicRelationsService, useValue: {} },
        ],
      }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      app.useGlobalFilters(new AllExceptionsFilter());
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterEach(async () => {
      await app.close();
      process.env = originalEnv;
      resetEnvConfig();
    });

    async function unlink(linkId: string) {
      return app.inject({
        method: 'DELETE',
        url: `/api/epics/${parentId}/external-sources/${linkId}`,
      });
    }

    it('unlinks the link with 204, then answers a repeat of the same link id with a conflict', async () => {
      const linkId = (await setLink(parentId, 'clickup-parent')).outcome.externalTask!.link.id;

      const first = await unlink(linkId);
      expect(first.statusCode).toBe(204);
      expect(await storage.listExternalTaskLinksForEpic(parentId)).toEqual([]);

      const repeat = await unlink(linkId);
      expect(repeat.statusCode).toBe(409);
      expect(repeat.json()).toMatchObject({ code: 'EXTERNAL_TASK_LINK_STALE' });
    });

    it('refuses the unlink on a non-loopback runtime and keeps the link', async () => {
      const linkId = (await setLink(parentId, 'clickup-parent')).outcome.externalTask!.link.id;
      process.env.HOST = '0.0.0.0';
      resetEnvConfig();

      expect((await unlink(linkId)).statusCode).toBe(403);
      expect(await storage.listExternalTaskLinksForEpic(parentId)).toHaveLength(1);
    });
  });

  // `blocked` is a row already stopped for a reason that blocks Retry; its
  // remote child itself still verifies on the new connection.
  it.each([
    ['is still owned under the parent', 'owned'],
    ['has moved under another remote parent', 'moved'],
    ['is fine but the row needs attention', 'blocked'],
  ] as const)(
    'moves a managed child to the rebound parent connection only when its remote %s',
    async (_name, state) => {
      const row = await projectChildUnderLinkedParent();
      const remoteTaskId = row.remoteTaskId!;
      if (state === 'blocked') {
        await storage.updateExternalManagedSubtaskLink(row.id, {
          operationPhase: 'needs_attention',
          safeErrorCode: 'ownership_marker_missing',
        });
      }
      await reconnect();
      if (state === 'moved') {
        vendor.remotes.set(remoteTaskId, {
          ...vendor.remotes.get(remoteTaskId)!,
          parentRemoteTaskId: 'clickup-elsewhere',
        });
      }
      const rebound = await setLink(parentId, 'clickup-parent');
      expect(rebound.outcome.externalTask).toMatchObject({ rebound: true });
      await dispatcher.dispatchAvailable();
      startInstance();
      const child = await storage.getEpic(childId);

      await service.updateEpic(childId, { title: 'Renamed child' }, child.version);
      await dispatcher.dispatchAvailable();

      const moved = state !== 'moved';
      const updated = state === 'owned';
      expect(pendingDeliveries()).toBe(0);
      expect([...vendor.remotes.keys()]).toEqual([remoteTaskId]);
      expect(vendor.calls).toEqual(
        updated ? ['clickup:create', 'clickup:update'] : ['clickup:create'],
      );
      expect(vendor.remotes.get(remoteTaskId)).toMatchObject({
        title: updated ? 'Renamed child' : 'Child',
      });
      expect(await storage.getExternalManagedSubtaskLink(row.id)).toMatchObject({
        connectionIdSnapshot: moved ? connection.id : row.connectionIdSnapshot,
        ...{
          owned: { operationPhase: 'confirmed', connectionGeneration: connection.generation },
          moved: { operationPhase: 'needs_attention', safeErrorCode: 'parent_mismatch' },
          blocked: { operationPhase: 'needs_attention', safeErrorCode: 'ownership_marker_missing' },
        }[state],
      });
      expect(await storage.listExternalTaskLinksForEpic(childId)).toEqual([
        expect.objectContaining({ remoteTaskId, connectionId: moved ? connection.id : null }),
      ]);
    },
  );

  it.each([
    ['an unknown outcome', 'timeout', 'outcome_unknown', 'provider_timeout'],
    ['an unknown outcome', 'permission_denied', 'outcome_unknown', 'provider_timeout'],
    ['a reason that blocks Retry', 'timeout', 'needs_attention', 'ownership_marker_missing'],
  ] as const)(
    'keeps %s when the first check on the rebound connection fails with %s, then verifies before any write',
    async (_name, readFailure, operationPhase, safeErrorCode) => {
      const row = await projectChildUnderLinkedParent();
      await reconnect();
      await storage.updateExternalManagedSubtaskLink(row.id, { operationPhase, safeErrorCode });
      const readExact = vendor.adapter.subtaskSync!.readExact as jest.Mock;
      readExact.mockRejectedValueOnce(new ExternalProviderError('clickup', readFailure));
      await setLink(parentId, 'clickup-parent');

      await dispatcher.dispatchAvailable();

      expect(readExact).toHaveBeenCalledTimes(1);
      expect(await storage.getExternalManagedSubtaskLink(row.id)).toMatchObject({
        operationPhase,
        connectionIdSnapshot: row.connectionIdSnapshot,
        ...(operationPhase === 'needs_attention' ? { safeErrorCode } : {}),
      });
      expect(await storage.listExternalTaskLinksForEpic(childId)).toEqual([
        expect.objectContaining({ connectionId: null }),
      ]);

      await subscriber.reconcileEpic(childId);

      expect(vendor.calls).toEqual(['clickup:create']);
      expect(await storage.getExternalManagedSubtaskLink(row.id)).toMatchObject({
        connectionIdSnapshot: connection.id,
        ...(operationPhase === 'outcome_unknown'
          ? { operationPhase: 'confirmed' }
          : { operationPhase, safeErrorCode }),
      });
      if (operationPhase === 'needs_attention') {
        await expect(subscriber.retryManagedLink(row.id)).rejects.toMatchObject({
          details: { reason: safeErrorCode },
        });
      }
    },
  );

  it('keeps a managed child that is verified before the rebind is delivered', async () => {
    const row = await projectChildUnderLinkedParent();
    await reconnect();
    await setLink(parentId, 'clickup-parent');

    await subscriber.verifyManagedLink(row.id);

    expect(vendor.calls).toEqual(['clickup:create']);
    expect([...vendor.remotes.keys()]).toEqual([row.remoteTaskId]);
    expect(await storage.getExternalManagedSubtaskLink(row.id)).toMatchObject({
      operationPhase: 'confirmed',
      tombstoneState: 'active',
      connectionIdSnapshot: connection.id,
    });
  });

  it('keeps Retry refused after an incomplete scan across disconnect and rebind, then Verify adopts the child', async () => {
    // The create succeeds remotely, but its response is lost.
    const create = vendor.create.getMockImplementation()!;
    vendor.create.mockImplementationOnce(async (...args: Parameters<typeof create>) => {
      await create(...args);
      throw new ExternalProviderError('clickup', 'timeout', { dispatched: true });
    });
    await setLink(parentId, 'clickup-parent');
    await dispatcher.dispatchAvailable();
    const [unknown] = await storage.listExternalManagedSubtaskLinksForEpicSnapshot(childId);
    expect(unknown).toMatchObject({ operationPhase: 'outcome_unknown', remoteTaskId: null });
    vendor.listOwned.mockResolvedValueOnce({ items: [], complete: false });
    await subscriber.verifyManagedLink(unknown!.id);

    await reconnect();
    await setLink(parentId, 'clickup-parent');
    await dispatcher.dispatchAvailable();

    expect(await storage.getExternalManagedSubtaskLink(unknown!.id)).toMatchObject({
      operationPhase: 'needs_attention',
      safeErrorCode: 'ownership_scan_incomplete',
    });
    await expect(subscriber.retryManagedLink(unknown!.id)).rejects.toMatchObject({
      details: { reason: 'ownership_scan_incomplete' },
    });
    await subscriber.verifyManagedLink(unknown!.id);

    expect(vendor.calls).toEqual(['clickup:create']);
    expect(vendor.remotes.size).toBe(1);
    expect(await storage.getExternalManagedSubtaskLink(unknown!.id)).toMatchObject({
      operationPhase: 'confirmed',
      remoteTaskId: [...vendor.remotes.keys()][0],
      connectionIdSnapshot: connection.id,
    });
  });

  it('returns the committed link change when the project read fails after the write', async () => {
    jest.spyOn(storage, 'getProject').mockRejectedValue(new Error('project read failed'));

    const result = await setLink(parentId, 'clickup-parent');

    expect(result.outcome.externalTask).toMatchObject({ change: 'set' });
    expect(await storage.listExternalTaskLinksForEpic(parentId)).toEqual([
      expect.objectContaining({ remoteTaskId: 'clickup-parent' }),
    ]);
  });

  it('releases the managed projection of a sub-epic it links, with no vendor call', async () => {
    const row = await projectChildUnderLinkedParent();

    const result = await setLink(childId, 'clickup-explicit');
    await dispatcher.dispatchAvailable();

    expect(result.outcome.externalTask?.releasedManagedLinkIds).toEqual([row.id]);
    expect(vendor.calls).toEqual(['clickup:create']);
    expect(await storage.listExternalManagedSubtaskLinksForEpicSnapshot(childId)).toEqual([]);
    expect(await storage.listExternalTaskLinksForEpic(childId)).toEqual([
      expect.objectContaining({ remoteTaskId: 'clickup-explicit' }),
    ]);
  });

  it('reconciles the children after a restart when the link change was never announced', async () => {
    await setLink(parentId, 'clickup-parent');
    // Crash: nothing delivered the committed events in this process.
    startInstance();

    await dispatcher.dispatchAvailable();

    expect(vendor.calls).toEqual(['clickup:create']);
    expect(await storage.listExternalManagedSubtaskLinksForEpicSnapshot(childId)).toEqual([
      expect.objectContaining({ operationPhase: 'confirmed' }),
    ]);
  });

  describe('with a pending estimate operation', () => {
    function estimateIdentity(remoteTaskId: string) {
      return {
        projectId,
        provider: 'clickup' as const,
        remoteScopeKey: 'workspace-clickup',
        remoteTaskId,
      };
    }

    /** A real checkpoint whose provider write ended with an unknown outcome (revision 2). */
    async function pendingEstimate(remoteTaskId: string): Promise<string> {
      const operationId = `operation-${remoteTaskId}`;
      await storage.prepareExternalEstimateLogOperation({
        ...estimateIdentity(remoteTaskId),
        operationId,
        deltaMinutes: 30,
        estimateTotalMinutes: 60,
        startedAt: '2026-11-23T10:00:00.000Z',
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        expectedRevision: 0,
        activityDate: null,
        aggregationTimeZone: null,
        capturedDailyTotals: [],
      });
      await storage.markExternalEstimateLogOperationOutcomeUnknown({
        ...estimateIdentity(remoteTaskId),
        operationId,
        expectedRevision: 1,
      });
      return operationId;
    }

    function rows(table: string): unknown[] {
      return sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    }

    // `home check` is the check home runs before it asks a VM to unlink the parent.
    it.each([
      ['the parent task', 'unlink', () => parentId, () => 'clickup-parent'],
      ['a managed child task', 'unlink', () => childId, (task: string) => task],
      ['the parent task', 'home check', () => parentId, () => 'clickup-parent'],
      ['a managed child task', 'home check', () => childId, (task: string) => task],
    ] as const)(
      'refuses to unlink the parent while %s has one (%s), changing nothing',
      async (_name, refusal, epicIdOf, taskOf: (childTask: string) => string) => {
        const row = await projectChildUnderLinkedParent();
        const operationId = await pendingEstimate(taskOf(row.remoteTaskId!));
        const parent = await storage.getEpic(parentId);
        const [parentLink] = await storage.listExternalTaskLinksForEpic(parentId);
        const before = [rows('external_task_links'), rows('external_managed_subtask_links')];

        await expect(
          refusal === 'unlink'
            ? clearLink(parentId)
            : storage.assertExternalLinkReleaseAllowed(parentId, parentLink!.id),
        ).rejects.toMatchObject({
          code: 'EXTERNAL_TASK_ESTIMATE_PENDING',
          statusCode: 409,
          details: { epicId: epicIdOf(), operationId },
        });

        expect([rows('external_task_links'), rows('external_managed_subtask_links')]).toEqual(
          before,
        );
        expect(await storage.getEpic(parentId)).toMatchObject({ version: parent.version });
      },
    );

    it.each([
      'applies',
      'is not pulled home',
      'times out before it commits',
      'is refused',
      'is rejected for its API key',
      'is not seeded at first',
      'overlaps a refused attempt',
      'meets a child confirmed meanwhile',
    ] as const)(
      'takes no estimate for a task a home unlink of a VM parent removes while home keeps the link: the unlink %s',
      async (outcome) => {
        const row = await projectChildUnderLinkedParent();
        const [parentLink] = await storage.listExternalTaskLinksForEpic(parentId);
        let reachVm!: () => void;
        const atVm = new Promise<void>((resolve) => (reachVm = resolve));
        let answer!: () => void;
        const answered = new Promise<void>((resolve) => (answer = resolve));
        const gate = createProjectWriteGateStub();
        gate.getRemoteOwner.mockReturnValue({
          projectId,
          remoteId: 'vm-1',
          remoteName: 'VM',
          state: 'remote',
        });
        // Home's pull drops the link and releases the child's projection once the VM has
        // committed the unlink, as the VM's link table does, while it can read the VM.
        let committed = false;
        let readable = outcome !== 'is not pulled home';
        let vmCalls = 0;
        const pull = async () => {
          if (!readable || !committed) return;
          if ((await storage.listExternalTaskLinksForEpic(parentId)).length > 0) {
            await clearLink(parentId);
          }
        };
        const atHome = new EpicsService(
          storage,
          { publish: jest.fn().mockResolvedValue(null) } as never,
          { getAutoCleanStatusIds: jest.fn().mockReturnValue([]) } as unknown as SettingsService,
          { emit: jest.fn() } as unknown as EventEmitter2,
          gate as never,
          {
            unlinkExternalTask: jest.fn(async () => {
              vmCalls += 1;
              if (outcome === 'overlaps a refused attempt' && vmCalls === 2) {
                throw new AppError(
                  'Managed subtask sync is busy; try again.',
                  'MANAGED_SUBTASK_SYNC_BUSY',
                  409,
                );
              }
              if (vmCalls === 1) {
                reachVm();
                await answered;
              }
              if (outcome === 'is not seeded at first' && vmCalls === 1) {
                throw new AppError('The VM is still receiving links.', 'PROJECT_NOT_SEEDED', 409);
              }
              if (outcome === 'times out before it commits') {
                throw new RemoteHostRequestError('Host request timed out.', {
                  remoteId: 'vm-1',
                  path: '/api/host',
                  status: null,
                  hostCode: null,
                });
              }
              if (outcome === 'is rejected for its API key') {
                // The VM's admission answers before any controller runs.
                throw new RemoteHostRequestError('VM answered 401.', {
                  remoteId: 'vm-1',
                  path: '/api/host',
                  status: 401,
                  hostCode: 'HOST_API_KEY_REJECTED',
                });
              }
              if (outcome === 'is refused') {
                throw new AppError(
                  'The VM refused the link change.',
                  'REMOTE_LINK_WRITE_REFUSED',
                  409,
                );
              }
              committed = true;
            }),
          } as never,
          { pullNow: pull } as never,
          lock,
          { isClaimedHost: () => false },
          {
            // As the link writer does: a VM that lost its seed is seeded again, then retried.
            write: async (_remoteId, _projectId, write) => {
              try {
                return await write.host();
              } catch (error) {
                if (!(error instanceof AppError) || error.code !== 'PROJECT_NOT_SEEDED')
                  throw error;
                // While home seeds the VM again, an estimate of the child's task begins.
                await estimate().catch(() => undefined);
                return write.host();
              }
            },
          },
        );
        const vendorWrite = jest.fn().mockResolvedValue({ outcome: 'created' });
        // The estimate's own refresh finds no sync target.
        const estimatesOn = (on: LocalStorageService) =>
          new EpicEstimateLoggingService(
            on,
            {
              getDailyProjection: () => ({
                canonicalTimeZone: 'UTC',
                totalMinutes: 30,
                currentByDate: [{ activityDate: '2026-11-23', minutes: 30 }],
              }),
            } as never,
            { inspectOperation: () => null, createEstimateTimeEntry: vendorWrite } as never,
            { pullNow: jest.fn() },
          );
        let estimates = estimatesOn(storage);
        const identity = estimateIdentity(row.remoteTaskId!);
        const estimate = (task = identity) =>
          estimates.createTimeEntry({
            ...task,
            expectedEpoch: connection.generation,
            requestKey: randomUUID(),
            timeZone: 'UTC',
            estimateTotalMinutes: 30,
            expectedRevision: 0,
            dailySnapshot: [{ activityDate: '2026-11-23', minutes: 30 }],
          });
        const refused = { statusCode: 409, details: { reason: 'external_task_unlink_pending' } };

        const unlink = atHome.unlinkExternalTaskSource(parentId, parentLink!.id).then(
          () => null,
          (error: unknown) => error,
        );
        await atVm;
        await expect(estimate()).rejects.toMatchObject(refused);
        let lateTask: typeof identity | null = null;
        if (outcome === 'meets a child confirmed meanwhile') {
          // A child added after the unlink was admitted gets its managed subtask and its
          // recognition link under the parent link the unlink removes.
          const late = (await service.createEpicForProject(projectId, { title: 'Late', parentId }))
            .id;
          await dispatcher.dispatchAvailable();
          const [lateRow] = await storage.listExternalManagedSubtaskLinksForEpicSnapshot(late);
          expect(lateRow).toMatchObject({ operationPhase: 'confirmed' });
          lateTask = estimateIdentity(lateRow!.remoteTaskId!);
          await expect(estimate(lateTask)).rejects.toMatchObject(refused);
        }
        if (outcome === 'overlaps a refused attempt') {
          // The VM refuses a second unlink of the link while the first is on its way.
          const second = await atHome.unlinkExternalTaskSource(parentId, parentLink!.id).then(
            () => null,
            (error: unknown) => error,
          );
          expect(second).toMatchObject({ code: 'MANAGED_SUBTASK_SYNC_BUSY' });
          await expect(estimate()).rejects.toMatchObject(refused);
        }
        answer();
        const unlinkError = await unlink;

        if (
          outcome === 'applies' ||
          outcome === 'overlaps a refused attempt' ||
          outcome === 'meets a child confirmed meanwhile'
        ) {
          expect(unlinkError).toBeNull();
        }
        if (outcome === 'is not pulled home') {
          // The VM committed; home keeps the stale link, also across a restart.
          expect(unlinkError).toMatchObject({ details: { code: 'REMOTE_UNLINK_PENDING' } });
          startInstance();
          estimates = estimatesOn(storage);
          await expect(estimate()).rejects.toMatchObject(refused);
          readable = true;
          await pull();
        }
        if (outcome === 'times out before it commits') {
          // A pull that still shows the link proves nothing while the VM may commit.
          expect(unlinkError).toBeInstanceOf(RemoteHostRequestError);
          await pull();
          expect(await storage.listExternalTaskLinksForEpic(parentId)).toHaveLength(1);
          await expect(estimate()).rejects.toMatchObject(refused);
          committed = true;
          await pull();
        }
        if (outcome === 'is not seeded at first') {
          // The estimate begun during the reseed won: the retry is refused before the VM
          // gets it, and the link stays to resolve the estimate.
          expect(unlinkError).toMatchObject({ code: 'EXTERNAL_TASK_ESTIMATE_PENDING' });
          expect(vmCalls).toBe(1);
          expect(vendorWrite).toHaveBeenCalledTimes(1);
          expect(await storage.getExternalEstimateLogState(identity)).toMatchObject({
            pendingOperationId: expect.any(String),
          });
          expect(await storage.listExternalTaskLinksForEpic(parentId)).toHaveLength(1);
        } else if (outcome === 'is refused' || outcome === 'is rejected for its API key') {
          // Nothing changed on the VM: the task takes estimates again.
          expect(unlinkError).toMatchObject({
            code:
              outcome === 'is refused' ? 'REMOTE_LINK_WRITE_REFUSED' : 'REMOTE_HOST_REQUEST_FAILED',
          });
          await estimate().catch(() => undefined);
          expect(vendorWrite).toHaveBeenCalledTimes(1);
          expect(await storage.listExternalTaskLinksForEpic(parentId)).toHaveLength(1);
        } else {
          // Home's copy dropped the link: the estimate has nothing left to log against.
          await expect(estimate()).rejects.not.toMatchObject(refused);
          expect(vendorWrite).not.toHaveBeenCalled();
          expect(await storage.getExternalEstimateLogState(identity)).toBeNull();
          if (lateTask) expect(await storage.getExternalEstimateLogState(lateTask)).toBeNull();
          expect(await storage.listExternalTaskLinksForEpic(parentId)).toEqual([]);
          expect(await storage.listExternalManagedSubtaskLinksForEpicSnapshot(childId)).toEqual([]);
        }
      },
    );

    it('refuses to link a sub-epic whose released managed task has one', async () => {
      const row = await projectChildUnderLinkedParent();
      const operationId = await pendingEstimate(row.remoteTaskId!);
      const before = [rows('external_task_links'), rows('external_managed_subtask_links')];

      await expect(setLink(childId, 'clickup-explicit')).rejects.toMatchObject({
        code: 'EXTERNAL_TASK_ESTIMATE_PENDING',
        details: { epicId: childId, remoteKey: row.remoteKey, operationId },
      });

      expect([rows('external_task_links'), rows('external_managed_subtask_links')]).toEqual(before);
    });

    it('rebinds a detached link to the reconnected workspace, then settles and unlinks', async () => {
      const original = (await setLink(parentId, 'clickup-parent')).outcome.externalTask!.link;
      const operationId = await pendingEstimate('clickup-parent');
      const dispatchedBy = connection;
      await reconnect();
      expect(await storage.listExternalTaskLinksForEpic(parentId)).toEqual([
        expect.objectContaining({ id: original.id, connectionId: null }),
      ]);
      const identity = estimateIdentity('clickup-parent');
      const estimates = new EpicEstimateLoggingService(
        storage,
        {} as never,
        {
          // The time journal still holds the unknown write of the old connection.
          inspectOperation: jest.fn(() => ({
            operationId,
            kind: 'create',
            phase: 'outcome_unknown',
            canVerify: true,
            expiresAt: '2026-11-30T00:00:00.000Z',
            tuple: {
              provider: 'clickup',
              connectionId: dispatchedBy.id,
              connectionGeneration: dispatchedBy.generation,
              remoteTaskId: 'clickup-parent',
              remoteEntryId: null,
              effectiveStartedAt: '2026-11-23T10:00:00.000Z',
              durationMs: 30 * 60_000,
              noteFingerprint: timeEntryNoteFingerprint(EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE),
            },
          })),
          verifyOperation: jest.fn(),
          acknowledgeOperation: jest.fn(),
        } as never,
        { pullNow: jest.fn() },
      );
      const resolve = (action: 'verify' | 'logged' | 'not_logged') =>
        estimates.resolveOperation({
          ...identity,
          expectedEpoch: connection.generation,
          operationId,
          expectedRevision: 2,
          action,
        });
      await expect(resolve('not_logged')).rejects.toMatchObject({
        details: { reason: 'link_connection_mismatch' },
      });
      const before = await storage.getEpic(parentId);
      announced = [];

      const rebound = await setLink(parentId, 'clickup-parent');

      expect(rebound.outcome.externalTask).toMatchObject({
        change: 'set',
        rebound: true,
        releasedManagedLinkIds: [],
        link: { id: original.id, connectionId: connection.id, remoteTaskId: 'clickup-parent' },
      });
      expect(rebound.epic.version).toBe(before.version + 1);
      expect(announced.map((event) => [event.name, event.payload])).toEqual([
        [
          'epic.updated',
          expect.objectContaining({
            changes: {
              externalTask: {
                previous: original.id,
                current: original.id,
                previousKey: 'clickup-parent',
                currentKey: 'clickup-parent',
              },
            },
          }),
        ],
        [
          'epic.external_link.changed',
          { epicId: parentId, projectId, linkId: original.id, change: 'set' },
        ],
      ]);
      expect(await storage.getExternalEstimateLogState(identity)).toMatchObject({
        revision: 2,
        pendingOperationId: operationId,
        pendingConnectionId: dispatchedBy.id,
        pendingPhase: 'outcome_unknown',
      });
      await expect(resolve('verify')).rejects.toMatchObject({
        details: { reason: 'connection_superseded' },
      });
      await expect(resolve('not_logged')).resolves.toMatchObject({ outcome: 'not_logged' });
      await clearLink(parentId);

      expect(await storage.listExternalTaskLinksForEpic(parentId)).toEqual([]);
      expect(await storage.getExternalEstimateLogState(identity)).toMatchObject({
        loggedMinutes: 0,
        pendingOperationId: null,
      });
    });

    it('unlinks once the operation is resolved and keeps the settled history', async () => {
      await setLink(parentId, 'clickup-parent');
      const operationId = await pendingEstimate('clickup-parent');
      await expect(clearLink(parentId)).rejects.toMatchObject({
        code: 'EXTERNAL_TASK_ESTIMATE_PENDING',
      });

      const identity = estimateIdentity('clickup-parent');
      await storage.storeExternalEstimateLogResolution({
        ...identity,
        operationId,
        resolution: 'logged',
        expectedRevision: 2,
      });
      await storage.applyExternalEstimateLogResolution({
        ...identity,
        operationId,
        expectedRevision: 3,
      });
      await clearLink(parentId);

      expect(await storage.listExternalTaskLinksForEpic(parentId)).toEqual([]);
      expect(await storage.getExternalEstimateLogState(identity)).toMatchObject({
        loggedMinutes: 30,
        pendingOperationId: null,
      });
    });
  });

  describe('with a projection dispatch in flight', () => {
    let releaseVendor: () => void;
    let vendorCalled: Promise<void>;

    beforeEach(async () => {
      await setLink(parentId, 'clickup-parent');
      const create = vendor.create.getMockImplementation()!;
      let markCalled!: () => void;
      vendorCalled = new Promise((resolve) => (markCalled = resolve));
      vendor.create.mockImplementationOnce(async (...args: Parameters<typeof create>) => {
        markCalled();
        await new Promise<void>((resolve) => (releaseVendor = resolve));
        return create(...args);
      });
    });

    it('ends the dispatch as a no-op when its projection is released', async () => {
      const delivering = dispatcher.dispatchAvailable();
      await vendorCalled;

      // A storage-level release holds no projection lock.
      await storage.deleteExternalTaskLink(parentId, null);
      releaseVendor();
      await delivering;
      await dispatcher.dispatchAvailable();

      expect(vendor.calls).toEqual(['clickup:create']);
      expect(count('external_managed_subtask_links')).toBe(0);
      expect(count('external_task_links')).toBe(0);
      expect(pendingDeliveries()).toBe(0);
    });

    it('makes an unlink wait until the dispatch is confirmed', async () => {
      const delivering = dispatcher.dispatchAvailable();
      await vendorCalled;
      let unlinked = false;
      const unlinking = clearLink(parentId).then(() => (unlinked = true));

      await new Promise((resolve) => setImmediate(resolve));
      expect(unlinked).toBe(false);
      releaseVendor();
      await Promise.all([delivering, unlinking]);

      expect(vendor.calls).toEqual(['clickup:create']);
      expect(count('external_managed_subtask_links')).toBe(0);
      expect(count('external_task_links')).toBe(0);
    });

    it('locks a projection created after the unlink listed the rows to release', async () => {
      const runInTransaction = storage.runInTransaction.bind(storage);
      let delivering!: Promise<number>;
      jest.spyOn(storage, 'runInTransaction').mockImplementationOnce(async (fn) => {
        // The unlink found no projection to lock; the child is projected only now.
        delivering = dispatcher.dispatchAvailable();
        await vendorCalled;
        return runInTransaction(fn);
      });
      const runAll = lock.runAll.bind(lock);
      let markRelocking!: () => void;
      const relocking = new Promise<void>((resolve) => (markRelocking = resolve));
      jest.spyOn(lock, 'runAll').mockImplementation((ids, operation) => {
        if (ids.length > 0) markRelocking();
        return runAll(ids, operation);
      });
      const parent = await storage.getEpic(parentId);
      let unlinked = false;
      const unlinking = service
        .updateEpicWithOutcome(parentId, { externalTask: { clear: true } }, parent.version)
        .then((result) => {
          unlinked = true;
          return result;
        });

      await relocking;
      await new Promise((resolve) => setImmediate(resolve));
      const [row] = await storage.listExternalManagedSubtaskLinksForEpicSnapshot(childId);
      expect(unlinked).toBe(false);
      expect(row).toMatchObject({ operationPhase: 'dispatch_admitted' });
      expect(await storage.listExternalTaskLinksForEpic(parentId)).toHaveLength(1);

      releaseVendor();
      const [, result] = await Promise.all([delivering, unlinking]);
      await dispatcher.dispatchAvailable();

      expect(result.outcome.externalTask?.releasedManagedLinkIds).toEqual([row!.id]);
      expect(vendor.calls).toEqual(['clickup:create']);
      expect(count('external_managed_subtask_links')).toBe(0);
      expect(count('external_task_links')).toBe(0);
      expect(pendingDeliveries()).toBe(0);
    });
  });

  describe('on a claimed VM', () => {
    const receipts = () =>
      sqlite
        .prepare(
          'SELECT seq, kind, epic_id, link_id, remote_task_id FROM external_link_receipts ORDER BY seq',
        )
        .all();

    it('writes no receipt for a project this instance owns', async () => {
      await setLink(parentId, 'clickup-home');
      await clearLink(parentId);

      expect(receipts()).toEqual([]);
    });

    it('refuses link writes until home seeded the project, and writes nothing', async () => {
      await setLink(childId, 'clickup-before-seed');
      claimedHost = true;

      await expect(setLink(parentId, 'clickup-parent')).rejects.toMatchObject({
        code: 'PROJECT_NOT_SEEDED',
      });
      await expect(clearLink(childId)).rejects.toMatchObject({ code: 'PROJECT_NOT_SEEDED' });
      expect(await storage.listExternalTaskLinksForEpic(parentId)).toEqual([]);
      expect(await storage.listExternalTaskLinksForEpic(childId)).toHaveLength(1);
      expect(receipts()).toEqual([]);
    });

    it('leaves one receipt per set and unlink in the write transaction, in commit order', async () => {
      claimedHost = true;
      markLinkProjectsSeeded(sqlite, [projectId]);

      const set = await setLink(parentId, 'clickup-parent');
      const linkId = set.outcome.externalTask!.link.id;
      const cleared = await service.updateEpicWithOutcome(
        parentId,
        { externalTask: { clear: true } },
        (await storage.getEpic(parentId)).version,
      );
      // Home acknowledged both: the next receipt still gets a later seq.
      sqlite.prepare('DELETE FROM external_link_receipts').run();
      await setLink(childId, 'clickup-child');

      expect(summarizeExternalTaskChange(set.outcome.externalTask!).release).toBeUndefined();
      expect(summarizeExternalTaskChange(cleared.outcome.externalTask!)).toMatchObject({
        change: 'clear',
        release: 'pending_home_sync',
      });
      expect(receipts()).toEqual([
        {
          seq: 3,
          kind: 'set',
          epic_id: childId,
          link_id: expect.any(String),
          remote_task_id: 'clickup-child',
        },
      ]);
      expect(set.outcome.externalTask!.receiptId).toEqual(expect.any(String));
      expect(cleared.outcome.externalTask).toMatchObject({ link: { id: linkId } });
    });

    it('rolls the receipt back with a refused link write', async () => {
      claimedHost = true;
      markLinkProjectsSeeded(sqlite, [projectId]);
      await setLink(parentId, 'clickup-parent');

      await expect(setLink(childId, 'clickup-parent')).rejects.toMatchObject({
        code: 'EXTERNAL_TASK_ALREADY_LINKED',
      });

      expect(receipts()).toEqual([expect.objectContaining({ seq: 1, epic_id: parentId })]);
    });

    describe('importing a task', () => {
      const keyOf = (remoteTaskId: string) =>
        externalImportIdempotencyKey('clickup', 'workspace-clickup', remoteTaskId);
      const keyed = (remoteTaskId: string) =>
        sqlite
          .prepare(`SELECT id FROM epics WHERE json_extract(data, '$.idempotencyKey') = ?`)
          .all(keyOf(remoteTaskId));
      async function importTask(remoteTaskId: string) {
        const { statusId } = await storage.getEpic(parentId);
        return storage.importHostedExternalTask({
          idempotencyKey: keyOf(remoteTaskId),
          epic: {
            projectId,
            statusId,
            title: `Imported ${remoteTaskId}`,
            description: null,
            parentId: null,
            agentId: null,
            tags: [],
            data: { idempotencyKey: keyOf(remoteTaskId) },
          },
          link: link(remoteTaskId),
        });
      }

      beforeEach(() => {
        claimedHost = true;
      });

      it('is refused until home seeded the project', async () => {
        await expect(importTask('clickup-new')).rejects.toMatchObject({
          code: 'PROJECT_NOT_SEEDED',
        });
        expect(keyed('clickup-new')).toEqual([]);
      });

      it("returns the task's existing link, creating no epic", async () => {
        markLinkProjectsSeeded(sqlite, [projectId]);
        await setLink(parentId, 'clickup-agent');

        const result = await importTask('clickup-agent');

        expect(result).toMatchObject({ epicId: parentId, created: false });
        expect(result.createdEpic).toBeUndefined();
        expect(keyed('clickup-agent')).toEqual([]);
        expect(receipts()).toHaveLength(1);
      });

      it('links the epic an unfinished earlier import created, with its receipt, also after an unlink of another task', async () => {
        markLinkProjectsSeeded(sqlite, [projectId]);
        const { statusId } = await storage.getEpic(parentId);
        const unfinished = await storage.createEpic({
          projectId,
          statusId,
          title: 'Imported clickup-retry',
          description: null,
          parentId: null,
          agentId: null,
          tags: [],
          data: { idempotencyKey: keyOf('clickup-retry') },
        });
        // A link to another task meanwhile, then its unlink: the import's key stays.
        await setLink(unfinished.id, 'clickup-other');
        await storage.deleteExternalTaskLink(unfinished.id, null, undefined, { vmHosted: true });
        expect(keyed('clickup-retry')).toEqual([{ id: unfinished.id }]);

        const result = await importTask('clickup-retry');

        expect(result).toMatchObject({ epicId: unfinished.id, created: true });
        expect(result.createdEpic).toBeUndefined();
        expect(keyed('clickup-retry')).toEqual([{ id: unfinished.id }]);
        expect(receipts().map((row) => (row as { kind: string }).kind)).toEqual([
          'set',
          'release',
          'set',
        ]);
        expect(receipts()[2]).toMatchObject({ epic_id: unfinished.id });
      });

      it('never brings back an epic whose link was removed', async () => {
        markLinkProjectsSeeded(sqlite, [projectId]);
        const first = await importTask('clickup-again');
        await storage.deleteExternalTaskLink(first.epicId, first.link.id, undefined, {
          vmHosted: true,
        });

        const second = await importTask('clickup-again');

        expect(first.createdEpic?.id).toBe(first.epicId);
        expect(second).toMatchObject({ created: true });
        expect(second.epicId).not.toBe(first.epicId);
        expect(receipts().map((row) => (row as { kind: string }).kind)).toEqual([
          'set',
          'release',
          'set',
        ]);
      });
    });
  });
});
