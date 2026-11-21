/**
 * Answers to agent Vault requests over HTTP and from the phone, end to end: request →
 * fulfill or deny → the agent's notice → the value through the resolve route and
 * `devchain_vault_list`.
 * Test layer: controller integration. Entry creation, additive grants, the in-memory
 * session values, the store's single transition and catalog listeners only meet in a
 * Nest app over a migrated DB; message delivery is the stubbed edge.
 */
const mockLogLines: unknown[] = [];
jest.mock('../../common/logging/logger', () => {
  const record = (...args: unknown[]) => mockLogLines.push(args);
  const child = { info: record, warn: record, error: record, debug: record, trace: record };
  return { createLogger: () => child, logger: child };
});

import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultUnavailableError } from '../../common/errors/error-types';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { dumpDatabase, expectNoCanaries } from '../../common/test/vault-canary.helper';
import { MobileVaultRpcService } from '../cloud-tunnel/services/mobile-vault-rpc.service';
import { VaultUseOptInRegistry } from '../cloud-tunnel/services/vault-use-opt-in';
import { AgentMessageDeliveryService } from '../agent-message-delivery/agent-message-delivery.service';
import { eventCatalog, type EventName } from '../events/catalog';
import { EventsService } from '../events/services/events.service';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import { RemoteHostClient } from '../remotes/operations/remote-host.client';
import { REMOTE_VAULT_DELIVERY_PORT } from '../remotes/ports/remote-vault-delivery.port';
import { RemoteHostRequestError } from '../remotes/transport/host-transport';
import { RuntimeDirectoryService } from '../runtime-directory/runtime-directory.service';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../storage/db/schema';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { LocalStorageService } from '../storage/local/local-storage.service';
import type { VaultEntryProjectAccess } from '../storage/models/domain.models';
import { SessionRowStore } from '../storage/sessions/session-row.store';
import { VaultAccessService } from '../vault/vault-access.service';
import { VaultDiscoveryService } from '../vault/vault-discovery.service';
import { VaultEntriesService } from '../vault/vault-entries.service';
import { VAULT_OPTIONS, VaultKeyService } from '../vault/vault-key.service';
import { VAULT_KEYSTORE, VaultKeystoreUnavailableError } from '../vault/vault-keystore';
import { VaultLocalPeerGuard } from '../vault/vault-local-peer.guard';
import { VaultResolveController } from '../vault/vault-resolve.controller';
import { VaultResolveService } from '../vault/vault-resolve.service';
import { VaultUseApprovalStore } from '../vault/vault-use-approvals';
import { VaultUseGate } from '../vault/vault-use-gate';
import { VAULT_SESSION_OVERLAY } from '../vault/vault-session-overlay';
import { VaultSessionValueStore } from '../vault/vault-session-values';
import { VaultValueReader } from '../vault/vault-value-reader';
import { VaultVmCacheService } from '../vault/vault-vm-cache.service';
import {
  VaultRequestFulfillService,
  type VaultRequestCandidate,
} from './vault-request-fulfill.service';
import { VaultRequestNotifierSubscriber } from './vault-request-notifier.subscriber';
import { VaultRequestService } from './vault-request.service';
import { VaultRequestStore } from './vault-request.store';
import { VaultRequestsController } from './vault-requests.controller';

const CODER = '11111111-1111-4111-8111-111111111111';
const NO_FAMILY = '22222222-2222-4222-8222-222222222222';
const PERMANENT_CANARY = 'canary-permanent-6b1e';
const SESSION_CANARY = 'canary-session-only-93fd';
const PHONE_CANARY = 'canary-phone-5c0a';
const VM_CANARY = 'canary-vm-answer-2d7e';
const EXISTING_CANARY = 'canary-existing-entry-41af';
/** A phone limited to the workspace of projects A and B; project C is outside it. */
const DEVICE_SCOPE = { allowedWorkspaceIds: new Set([DEFAULT_PROJECT_WORKSPACE_ID]) };

describe('Vault request answers', () => {
  let app: NestFastifyApplication;
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let vault: VaultKeyService;
  let requests: VaultRequestService;
  let discovery: VaultDiscoveryService;
  let emitter: EventEmitter2;
  let root: string;
  let sharedId: string;
  let claimed = false;
  const published: Array<{ name: EventName; payload: unknown }> = [];
  const candidateBodies: string[] = [];
  const deliver = jest.fn().mockResolvedValue({ status: 'delivered', results: [] });
  const pushConfirmed = jest.fn<Promise<void>, [string]>();
  const resolveVaultRequest = jest.fn<Promise<void>, [string, string, unknown]>();

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-requests-'));
    const database = createTestDatabase();
    sqlite = database.sqlite;
    storage = new LocalStorageService(database.db);
    const insert = (sql: string) => sqlite.prepare(sql).run();
    insert(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
            VALUES ('A', 'Project A', '/tmp/A', 'T', 'T')`);
    insert(`INSERT INTO project_workspaces (id, name, is_default, position, created_at, updated_at)
            VALUES ('ws-other', 'Other', 0, 1, 'T', 'T')`);
    insert(`INSERT INTO projects (id, name, root_path, workspace_id, created_at, updated_at)
            VALUES ('C', 'Project C', '/tmp/C', 'ws-other', 'T', 'T')`);
    insert(`INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
            VALUES ('p-coder', 'A', 'Coder', 'coder', 'T', 'T'),
                   ('p-reviewer', 'A', 'Reviewer', 'reviewer', 'T', 'T'),
                   ('p-plain', 'A', 'Plain', NULL, 'T', 'T')`);
    insert(`INSERT INTO providers (id, name, mcp_configured, created_at, updated_at)
            VALUES ('prov', 'claude', 0, 'T', 'T')`);
    insert(`INSERT INTO profile_provider_configs
              (id, profile_id, provider_id, name, position, created_at, updated_at)
            VALUES ('c-coder', 'p-coder', 'prov', 'Coder', 0, 'T', 'T'),
                   ('c-plain', 'p-plain', 'prov', 'Plain', 0, 'T', 'T')`);
    insert(`INSERT INTO agents
              (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
            VALUES ('a-coder', 'A', 'p-coder', 'c-coder', 'Coder', 'T', 'T'),
                   ('a-plain', 'A', 'p-plain', 'c-plain', 'Plain', 'T', 'T')`);
    insert(`INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
            VALUES ('${CODER}', 'a-coder', 'running', 'T', 'T', 'T'),
                   ('${NO_FAMILY}', 'a-plain', 'running', 'T', 'T', 'T')`);

    const unavailable = () => Promise.reject(new VaultKeystoreUnavailableError());
    const module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      controllers: [VaultRequestsController, VaultResolveController],
      providers: [
        VaultKeyService,
        VaultAccessService,
        VaultEntriesService,
        VaultValueReader,
        VaultResolveService,
        VaultUseGate,
        VaultUseApprovalStore,
        VaultLocalPeerGuard,
        VaultDiscoveryService,
        VaultSessionValueStore,
        { provide: VAULT_SESSION_OVERLAY, useExisting: VaultSessionValueStore },
        VaultRequestStore,
        VaultRequestService,
        VaultRequestFulfillService,
        VaultRequestNotifierSubscriber,
        MobileVaultRpcService,
        VaultUseOptInRegistry,
        SessionRowStore,
        { provide: DB_CONNECTION, useValue: database.db },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: AgentMessageDeliveryService, useValue: { deliver } },
        { provide: RemoteHostClient, useValue: { resolveVaultRequest } },
        { provide: REMOTE_VAULT_DELIVERY_PORT, useValue: { pushConfirmed } },
        { provide: VaultVmCacheService, useValue: { isClaimedHost: () => claimed } },
        {
          // The real catalog check and listener dispatch, without the event log table.
          provide: EventsService,
          inject: [EventEmitter2],
          useFactory: (events: EventEmitter2) => ({
            publish: async (name: EventName, payload: unknown) => {
              eventCatalog[name].parse(payload);
              published.push({ name, payload });
              await events.emitAsync(name, payload);
              return 'event-id';
            },
          }),
        },
        {
          provide: RuntimeDirectoryService,
          useValue: new RuntimeDirectoryService({
            platform: 'linux',
            dbPath: join(root, 'devchain.db'),
            env: () => ({ RUNTIME_DIRECTORY: join(root, 'run') }),
            isLingering: () => false,
            fileSystemType: async () => null,
          }),
        },
        {
          provide: ProviderAdapterFactory,
          useValue: { getSupportedProviders: () => [], getAdapter: () => ({}) },
        },
        {
          provide: VAULT_KEYSTORE,
          useValue: {
            isAvailable: () => false,
            read: unavailable,
            write: unavailable,
            remove: unavailable,
          },
        },
        { provide: VAULT_OPTIONS, useValue: { fileKeyDirectory: join(root, 'vault') } },
      ],
    }).compile();
    vault = module.get(VaultKeyService);
    requests = module.get(VaultRequestService);
    discovery = module.get(VaultDiscoveryService);
    emitter = module.get(EventEmitter2);
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await vault.setup('file');
    await storage.setVaultFamilyAccess('A', { mode: 'all' });
    sharedId = (
      await module.get(VaultEntriesService).createEntry({
        projects: [{ projectId: 'A', mode: 'families', familySlugs: ['reviewer'] }],
        name: 'SHARED_KEY',
        kind: 'secret',
        description: 'Key the reviewers have',
        value: 'shared-value',
      })
    ).id;
  });

  // The notifier listens asynchronously: let notices of earlier answers land first.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  beforeEach(async () => {
    await settle();
    deliver.mockClear();
  });

  afterAll(async () => {
    app.get(VaultRequestStore).onModuleDestroy();
    await app.close();
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  const ask = (name: string, sessionId = CODER, agentId = 'a-coder') =>
    requests.request({ sessionId, agentId, name, description: `${name} for deploys` });
  const post = (path: string, payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/api/vault/requests/${path}`, payload });
  const approve = (requestId: string, decision: string) =>
    post(`${requestId}/approve`, { decision });
  /** Locked Vault plus a `remote` binding: the locked-write rule refuses access writes. */
  const lockedWithRemoteBinding = async (run: () => Promise<void>) => {
    const state = jest.spyOn(vault, 'getState').mockReturnValue('locked');
    const bindings = jest
      .spyOn(storage, 'listRemoteProjectBindings')
      .mockResolvedValue([{ projectId: 'A', remoteId: 'vm-1', state: 'remote' } as never]);
    try {
      await run();
    } finally {
      state.mockRestore();
      bindings.mockRestore();
    }
  };
  const resolveValues = (sessionId: string, names: string[]) =>
    app.inject({
      method: 'POST',
      url: '/api/vault/sessions/resolve',
      payload: { sessionId, names },
    });
  const noticeBody = async () => {
    await settle();
    return deliver.mock.calls.map((call) => (call[1] as { body: string }).body);
  };
  /** A shared entry whose only grant is in project C, outside `DEVICE_SCOPE`. */
  async function sharedOnlyInC(name: string): Promise<string> {
    const { id } = await app.get(VaultEntriesService).createEntry({
      projects: [],
      name,
      kind: 'secret',
      description: `${name} entry`,
      value: EXISTING_CANARY,
    });
    await storage.addVaultEntryGrant(id, 'C', null);
    return id;
  }
  async function pendingId(name: string, sessionId = CODER, agentId = 'a-coder') {
    const result = await ask(name, sessionId, agentId);
    if (!('requestId' in result)) throw new Error(`${name} is already available`);
    return result.requestId;
  }

  it('keeps a request on a claimed VM and lists it on neither the web nor the phone', async () => {
    claimed = true;
    try {
      const requestId = await pendingId('VM_KEY');

      expect(app.get(VaultRequestStore).get(requestId)).toMatchObject({ name: 'VM_KEY' });
      expect((await app.inject({ method: 'GET', url: '/api/vault/requests' })).json()).toEqual([]);
      expect(
        await app
          .get(MobileVaultRpcService)
          .listRequests({}, undefined, { allowedWorkspaceIds: null }),
      ).toEqual([]);
    } finally {
      claimed = false;
    }
    await post(`${await pendingId('VM_KEY')}/deny`);
  });

  it('lists pending requests with project and entry details after a reload', async () => {
    const createId = await pendingId('LISTED_KEY');
    const grantId = await pendingId('SHARED_KEY');

    const listed = await app.inject({ method: 'GET', url: '/api/vault/requests' });

    expect(listed.json()).toEqual([
      expect.objectContaining({
        requestId: createId,
        type: 'create',
        projectName: 'Project A',
        agentName: 'Coder',
        entryDescription: null,
      }),
      expect.objectContaining({
        requestId: grantId,
        type: 'grant',
        entryId: sharedId,
        familySlug: 'coder',
        entryDescription: 'Key the reviewers have',
      }),
    ]);
    await post(`${createId}/deny`);
    await post(`${grantId}/deny`);
  });

  it('creates a permanent entry for the requesting family and tells the agent', async () => {
    const requestId = await pendingId('NEW_TOKEN');

    const response = await post(`${requestId}/fulfill`, {
      value: PERMANENT_CANARY,
      permanent: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(PERMANENT_CANARY);
    const entryId = response.json().entryId as string;
    expect(await storage.getVaultEntry(entryId)).toMatchObject({ projectId: 'A', kind: 'secret' });
    expect(await storage.listVaultEntryGrants(entryId)).toEqual([
      { projectId: 'A', familySlug: 'coder', familyMatched: true },
    ]);
    expect((await resolveValues(CODER, ['NEW_TOKEN'])).json().env).toEqual({
      NEW_TOKEN: PERMANENT_CANARY,
    });
    expect(await noticeBody()).toEqual([
      'Secret NEW_TOKEN is available — use devchain vault exec --only NEW_TOKEN -- <cmd>',
    ]);
  });

  it('adds a grant for the requesting family and keeps the grants of other families', async () => {
    const requestId = await pendingId('SHARED_KEY');

    const response = await post(`${requestId}/fulfill`, { permanent: true });

    expect(response.json()).toMatchObject({ status: 'fulfilled', entryId: sharedId });
    expect(await storage.listVaultEntryGrants(sharedId)).toEqual([
      { projectId: 'A', familySlug: 'coder', familyMatched: true },
      { projectId: 'A', familySlug: 'reviewer', familyMatched: true },
    ]);
    expect(await noticeBody()).toHaveLength(1);
  });

  it('gives a no-family requester an all-agents entry when stored permanently', async () => {
    const requestId = await pendingId('PLAIN_TOKEN', NO_FAMILY, 'a-plain');

    const { entryId } = (
      await post(`${requestId}/fulfill`, { value: 'v', permanent: true })
    ).json();

    expect(await storage.listVaultEntryGrants(entryId)).toEqual([
      { projectId: 'A', familySlug: null, familyMatched: true },
    ]);
  });

  it('keeps a session-only value in memory for that session until it stops', async () => {
    const requestId = await pendingId('SESSION_TOKEN');
    const state = jest.spyOn(vault, 'getState').mockReturnValue('locked');
    try {
      // No data key is needed: the value never goes to the DB.
      const response = await post(`${requestId}/fulfill`, {
        value: SESSION_CANARY,
        permanent: false,
      });
      expect(response.json()).toEqual({
        requestId,
        status: 'fulfilled',
        permanent: false,
        entryId: null,
        entryName: null,
      });
      expect((await resolveValues(CODER, ['SESSION_TOKEN'])).json().env).toEqual({
        SESSION_TOKEN: SESSION_CANARY,
      });
    } finally {
      state.mockRestore();
    }
    expect(await discovery.listForSession(CODER, 'a-coder')).toContainEqual({
      name: 'SESSION_TOKEN',
      kind: 'secret',
      description: 'SESSION_TOKEN for deploys',
      status: 'available',
      approvalRequired: false,
    });
    expect(await noticeBody()).toHaveLength(1);

    await emitter.emitAsync('session.stopped', {
      sessionId: CODER,
      source: 'web-api',
      reason: 'user-requested',
    });
    expect(
      (await discovery.listForSession(CODER, 'a-coder')).map((entry) => entry.name),
    ).not.toContain('SESSION_TOKEN');
  });

  it('refuses a permanent create while the Vault is locked and keeps the request pending', async () => {
    const requestId = await pendingId('LOCKED_TOKEN', NO_FAMILY, 'a-plain');
    const state = jest.spyOn(vault, 'getState').mockReturnValue('locked');
    const encrypt = jest.spyOn(vault, 'encrypt').mockImplementation(() => {
      throw new VaultUnavailableError('locked');
    });
    try {
      const response = await post(`${requestId}/fulfill`, { value: 'x', permanent: true });
      expect([response.statusCode, response.json().code]).toEqual([503, 'vault_unavailable']);
    } finally {
      state.mockRestore();
      encrypt.mockRestore();
    }
    expect((await post(`${requestId}/deny`, { reason: 'Later' })).statusCode).toBe(204);
  });

  it('denies with a reason, and a second answer to the same request is a conflict', async () => {
    const requestId = await pendingId('DENIED_TOKEN', NO_FAMILY, 'a-plain');

    const answers = await Promise.all([
      post(`${requestId}/deny`, { reason: 'Use the staging key' }),
      post(`${requestId}/fulfill`, { value: 'x', permanent: true }),
    ]);

    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([204, 409]);
    expect(answers[1].json().details).toEqual({ code: 'VAULT_REQUEST_NOT_PENDING' });
    expect(await noticeBody()).toEqual([
      'The user denied your request for secret DENIED_TOKEN. Reason: Use the staging key',
    ]);
    expect((await app.inject({ method: 'GET', url: '/api/vault/requests' })).json()).toEqual([]);
  });

  it('refuses a value for a grant request and never echoes a body', async () => {
    const requestId = await pendingId('SHARED_KEY', NO_FAMILY, 'a-plain');

    const withValue = await post(`${requestId}/fulfill`, {
      value: SESSION_CANARY,
      permanent: true,
    });
    const malformed = await post(`${requestId}/fulfill`, { value: SESSION_CANARY, extra: 1 });

    expect([withValue.statusCode, withValue.json().details]).toEqual([
      400,
      { code: 'VAULT_REQUEST_VALUE_NOT_ALLOWED' },
    ]);
    expect([malformed.statusCode, malformed.json().details]).toEqual([
      400,
      { code: 'VAULT_REQUEST_BODY_INVALID' },
    ]);
    for (const response of [withValue, malformed]) {
      expect(response.body).not.toContain(SESSION_CANARY);
    }
    await post(`${requestId}/deny`);
  });

  describe('from the phone', () => {
    let phone: MobileVaultRpcService;
    beforeAll(() => {
      phone = app.get(MobileVaultRpcService);
    });

    it('lists a request only to a device with access to the workspace of its project', async () => {
      const requestId = await pendingId('PHONE_LISTED');
      const listedTo = async (workspaceIds: string[] | null) =>
        (
          await phone.listRequests({}, undefined, {
            allowedWorkspaceIds: workspaceIds && new Set(workspaceIds),
          })
        ).map((request) => request.requestId);

      expect(await listedTo(null)).toEqual([requestId]);
      expect(await listedTo([DEFAULT_PROJECT_WORKSPACE_ID])).toEqual([requestId]);
      expect(await listedTo(['other-workspace'])).toEqual([]);
      await phone.denyRequest({ requestId });
    });

    it('stores, gives for one session, grants and denies like the web answer', async () => {
      const stored = await phone.fulfillRequest({
        requestId: await pendingId('PHONE_TOKEN'),
        value: PHONE_CANARY,
        permanent: true,
      });
      const sessionOnly = await phone.fulfillRequest({
        requestId: await pendingId('PHONE_SESSION_TOKEN'),
        value: PHONE_CANARY,
        permanent: false,
      });
      const granted = await phone.fulfillRequest({
        requestId: await pendingId('SHARED_KEY', NO_FAMILY, 'a-plain'),
        permanent: true,
      });
      const denied = await phone.denyRequest({
        requestId: await pendingId('PHONE_DENIED'),
        reason: 'Not on prod',
      });

      expect([stored.permanent, sessionOnly.entryId, granted.entryId, denied]).toEqual([
        true,
        null,
        sharedId,
        { ok: true },
      ]);
      expect(await storage.listVaultEntryGrants(stored.entryId!)).toEqual([
        { projectId: 'A', familySlug: 'coder', familyMatched: true },
      ]);
      expect(
        (await resolveValues(CODER, ['PHONE_TOKEN', 'PHONE_SESSION_TOKEN'])).json().env,
      ).toEqual({ PHONE_TOKEN: PHONE_CANARY, PHONE_SESSION_TOKEN: PHONE_CANARY });
      expect(await noticeBody()).toContain(
        'The user denied your request for secret PHONE_DENIED. Reason: Not on prod',
      );
    });

    it('ends a request answered from the web and the phone at the same time once', async () => {
      const requestId = await pendingId('RACED_TOKEN', NO_FAMILY, 'a-plain');

      const [phoneAnswer, webAnswer] = await Promise.all([
        phone.fulfillRequest({ requestId, value: PHONE_CANARY, permanent: false }).then(
          () => 'ended',
          (error: { details?: unknown }) => error.details,
        ),
        post(`${requestId}/deny`).then((response) =>
          response.statusCode === 204 ? 'ended' : response.json().details,
        ),
      ]);

      expect([phoneAnswer, webAnswer].sort()).toEqual(
        ['ended', { code: 'VAULT_REQUEST_NOT_PENDING' }].sort(),
      );
      expect(
        published.filter(
          (event) =>
            event.name === 'vault.request.resolved' &&
            (event.payload as { requestId: string }).requestId === requestId,
        ),
      ).toHaveLength(1);
    });

    it('refuses an answer to a request that is gone', async () => {
      const requestId = await pendingId('GONE_TOKEN', NO_FAMILY, 'a-plain');
      await phone.denyRequest({ requestId });

      await expect(phone.denyRequest({ requestId })).rejects.toMatchObject({
        statusCode: 409,
        details: { code: 'VAULT_REQUEST_NOT_PENDING' },
      });
    });
  });

  describe('use requests', () => {
    let approvals: VaultUseApprovalStore;
    let gatedId: string;
    let gatedFileId: string;
    let gatedAllId: string;
    beforeAll(async () => {
      approvals = app.get(VaultUseApprovalStore);
      const entries = app.get(VaultEntriesService);
      const gated = async (
        name: string,
        kind: 'secret' | 'file',
        access: { mode: 'all' } | { mode: 'families'; familySlugs: string[] },
      ) => {
        const { id } = await entries.createEntry({
          projects: [{ projectId: 'A', ...access }],
          name,
          kind,
          description: `${name} needs approval`,
          value: 'gated-value',
          approvalRequired: true,
        });
        return id;
      };
      gatedId = await gated('GATED_KEY', 'secret', { mode: 'families', familySlugs: ['coder'] });
      gatedFileId = await gated('GATED_FILE', 'file', { mode: 'families', familySlugs: ['coder'] });
      gatedAllId = await gated('GATED_ALL', 'secret', { mode: 'all' });
    });
    afterEach(async () => {
      for (const request of app.get(VaultRequestStore).listPending()) {
        await post(`${request.requestId}/deny`);
      }
    });

    const codeOf = (response: { statusCode: number; json(): { details?: unknown } }) => [
      response.statusCode,
      response.json().details,
    ];

    it('opens a use request for a granted name that needs approval and lists it on the web only', async () => {
      const result = await ask('GATED_KEY');
      const again = await ask('GATED_KEY');

      expect(result).toMatchObject({ status: 'pending', type: 'use' });
      expect(again).toMatchObject({ status: 'already_pending', type: 'use' });
      const requestId = (result as { requestId: string }).requestId;
      expect((await app.inject({ method: 'GET', url: '/api/vault/requests' })).json()).toEqual([
        expect.objectContaining({
          requestId,
          type: 'use',
          entryId: gatedId,
          kind: 'secret',
          familySlug: 'coder',
          entryDescription: 'GATED_KEY needs approval',
        }),
      ]);
      const phone = app.get(MobileVaultRpcService);
      const unrestricted = { allowedWorkspaceIds: null };
      expect(await phone.listRequests({}, undefined, unrestricted)).toEqual([]);
      expect(
        await phone.listRequests({ types: ['create', 'grant'] }, undefined, unrestricted),
      ).toEqual([]);
      expect(
        await phone.listRequests(
          { types: ['create', 'grant', 'use'] },
          { senderKid: 'kid-new' },
          unrestricted,
        ),
      ).toEqual([expect.objectContaining({ requestId, type: 'use', entryId: gatedId })]);
      expect([...app.get(VaultUseOptInRegistry).snapshot()]).toEqual(['kid-new']);
    });

    it('applies each phone decision like the web route and keeps its refusals', async () => {
      // Start from no session approval of an earlier test.
      approvals.onSessionStopped({ sessionId: CODER } as never);
      const phone = app.get(MobileVaultRpcService);
      const approveUse = async (name: string, decision: string) => {
        const requestId = await pendingId(name);
        return phone.approveUse({ requestId, decision }).then(
          (result) => result,
          (error: { details?: unknown }) => error.details,
        );
      };

      expect(await approveUse('GATED_FILE', 'once')).toEqual({ code: 'VAULT_REQUEST_ONCE_FILE' });
      expect(await approveUse('GATED_KEY', 'once')).toMatchObject({ decision: 'once' });
      const once = approvals.reserveOnce(CODER, [gatedId]);
      expect(once.entryIds.size).toBe(1);
      once.release();
      expect(await approveUse('GATED_FILE', 'session')).toMatchObject({ decision: 'session' });
      expect(approvals.hasSessionApproval(CODER, gatedFileId)).toBe(true);
      expect(await approveUse('GATED_ALL', 'family')).toMatchObject({
        status: 'approved',
        decision: 'family',
      });
      expect(await storage.listVaultUseFamilyApprovals({ entryId: gatedAllId })).toEqual([
        expect.objectContaining({ projectId: 'A', familySlug: 'coder' }),
      ]);
      await storage.removeVaultUseFamilyApproval(gatedAllId, 'A', 'coder');
      approvals.onSessionStopped({ sessionId: CODER } as never);
    });

    it('answers each request type only with its own route', async () => {
      const useId = await pendingId('GATED_KEY');
      const createId = await pendingId('NOT_GATED_NEW');

      expect(codeOf(await post(`${useId}/fulfill`, { permanent: true }))).toEqual([
        400,
        { code: 'VAULT_REQUEST_ANSWER_TYPE_MISMATCH' },
      ]);
      expect(codeOf(await approve(createId, 'session'))).toEqual([
        400,
        { code: 'VAULT_REQUEST_ANSWER_TYPE_MISMATCH' },
      ]);
      expect(codeOf(await approve(useId, 'forever'))).toEqual([
        400,
        { code: 'VAULT_REQUEST_BODY_INVALID' },
      ]);
      expect(app.get(VaultRequestStore).get(useId)).not.toBeNull();
    });

    it('refuses once for a file entry and family for a requester without one', async () => {
      const fileId = await pendingId('GATED_FILE');
      const plainId = await pendingId('GATED_ALL', NO_FAMILY, 'a-plain');

      expect(codeOf(await approve(fileId, 'once'))).toEqual([
        400,
        { code: 'VAULT_REQUEST_ONCE_FILE' },
      ]);
      expect(codeOf(await approve(plainId, 'family'))).toEqual([
        400,
        { code: 'VAULT_REQUEST_FAMILY_NONE' },
      ]);
      expect(await storage.listVaultUseFamilyApprovals({ entryId: gatedAllId })).toEqual([]);
      expect((await approve(fileId, 'session')).statusCode).toBe(200);
      expect(approvals.hasSessionApproval(CODER, gatedFileId)).toBe(true);
    });

    it('approves for the session, tells the agent, and a new ask finds the name available', async () => {
      const requestId = await pendingId('GATED_ALL', NO_FAMILY, 'a-plain');

      const response = await approve(requestId, 'session');

      expect([response.statusCode, response.json()]).toEqual([
        200,
        { requestId, status: 'approved', decision: 'session' },
      ]);
      expect(approvals.hasSessionApproval(NO_FAMILY, gatedAllId)).toBe(true);
      expect(await noticeBody()).toEqual([
        'Secret GATED_ALL is available — use devchain vault exec --only GATED_ALL -- <cmd>',
      ]);
      expect(await ask('GATED_ALL', NO_FAMILY, 'a-plain')).toEqual({
        status: 'available',
        name: 'GATED_ALL',
      });
    });

    it('refuses a family approval while home is locked and a VM holds a project, writing nothing', async () => {
      const requestId = await pendingId('GATED_KEY');
      await lockedWithRemoteBinding(async () => {
        expect(codeOf(await approve(requestId, 'family'))).toEqual([
          409,
          { code: 'VAULT_LOCKED_REMOTE_ACCESS' },
        ]);
      });
      expect(await storage.listVaultUseFamilyApprovals({ entryId: gatedId })).toEqual([]);
      expect(app.get(VaultRequestStore).get(requestId)).not.toBeNull();
    });

    it('denies for the session; an explicit ask opens a new use request and family approval lifts the denial', async () => {
      const deniedId = await pendingId('GATED_KEY');
      expect((await post(`${deniedId}/deny`)).statusCode).toBe(204);
      expect(approvals.isDenied(CODER, gatedId)).toBe(true);
      const gated = await resolveValues(CODER, ['GATED_KEY']);
      expect([gated.statusCode, gated.json().details?.code]).toEqual([403, 'VAULT_USE_DENIED']);
      expect(app.get(VaultRequestStore).listPending()).toEqual([]);

      const reAsked = await ask('GATED_KEY');
      expect(reAsked).toMatchObject({ status: 'pending', type: 'use' });
      const response = await approve((reAsked as { requestId: string }).requestId, 'family');

      expect(response.json()).toMatchObject({ status: 'approved', decision: 'family' });
      expect(await storage.listVaultUseFamilyApprovals({ entryId: gatedId })).toEqual([
        expect.objectContaining({ projectId: 'A', familySlug: 'coder' }),
      ]);
      expect(approvals.isDenied(CODER, gatedId)).toBe(false);
      expect(await ask('GATED_KEY')).toEqual({ status: 'available', name: 'GATED_KEY' });
      await storage.removeVaultUseFamilyApproval(gatedId, 'A', 'coder');
    });

    it('ends a use request raced by approve and deny once, with only the winner applied', async () => {
      // Forget the session approval an earlier test gave, so the name needs asking again.
      approvals.onSessionStopped({ sessionId: NO_FAMILY } as never);
      const requestId = await pendingId('GATED_ALL', NO_FAMILY, 'a-plain');

      const answers = await Promise.all([approve(requestId, 'once'), post(`${requestId}/deny`)]);

      const codes = answers.map((answer) => answer.statusCode);
      expect([...codes].sort()).toEqual(codes[0] === 200 ? [200, 409] : [204, 409]);
      expect(answers.find((answer) => answer.statusCode === 409)?.json().details).toEqual({
        code: 'VAULT_REQUEST_NOT_PENDING',
      });
      const approved = codes[0] === 200;
      expect(approvals.isDenied(NO_FAMILY, gatedAllId)).toBe(!approved);
      const reservation = approvals.reserveOnce(NO_FAMILY, [gatedAllId]);
      expect(reservation.entryIds.size).toBe(approved ? 1 : 0);
      reservation.release();
      expect(
        published.filter(
          (event) =>
            event.name === 'vault.request.resolved' &&
            (event.payload as { requestId: string }).requestId === requestId,
        ),
      ).toHaveLength(1);
    });
  });

  describe('mirrored from a VM', () => {
    let store: VaultRequestStore;
    let phone: MobileVaultRpcService;
    let mirrored = 0;
    let vmGatedId: string;
    beforeAll(async () => {
      const entries = app.get(VaultEntriesService);
      vmGatedId = (
        await entries.createEntry({
          projects: [{ projectId: 'A', mode: 'families', familySlugs: ['coder'] }],
          name: 'VM_GATED',
          kind: 'secret',
          description: 'VM_GATED needs approval',
          value: 'vm-gated-value',
          approvalRequired: true,
        })
      ).id;
      store = app.get(VaultRequestStore);
      phone = app.get(MobileVaultRpcService);
      sqlite
        .prepare(
          `INSERT INTO remotes (id, name, base_url, kind, created_at, updated_at)
           VALUES ('vm-1', 'build-vm', 'https://10.0.0.5:3000', 'address', 'T', 'T')`,
        )
        .run();
    });
    beforeEach(() => {
      pushConfirmed.mockReset().mockResolvedValue(undefined);
      resolveVaultRequest.mockReset().mockResolvedValue(undefined);
    });

    /** Adopts a request as the health poll does after its checks. */
    async function mirror(name: string, type: 'create' | 'grant' | 'use' = 'create') {
      mirrored += 1;
      const requestId = `00000000-0000-4000-8000-${String(mirrored).padStart(12, '0')}`;
      await store.syncRemote(
        'vm-1',
        [
          {
            requestId,
            projectId: 'A',
            sessionId: 'vm-session',
            agentId: 'a-coder',
            agentName: 'Coder',
            familySlug: 'coder',
            type,
            name,
            description: `${name} for deploys`,
            kind: 'secret',
            entryId: { create: null, grant: sharedId, use: vmGatedId }[type],
            createdAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
        ],
        10_000,
      );
      return requestId;
    }
    const vmRefusal = (hostCode: string | null, status = 409) =>
      new RemoteHostRequestError('refused', {
        remoteId: 'vm-1',
        path: '/api/host/vault/requests/x/resolve',
        status,
        hostCode,
      });
    const eventsFor = (name: string, requestId: string) =>
      published.filter(
        (event) =>
          event.name === name && (event.payload as { requestId: string }).requestId === requestId,
      );
    const resolvedStatus = (requestId: string) =>
      eventsFor('vault.request.resolved', requestId).map(
        (event) => (event.payload as { status: string }).status,
      );

    it('lists a mirrored request with the name of its VM on the web and the phone', async () => {
      const vmId = await mirror('VM_LISTED');
      const homeId = await pendingId('HOME_LISTED');
      const origins = (list: Array<{ requestId: string; remoteName: string | null }>) =>
        list
          .filter((request) => [vmId, homeId].includes(request.requestId))
          .map((request) => [request.requestId, request.remoteName]);
      const expected = [
        [vmId, 'build-vm'],
        [homeId, null],
      ];

      expect(
        origins((await app.inject({ method: 'GET', url: '/api/vault/requests' })).json()),
      ).toEqual(expected);
      expect(
        origins(await phone.listRequests({}, undefined, { allowedWorkspaceIds: null })),
      ).toEqual(expected);
      await post(`${vmId}/deny`);
      await post(`${homeId}/deny`);
    });

    it('never lists an answered request again when a list fetched before the answer arrives', async () => {
      // The modal opens for every listed request: a stale VM list must not bring it back.
      const requestId = await mirror('VM_ANSWERED');
      const reported = store.get(requestId)!;

      expect((await post(`${requestId}/deny`)).statusCode).toBe(204);
      await store.syncRemote('vm-1', [reported], 10_000);

      const listed = (await app.inject({ method: 'GET', url: '/api/vault/requests' })).json();
      expect(listed.map((request: { requestId: string }) => request.requestId)).not.toContain(
        requestId,
      );
      expect(resolvedStatus(requestId)).toEqual(['denied']);
      expect(eventsFor('vault.request.pending', requestId)).toHaveLength(1);
    });

    it('stores the entry, pushes it, and only then ends the request on the VM and at home', async () => {
      const requestId = await mirror('VM_STORED');
      pushConfirmed.mockImplementation(async () => {
        expect(resolveVaultRequest).not.toHaveBeenCalled();
        expect((await storage.listVaultEntries({ projectId: 'A' })).map((e) => e.name)).toContain(
          'VM_STORED',
        );
      });

      const response = await post(`${requestId}/fulfill`, { value: VM_CANARY, permanent: true });

      expect(response.statusCode).toBe(200);
      const { entryId } = response.json();
      expect(await storage.listVaultEntryGrants(entryId)).toEqual([
        { projectId: 'A', familySlug: 'coder', familyMatched: true },
      ]);
      expect(pushConfirmed.mock.calls).toEqual([['vm-1']]);
      expect(resolveVaultRequest.mock.calls).toEqual([
        ['vm-1', requestId, { status: 'fulfilled' }],
      ]);
      expect(store.get(requestId)).toBeNull();
      expect(resolvedStatus(requestId)).toEqual(['fulfilled']);
      // The VM's notifier tells the agent; home stays silent.
      expect(await noticeBody()).toEqual([]);
    });

    it('keeps the request pending when the push fails, and a retry grants the entry it created', async () => {
      const requestId = await mirror('VM_RETRIED');
      pushConfirmed.mockRejectedValueOnce(new VaultUnavailableError('locked'));

      const failed = await post(`${requestId}/fulfill`, { value: VM_CANARY, permanent: true });

      expect([failed.statusCode, failed.json().code]).toEqual([503, 'vault_unavailable']);
      expect(resolveVaultRequest).not.toHaveBeenCalled();
      expect(store.get(requestId)).not.toBeNull();
      const created = (await storage.listVaultEntries({ projectId: 'A' })).filter(
        (entry) => entry.name === 'VM_RETRIED',
      );
      expect(created).toHaveLength(1);

      const retried = await post(`${requestId}/fulfill`, { value: VM_CANARY, permanent: true });

      expect([retried.statusCode, retried.json().entryId]).toEqual([200, created[0].id]);
      expect(resolveVaultRequest).toHaveBeenCalledTimes(1);
      expect(resolvedStatus(requestId)).toEqual(['fulfilled']);
    });

    it('keeps an existing-entry answer pending when the push fails, and the same answer then ends it on the VM', async () => {
      const { id: entryId } = await app.get(VaultEntriesService).createEntry({
        projects: [],
        name: 'VM_EXISTING',
        kind: 'secret',
        description: 'VM_EXISTING entry',
        value: VM_CANARY,
      });
      const requestId = await mirror('VM_WANTED');
      pushConfirmed.mockRejectedValueOnce(new VaultUnavailableError('locked'));
      const fulfill = () => post(`${requestId}/fulfill`, { entryId, permanent: true });

      const failed = await fulfill();

      expect([failed.statusCode, failed.json().code]).toEqual([503, 'vault_unavailable']);
      expect(store.get(requestId)).not.toBeNull();
      const granted = await storage.listVaultEntryGrants(entryId);
      expect(granted).toEqual([{ projectId: 'A', familySlug: 'coder', familyMatched: true }]);

      const retried = await fulfill();

      expect([retried.statusCode, retried.json()]).toEqual([
        200,
        { requestId, status: 'fulfilled', permanent: true, entryId, entryName: 'VM_EXISTING' },
      ]);
      expect(await storage.listVaultEntryGrants(entryId)).toEqual(granted);
      expect(pushConfirmed).toHaveBeenCalledTimes(2);
      expect(resolveVaultRequest.mock.calls).toEqual([
        ['vm-1', requestId, { status: 'fulfilled', entryId }],
      ]);
      expect(eventsFor('vault.request.resolved', requestId)).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            status: 'fulfilled',
            grantedName: 'VM_EXISTING',
            grantedKind: 'secret',
          }),
        }),
      ]);
      expect(await noticeBody()).toEqual([]);
    });

    it('runs the work of one answer only when the web fulfills and the phone denies at once', async () => {
      const requestId = await mirror('VM_RACED');

      const [web, fromPhone] = await Promise.all([
        post(`${requestId}/fulfill`, { value: VM_CANARY, permanent: true }).then((response) =>
          response.statusCode === 200 ? 'ended' : response.json().details,
        ),
        phone.denyRequest({ requestId }).then(
          () => 'ended',
          (error: { details?: unknown }) => error.details,
        ),
      ]);

      expect([web, fromPhone].sort()).toEqual(
        ['ended', { code: 'VAULT_REQUEST_NOT_PENDING' }].sort(),
      );
      expect(resolveVaultRequest).toHaveBeenCalledTimes(1);
      const entries = (await storage.listVaultEntries({ projectId: 'A' })).filter(
        (entry) => entry.name === 'VM_RACED',
      );
      expect(entries).toHaveLength(web === 'ended' ? 1 : 0);
      expect(resolvedStatus(requestId)).toHaveLength(1);
    });

    it('ends a stored answer at home when the VM no longer has the request', async () => {
      const requestId = await mirror('SHARED_KEY', 'grant');
      resolveVaultRequest.mockRejectedValueOnce(vmRefusal('VAULT_REQUEST_NOT_PENDING'));

      const response = await post(`${requestId}/fulfill`, { permanent: true });

      expect([response.statusCode, response.json().entryId]).toEqual([200, sharedId]);
      expect(resolvedStatus(requestId)).toEqual(['fulfilled']);
    });

    it('refuses a grant answer whose entry is gone and keeps the request deniable', async () => {
      // The entry a grant request named was deleted at home after adoption. The grant
      // modal sends no value, so approval must fail with guidance, never a value demand.
      const requestId = await mirror('VM_GONE', 'grant');

      const response = await post(`${requestId}/fulfill`, { permanent: true });

      expect([response.statusCode, response.json().details]).toEqual([
        409,
        { code: 'VAULT_REQUEST_ENTRY_DELETED' },
      ]);
      expect(resolveVaultRequest).not.toHaveBeenCalled();
      expect(store.get(requestId)).not.toBeNull();

      expect((await post(`${requestId}/deny`)).statusCode).toBe(204);
      expect(resolvedStatus(requestId)).toEqual(['denied']);
    });

    it('refuses a grant answer by name for an entry outside the device scope and keeps the request', async () => {
      const entryId = await sharedOnlyInC('VM_C_ONLY');
      const requestId = await mirror('VM_C_ONLY', 'grant');

      await expect(
        app.get(VaultRequestFulfillService).fulfill(requestId, { permanent: true }, DEVICE_SCOPE),
      ).rejects.toMatchObject({ statusCode: 409, details: { code: 'VAULT_REQUEST_NOT_PENDING' } });

      expect(await storage.listVaultEntryGrants(entryId)).toEqual([
        { projectId: 'C', familySlug: null, familyMatched: true },
      ]);
      expect([pushConfirmed, resolveVaultRequest].map((mock) => mock.mock.calls.length)).toEqual([
        0, 0,
      ]);
      expect(store.get(requestId)).not.toBeNull();
      await post(`${requestId}/deny`);
    });

    it('gives the phone the VM refusal codes of a session-only answer and keeps the request', async () => {
      const requestId = await mirror('VM_SESSION');
      resolveVaultRequest
        .mockRejectedValueOnce(vmRefusal('VAULT_REQUEST_NOT_PENDING'))
        .mockRejectedValueOnce(vmRefusal('VAULT_REQUEST_SESSION_ENDED'))
        .mockRejectedValueOnce(vmRefusal(null, null as unknown as number));
      const answer = () => phone.fulfillRequest({ requestId, value: VM_CANARY, permanent: false });

      await expect(answer()).rejects.toMatchObject({
        statusCode: 409,
        details: { code: 'VAULT_REQUEST_NOT_PENDING' },
      });
      await expect(answer()).rejects.toMatchObject({
        statusCode: 409,
        details: { code: 'VAULT_REQUEST_SESSION_ENDED' },
      });
      // An unreachable VM is not a refusal: it stays the transport error.
      await expect(answer()).rejects.toMatchObject({ statusCode: 502 });
      expect(store.get(requestId)).not.toBeNull();

      await answer();
      expect(resolveVaultRequest.mock.calls[3]).toEqual([
        'vm-1',
        requestId,
        { status: 'fulfilled', sessionValue: { value: VM_CANARY } },
      ]);
      expect(pushConfirmed).not.toHaveBeenCalled();
      expect(resolvedStatus(requestId)).toEqual(['fulfilled']);
    });

    describe('use requests', () => {
      const familyRows = () => storage.listVaultUseFamilyApprovals({ entryId: vmGatedId });
      afterEach(async () => {
        await storage.removeVaultUseFamilyApproval(vmGatedId, 'A', 'coder');
      });

      it.each(['session', 'once'])(
        'sends a %s approval to the VM, which runs the session, and pushes nothing',
        async (decision) => {
          const requestId = await mirror('VM_GATED', 'use');

          const response = await approve(requestId, decision);

          expect([response.statusCode, response.json()]).toEqual([
            200,
            { requestId, status: 'approved', decision },
          ]);
          expect(resolveVaultRequest.mock.calls).toEqual([
            ['vm-1', requestId, { status: 'approved', decision }],
          ]);
          expect(pushConfirmed).not.toHaveBeenCalled();
          expect(resolvedStatus(requestId)).toEqual(['fulfilled']);
          expect(await noticeBody()).toEqual([]);
        },
      );

      it('writes a family approval, pushes it, and only then ends the request on the VM', async () => {
        const requestId = await mirror('VM_GATED', 'use');
        pushConfirmed.mockImplementation(async () => {
          expect(resolveVaultRequest).not.toHaveBeenCalled();
          expect(await familyRows()).toHaveLength(1);
        });

        const response = await approve(requestId, 'family');

        expect(response.statusCode).toBe(200);
        expect(await familyRows()).toEqual([
          expect.objectContaining({ projectId: 'A', familySlug: 'coder' }),
        ]);
        expect(pushConfirmed.mock.calls).toEqual([['vm-1']]);
        expect(resolveVaultRequest.mock.calls).toEqual([
          ['vm-1', requestId, { status: 'approved', decision: 'family' }],
        ]);
        expect(resolvedStatus(requestId)).toEqual(['fulfilled']);
      });

      it.each([
        ['VAULT_REQUEST_APPROVAL_NOT_DELIVERED', 'family'],
        ['VAULT_REQUEST_SESSION_ENDED', 'session'],
      ])(
        'gives back the VM refusal %s and keeps the request for a retry',
        async (code, decision) => {
          const requestId = await mirror('VM_GATED', 'use');
          resolveVaultRequest.mockRejectedValueOnce(vmRefusal(code));

          const refused = await approve(requestId, decision);

          expect([refused.statusCode, refused.json().details]).toEqual([409, { code }]);
          expect(store.get(requestId)).not.toBeNull();
          expect(resolvedStatus(requestId)).toEqual([]);

          expect((await approve(requestId, decision)).statusCode).toBe(200);
          expect(resolveVaultRequest).toHaveBeenCalledTimes(2);
          expect(resolvedStatus(requestId)).toEqual(['fulfilled']);
        },
      );

      it('refuses a family approval while home is locked and a VM holds a project', async () => {
        const requestId = await mirror('VM_GATED', 'use');
        await lockedWithRemoteBinding(async () => {
          const response = await approve(requestId, 'family');
          expect([response.statusCode, response.json().details]).toEqual([
            409,
            { code: 'VAULT_LOCKED_REMOTE_ACCESS' },
          ]);
        });
        expect(await familyRows()).toEqual([]);
        expect(pushConfirmed).not.toHaveBeenCalled();
        expect(resolveVaultRequest).not.toHaveBeenCalled();
        await post(`${requestId}/deny`);
      });
    });

    it('sends a denial with its trimmed reason to the VM', async () => {
      const requestId = await mirror('VM_DENIED');

      expect((await post(`${requestId}/deny`, { reason: '  Use staging  ' })).statusCode).toBe(204);

      expect(resolveVaultRequest.mock.calls).toEqual([
        ['vm-1', requestId, { status: 'denied', reason: 'Use staging' }],
      ]);
      expect(resolvedStatus(requestId)).toEqual(['denied']);
      expect(await noticeBody()).toEqual([]);
    });
  });

  describe('answers with an existing entry', () => {
    const ids: Record<string, string> = {};
    const otherNameNotice = (requested: string, granted: string) =>
      `Secret ${requested} is available under the name ${granted} — use devchain vault exec --only ${granted} -- <cmd>. If a tool reads $${requested}, set it inside the command: devchain vault exec --only ${granted} -- sh -c '${requested}="$${granted}" <cmd>'.`;
    const grantRows = (entryId: string) =>
      sqlite
        .prepare('SELECT * FROM vault_entry_grants WHERE entry_id = ? ORDER BY id')
        .all(entryId);
    const candidates = async (requestId: string) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/vault/requests/${requestId}/candidates`,
      });
      candidateBodies.push(response.body);
      return response;
    };

    beforeAll(async () => {
      sqlite
        .prepare(
          `INSERT INTO projects (id, name, root_path, created_at, updated_at)
           VALUES ('B', 'Project B', '/tmp/B', 'T', 'T')`,
        )
        .run();
      const inB = [{ projectId: 'B', mode: 'all' as const }];
      const toFamily = (familySlug: string) => ({
        projectId: 'A',
        mode: 'families' as const,
        familySlugs: [familySlug],
      });
      const entries: Array<[string, string, VaultEntryProjectAccess[]]> = [
        ['other', 'B_DEPLOY', inB],
        ['given', 'GIVEN_KEY', [toFamily('coder'), ...inB]],
        ['dupOwn', 'DUP_KEY', [toFamily('coder')]],
        ['dupShared', 'DUP_KEY', []],
        ['takenShared', 'TAKEN_KEY', []],
        ['takenOther', 'TAKEN_KEY', inB],
        ['sessionNamed', 'SESSION_NAMED', inB],
        ['reviewerKey', 'REVIEWER_KEY', [toFamily('reviewer')]],
        ['team', 'TEAM_TOKEN', [toFamily('reviewer'), ...inB]],
        ['bOnly', 'B_ONLY', inB],
        ['bRefused', 'B_REFUSED', inB],
        ['scopeB', 'SCOPE_B', inB],
        ['scopeC', 'SCOPE_C', [{ projectId: 'C', mode: 'all' }]],
        ['scopeSharedB', 'SCOPE_SHARED_B', [...inB, { projectId: 'C', mode: 'all' }]],
        ['scopeUngranted', 'SCOPE_UNGRANTED', []],
        ['scopeHeldB', 'SCOPE_HELD', inB],
      ];
      for (const [key, name, projects] of entries) {
        ids[key] = (
          await app.get(VaultEntriesService).createEntry({
            projects,
            name,
            kind: 'secret',
            description: `${name} entry`,
            value: EXISTING_CANARY,
          })
        ).id;
      }
      ids.scopeSharedC = await sharedOnlyInC('SCOPE_SHARED_C');
      ids.scopeHeldShared = await sharedOnlyInC('SCOPE_HELD');
      app.get(VaultSessionValueStore).set(CODER, {
        name: 'SESSION_NAMED',
        kind: 'secret',
        description: 'Session value',
        value: Buffer.from('session-named-value'),
      });
    });
    afterEach(async () => {
      for (const request of app.get(VaultRequestStore).listPending()) {
        await post(`${request.requestId}/deny`);
      }
    });
    afterAll(() => {
      app.get(VaultSessionValueStore).onSessionStopped({ sessionId: CODER } as never);
    });

    it('lists the entries that can answer a create request, the exact name first', async () => {
      const listed = (await candidates(await pendingId('B_DEPLOY'))).json() as Array<{
        id: string;
        name: string;
      }>;
      const entryOf = (key: string) => listed.find((c) => c.id === ids[key]) ?? 'left out';

      expect(listed[0]).toEqual({
        id: ids.other,
        name: 'B_DEPLOY',
        kind: 'secret',
        description: 'B_DEPLOY entry',
        ownerProjectId: 'B',
        ownerProjectName: 'Project B',
        alreadyAvailable: false,
      });
      const rest = listed.slice(1).map((c) => c.name);
      expect(rest).toEqual([...rest].sort());
      expect({
        'already granted to the requester': entryOf('given'),
        'own entry that supplies the name': entryOf('dupOwn'),
        'name supplied by a different granted entry': entryOf('dupShared'),
        'name held by a session-only value of the session': entryOf('sessionNamed'),
        'other project, name used by a shared entry': entryOf('takenOther'),
        'shared entry of that name': entryOf('takenShared'),
      }).toEqual({
        'already granted to the requester': expect.objectContaining({
          ownerProjectId: null,
          ownerProjectName: null,
          alreadyAvailable: true,
        }),
        'own entry that supplies the name': expect.objectContaining({
          ownerProjectId: 'A',
          ownerProjectName: 'Project A',
          alreadyAvailable: true,
        }),
        'name supplied by a different granted entry': 'left out',
        'name held by a session-only value of the session': 'left out',
        'other project, name used by a shared entry': 'left out',
        'shared entry of that name': expect.objectContaining({ alreadyAvailable: false }),
      });
      const grantRequest = await pendingId('REVIEWER_KEY');
      expect(app.get(VaultRequestStore).get(grantRequest)).toMatchObject({ type: 'grant' });
      expect((await candidates(grantRequest)).json()).toEqual([]);
      const gone = await candidates('00000000-0000-4000-8000-0000000000ff');
      expect([gone.statusCode, gone.json().details]).toEqual([
        409,
        { code: 'VAULT_REQUEST_NOT_PENDING' },
      ]);
    });

    it.each([
      [
        'a shared entry under another name',
        'TEAM_TOKEN_NEEDED',
        'team',
        'TEAM_TOKEN',
        [
          { projectId: 'A', familySlug: 'coder', familyMatched: true },
          { projectId: 'A', familySlug: 'reviewer', familyMatched: true },
          { projectId: 'B', familySlug: null, familyMatched: true },
        ],
        otherNameNotice('TEAM_TOKEN_NEEDED', 'TEAM_TOKEN'),
      ],
      [
        'an entry of another project with the requested name, which becomes shared',
        'B_ONLY',
        'bOnly',
        'B_ONLY',
        [
          { projectId: 'A', familySlug: 'coder', familyMatched: true },
          { projectId: 'B', familySlug: null, familyMatched: true },
        ],
        'Secret B_ONLY is available — use devchain vault exec --only B_ONLY -- <cmd>',
      ],
    ])(
      'grants %s to the requesting family',
      async (_case, requested, key, name, grants, notice) => {
        const requestId = await pendingId(requested);

        const response = await post(`${requestId}/fulfill`, { entryId: ids[key], permanent: true });

        expect([response.statusCode, response.json()]).toEqual([
          200,
          { requestId, status: 'fulfilled', permanent: true, entryId: ids[key], entryName: name },
        ]);
        expect(await storage.getVaultEntry(ids[key])).toMatchObject({
          projectId: null,
          revision: 1,
        });
        expect(await storage.listVaultEntryGrants(ids[key])).toEqual(grants);
        expect(app.get(VaultRequestStore).get(requestId)).toBeNull();
        expect(await noticeBody()).toEqual([notice]);
        expect((await resolveValues(CODER, [name])).json().env).toEqual({
          [name]: EXISTING_CANARY,
        });
      },
    );

    it('ends the request with no write when the requester already has the entry', async () => {
      const requestId = await pendingId('WANTS_GIVEN');
      const before = grantRows(ids.given);

      // A write would meet the locked-write rule; an entry the requester has needs none.
      await lockedWithRemoteBinding(async () => {
        const response = await post(`${requestId}/fulfill`, {
          entryId: ids.given,
          permanent: true,
        });
        expect([response.statusCode, response.json().entryName]).toEqual([200, 'GIVEN_KEY']);
      });

      expect(grantRows(ids.given)).toEqual(before);
      expect(await noticeBody()).toEqual([otherNameNotice('WANTS_GIVEN', 'GIVEN_KEY')]);
    });

    it.each([
      [
        'a value',
        'REFUSED_TOKEN',
        'bRefused',
        { value: 'x', permanent: true },
        400,
        'VAULT_REQUEST_VALUE_NOT_ALLOWED',
      ],
      [
        'a session-only answer',
        'REFUSED_TOKEN',
        'bRefused',
        { permanent: false },
        400,
        'VAULT_REQUEST_GRANT_PERMANENT_ONLY',
      ],
      [
        'a grant request',
        'REVIEWER_KEY',
        'bRefused',
        { permanent: true },
        400,
        'VAULT_REQUEST_ANSWER_TYPE_MISMATCH',
      ],
      [
        'an entry whose name another granted entry gives',
        'REFUSED_TOKEN',
        'dupShared',
        { permanent: true },
        409,
        'VAULT_REQUEST_ENTRY_NOT_SELECTABLE',
      ],
      [
        'a locked Vault while a VM holds a project',
        'REFUSED_TOKEN',
        'bRefused',
        { permanent: true },
        409,
        'VAULT_LOCKED_REMOTE_ACCESS',
      ],
    ] as const)(
      'refuses an existing entry with %s and keeps the request pending',
      async (_case, requested, key, body, status, code) => {
        const requestId = await pendingId(requested);
        let response!: Awaited<ReturnType<typeof post>>;
        const answer = async () => {
          response = await post(`${requestId}/fulfill`, { entryId: ids[key], ...body });
        };

        await (code === 'VAULT_LOCKED_REMOTE_ACCESS' ? lockedWithRemoteBinding(answer) : answer());

        expect([response.statusCode, response.json().details]).toEqual([status, { code }]);
        expect(app.get(VaultRequestStore).get(requestId)).not.toBeNull();
        expect(await storage.getVaultEntry(ids.bRefused)).toMatchObject({ projectId: 'B' });
        expect(await storage.listVaultEntryGrants(ids.bRefused)).toEqual([
          { projectId: 'B', familySlug: null, familyMatched: true },
        ]);
      },
    );

    it('lists only the entries inside a device scope', async () => {
      const service = app.get(VaultRequestFulfillService);
      const requestId = await pendingId('SCOPE_WANTED');
      const outcome = (listed: VaultRequestCandidate[], key: string) => {
        const candidate = listed.find((c) => c.id === ids[key]);
        if (!candidate) return 'left out';
        return candidate.alreadyAvailable ? 'already available' : 'listed';
      };
      const cases = [
        ['entry of a project in the allowed workspace', 'scopeB', 'listed', 'listed'],
        ['entry of a project in the other workspace', 'scopeC', 'listed', 'left out'],
        ['shared, granted in the allowed workspace', 'scopeSharedB', 'listed', 'listed'],
        ['shared, granted only in the other workspace', 'scopeSharedC', 'listed', 'left out'],
        ['shared, no grant rows', 'scopeUngranted', 'listed', 'left out'],
        ['shared, the requester resolves it', 'given', 'already available', 'already available'],
        [
          'allowed project, name held by a shared entry of the other workspace',
          'scopeHeldB',
          'left out',
          'left out',
        ],
      ] as const;

      const [unscoped, scoped] = await Promise.all([
        service.listCandidates(requestId),
        service.listCandidates(requestId, DEVICE_SCOPE),
      ]);

      const table = (listed: VaultRequestCandidate[]) =>
        Object.fromEntries(cases.map(([label, key]) => [label, outcome(listed, key)]));
      expect({ unscoped: table(unscoped), scoped: table(scoped) }).toEqual({
        unscoped: Object.fromEntries(cases.map(([label, , expected]) => [label, expected])),
        scoped: Object.fromEntries(cases.map(([label, , , expected]) => [label, expected])),
      });
      expect(JSON.stringify(scoped)).not.toMatch(/Project C|SCOPE_C|SCOPE_SHARED_C|"C"/);
    });

    it('hides and refuses a grant request for an entry used only in another workspace', async () => {
      const service = app.get(VaultRequestFulfillService);
      const store = app.get(VaultRequestStore);
      const entryId = await sharedOnlyInC('C_ONLY_KEY');
      const requestId = await pendingId('C_ONLY_KEY');
      expect(store.get(requestId)).toMatchObject({ type: 'grant', entryId });
      const listed = async (scope?: typeof DEVICE_SCOPE) =>
        (await service.listPending(scope)).map((request) => request.requestId);

      expect(await listed(DEVICE_SCOPE)).not.toContain(requestId);
      const refused = await service
        .fulfill(requestId, { permanent: true }, DEVICE_SCOPE)
        .catch((error: { statusCode: number; message: string; details: unknown }) => error);
      expect(refused).toMatchObject({
        statusCode: 409,
        message: 'This Vault request is no longer pending.',
        details: { code: 'VAULT_REQUEST_NOT_PENDING' },
      });
      expect(await storage.listVaultEntryGrants(entryId)).toEqual([
        { projectId: 'C', familySlug: null, familyMatched: true },
      ]);
      expect(store.get(requestId)).not.toBeNull();

      expect(await listed()).toContain(requestId);
      expect(await service.fulfill(requestId, { permanent: true })).toMatchObject({ entryId });
    });

    it('lists, grants and shows requests on a phone only inside its workspaces', async () => {
      const phone = app.get(MobileVaultRpcService);
      const requestId = await pendingId('PHONE_SCOPE_WANTED');
      const grantEntryId = await sharedOnlyInC('PHONE_C_ONLY_KEY');
      const grantRequestId = await pendingId('PHONE_C_ONLY_KEY');
      const scopeCGrants = grantRows(ids.scopeC);

      const [web, full, scoped, shown] = await Promise.all([
        candidates(requestId).then((response) => response.json() as VaultRequestCandidate[]),
        phone.listRequestCandidates({ requestId }, { allowedWorkspaceIds: null }),
        phone.listRequestCandidates({ requestId }, DEVICE_SCOPE),
        phone.listRequests({}, undefined, DEVICE_SCOPE),
      ]);
      const refused = await phone
        .fulfillRequest({ requestId, entryId: ids.scopeC, permanent: true }, DEVICE_SCOPE)
        .catch((error: { statusCode: number; details: unknown }) => error);

      expect(full).toEqual(web);
      expect(scoped.map((c) => c.id)).toEqual(
        expect.arrayContaining([ids.scopeB, ids.scopeSharedB]),
      );
      expect(scoped.map((c) => c.id)).not.toContain(ids.scopeC);
      expect(refused).toMatchObject({
        statusCode: 409,
        details: { code: 'VAULT_REQUEST_ENTRY_NOT_SELECTABLE' },
      });
      expect(grantRows(ids.scopeC)).toEqual(scopeCGrants);
      expect(app.get(VaultRequestStore).get(requestId)).not.toBeNull();
      expect(app.get(VaultRequestStore).get(grantRequestId)).toMatchObject({
        type: 'grant',
        entryId: grantEntryId,
      });
      expect(shown.map((request) => request.requestId)).toEqual(
        expect.arrayContaining([requestId]),
      );
      expect(shown.map((request) => request.requestId)).not.toContain(grantRequestId);
    });
  });

  it('never puts a value in the DB, a log line or an event', () => {
    expectNoCanaries({ logs: mockLogLines, events: published, candidates: candidateBodies }, [
      SESSION_CANARY,
      PERMANENT_CANARY,
      PHONE_CANARY,
      VM_CANARY,
      EXISTING_CANARY,
    ]);
    expect(candidateBodies.length).toBeGreaterThan(0);
    // Permanent values are sealed in the DB; none may appear in plain text.
    expectNoCanaries({ db: dumpDatabase(sqlite) }, [
      SESSION_CANARY,
      PERMANENT_CANARY,
      PHONE_CANARY,
      VM_CANARY,
      EXISTING_CANARY,
    ]);
    expect(published.map((event) => event.name)).toContain('vault.request.resolved');
  });
});
