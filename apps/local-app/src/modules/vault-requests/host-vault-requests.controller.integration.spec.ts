/**
 * Home's list and answers of a claimed VM's Vault requests, on the VM side: request →
 * host route answer → the VM's notice → the value through the VM's resolve route.
 * Test layer: controller integration. The host key check, the request store's single
 * transition, grant resolution over the pushed snapshot, the tmpfs value cache and the
 * session values only meet in a Nest app over a migrated DB and real files; message
 * delivery is the stubbed edge.
 */
const mockLogLines: unknown[] = [];
jest.mock('../../common/logging/logger', () => {
  const record = (...args: unknown[]) => mockLogLines.push(args);
  const child = { info: record, warn: record, error: record, debug: record, trace: record };
  return { createLogger: () => child, logger: child };
});

import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../../common/config/env.config';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { canaryForms, dumpDatabase, expectNoCanaries } from '../../common/test/vault-canary.helper';
import { AgentMessageDeliveryService } from '../agent-message-delivery/agent-message-delivery.service';
import { eventCatalog, type EventName } from '../events/catalog';
import { EventsService } from '../events/services/events.service';
import { hostRoutes } from '../remotes/contract/host-routes';
import { HostApiKeyService } from '../remotes/host/host-api-key.service';
import { HostHelperService } from '../remotes/host/host-helper.service';
import { RUNTIME_DIRECTORY_HOST } from '../runtime-directory/runtime-directory';
import { RuntimeDirectoryService } from '../runtime-directory/runtime-directory.service';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { LocalStorageService } from '../storage/local/local-storage.service';
import type { VaultSnapshot } from '../storage/models/domain.models';
import { SessionRowStore } from '../storage/sessions/session-row.store';
import { VaultAccessService } from '../vault/vault-access.service';
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
import { vaultSnapshotRevision } from '../vault/vault-snapshot-revision';
import { VaultValueReader } from '../vault/vault-value-reader';
import { VAULT_VM_CACHE_FILE, VaultVmCacheService } from '../vault/vault-vm-cache.service';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import { HostVaultRequestsController } from './host-vault-requests.controller';
import { VaultRequestNotifierSubscriber } from './vault-request-notifier.subscriber';
import { VaultRequestService } from './vault-request.service';
import { VaultRequestStore } from './vault-request.store';
import { VaultRequestVmAnswerService } from './vault-request-vm-answer.service';

const TMPFS = 0x01021994;
const KEY = `dck_${'b'.repeat(43)}`;
const CODER = '11111111-1111-4111-8111-111111111111';
const STORED_CANARY = 'canary-vm-stored-4d2e';
const SESSION_CANARY = 'canary-vm-session-8a71';

const entry: VaultSnapshot['entries'][number] = {
  id: 'e-api',
  projectId: 'A',
  name: 'API_TOKEN',
  kind: 'secret',
  description: 'Token for the API',
  revision: 1,
  approvalRequired: false,
};
const snapshot = {
  entries: [entry],
  grants: [{ entryId: 'e-api', projectId: 'A', familySlug: 'coder' }],
  access: [{ projectId: 'A', familySlug: null }],
  approvals: [],
};
const GRANTED_PUSH = {
  revision: vaultSnapshotRevision(snapshot),
  ...snapshot,
  values: [
    {
      entryId: 'e-api',
      revision: 1,
      valueBase64: Buffer.from(STORED_CANARY).toString('base64'),
    },
  ],
};
const gated: VaultSnapshot['entries'][number] = {
  ...entry,
  id: 'e-gated',
  name: 'GATED_TOKEN',
  approvalRequired: true,
};
function gatedPush(approvals: VaultSnapshot['approvals']) {
  const gatedSnapshot = {
    entries: [gated],
    grants: [{ entryId: 'e-gated', projectId: 'A', familySlug: 'coder' }],
    access: snapshot.access,
    approvals,
  };
  return {
    revision: vaultSnapshotRevision(gatedSnapshot),
    ...gatedSnapshot,
    values: [
      {
        entryId: 'e-gated',
        revision: 1,
        valueBase64: Buffer.from(STORED_CANARY).toString('base64'),
      },
    ],
  };
}
const ACCESS_ONLY = { entries: [], grants: [], access: snapshot.access, approvals: [] };
const ACCESS_PUSH = { revision: vaultSnapshotRevision(ACCESS_ONLY), ...ACCESS_ONLY, values: [] };

describe('Host Vault request routes on a claimed VM', () => {
  let root: string;
  let runtimeDir: string;
  let sqlite: Database.Database;
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;
  let store: VaultRequestStore;
  let cache: VaultVmCacheService;
  let sessionValues: VaultSessionValueStore;
  const published: Array<{ name: EventName; payload: unknown }> = [];
  const deliver = jest.fn().mockResolvedValue({ status: 'delivered', results: [] });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'host-vault-requests-'));
    runtimeDir = join(root, 'run');
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(join(root, '.devchain'));
    writeFileSync(join(root, 'claim.json'), JSON.stringify({ homePath: root }));
    writeFileSync(
      join(root, '.devchain', 'host-api-key'),
      `${createHash('sha256').update(KEY).digest('hex')}\n`,
    );
    jest
      .spyOn(config, 'getEnvConfig')
      .mockReturnValue({ ...config.getEnvConfig(), DEVCHAIN_HOST_ETC_DIR: root });

    const database = createTestDatabase();
    sqlite = database.sqlite;
    const insert = (sql: string) => sqlite.prepare(sql).run();
    insert(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
            VALUES ('A', 'Project A', '/tmp/A', 'T', 'T')`);
    insert(`INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
            VALUES ('p-coder', 'A', 'Coder', 'coder', 'T', 'T')`);
    insert(`INSERT INTO providers (id, name, mcp_configured, created_at, updated_at)
            VALUES ('prov', 'claude', 0, 'T', 'T')`);
    insert(`INSERT INTO profile_provider_configs
              (id, profile_id, provider_id, name, position, created_at, updated_at)
            VALUES ('c-coder', 'p-coder', 'prov', 'Coder', 0, 'T', 'T')`);
    insert(`INSERT INTO agents
              (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
            VALUES ('a-coder', 'A', 'p-coder', 'c-coder', 'Coder', 'T', 'T')`);
    insert(`INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
            VALUES ('${CODER}', 'a-coder', 'running', 'T', 'T', 'T')`);
    const storage = new LocalStorageService(database.db);

    const unavailable = () => Promise.reject(new VaultKeystoreUnavailableError());
    published.length = 0;
    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      controllers: [HostVaultRequestsController, VaultResolveController],
      providers: [
        HostApiKeyService,
        { provide: HostHelperService, useValue: { assertClaimedHost: () => undefined } },
        VaultKeyService,
        VaultAccessService,
        VaultEntriesService,
        VaultValueReader,
        VaultResolveService,
        VaultUseGate,
        VaultUseApprovalStore,
        VaultLocalPeerGuard,
        VaultVmCacheService,
        VaultSessionValueStore,
        { provide: VAULT_SESSION_OVERLAY, useExisting: VaultSessionValueStore },
        VaultRequestStore,
        VaultRequestService,
        VaultRequestVmAnswerService,
        VaultRequestNotifierSubscriber,
        SessionRowStore,
        RuntimeDirectoryService,
        {
          provide: RUNTIME_DIRECTORY_HOST,
          useValue: {
            platform: 'linux',
            dbPath: join(root, 'devchain.db'),
            env: () => ({ RUNTIME_DIRECTORY: runtimeDir }),
            isLingering: () => false,
            fileSystemType: async () => TMPFS,
          },
        },
        { provide: DB_CONNECTION, useValue: database.db },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: AgentMessageDeliveryService, useValue: { deliver } },
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
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    store = moduleRef.get(VaultRequestStore);
    cache = moduleRef.get(VaultVmCacheService);
    sessionValues = moduleRef.get(VaultSessionValueStore);
    // The project's Vault is on, with no entry for the agent yet.
    await cache.apply(ACCESS_PUSH);
    deliver.mockClear();
    mockLogLines.length = 0;
  });

  afterEach(async () => {
    store.onModuleDestroy();
    await app.close();
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // app.inject calls come from 127.0.0.1, as a VM agent's would.
  const auth = { authorization: `Bearer ${KEY}` };
  const list = (headers: Record<string, string> = auth) =>
    app.inject({ method: 'GET', url: '/api/host/vault/requests', headers });
  const answer = (requestId: string, payload: unknown, headers: Record<string, string> = auth) =>
    app.inject({
      method: 'POST',
      url: `/api/host/vault/requests/${requestId}/resolve`,
      headers,
      payload: payload as Record<string, unknown>,
    });
  const resolveValue = () =>
    app.inject({
      method: 'POST',
      url: '/api/vault/sessions/resolve',
      payload: { sessionId: CODER, names: ['API_TOKEN'] },
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const notices = async () => {
    await settle();
    return deliver.mock.calls.map((call) => (call[1] as { body: string }).body);
  };
  async function pendingId(): Promise<string> {
    const result = await moduleRef.get(VaultRequestService).request({
      sessionId: CODER,
      agentId: 'a-coder',
      name: 'API_TOKEN',
      description: 'API_TOKEN for deploys',
    });
    if (!('requestId' in result)) throw new Error('API_TOKEN is already available');
    return result.requestId;
  }
  const resolvedEvents = () =>
    published.filter((event) => event.name === 'vault.request.resolved').map((e) => e.payload);

  it('refuses a loopback caller without the host API key on both routes', async () => {
    const requestId = await pendingId();

    const responses = [
      await list({}),
      await answer(requestId, { status: 'denied' }, {}),
      await answer(requestId, { status: 'approved', decision: 'session' }, {}),
    ];

    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401]);
    expect(store.get(requestId)).not.toBeNull();
  });

  it('lists pending requests as metadata', async () => {
    const requestId = await pendingId();

    const response = await list();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      requests: [
        expect.objectContaining({
          requestId,
          type: 'create',
          name: 'API_TOKEN',
          sessionId: CODER,
          agentId: 'a-coder',
          familySlug: 'coder',
          entryId: null,
        }),
      ],
    });
  });

  it.each([
    ['the snapshot has no grant for the name', async () => undefined],
    [
      'the value cache lacks the granted entry',
      async () => {
        await cache.apply(GRANTED_PUSH);
        rmSync(join(runtimeDir, VAULT_VM_CACHE_FILE));
      },
    ],
  ])('keeps a stored answer pending with 409 when %s', async (_name, arrange) => {
    const requestId = await pendingId();
    await arrange();

    const response = await answer(requestId, { status: 'fulfilled' });

    expect([response.statusCode, response.json().details]).toEqual([
      409,
      { code: 'VAULT_REQUEST_VALUE_NOT_DELIVERED' },
    ]);
    expect(store.get(requestId)).not.toBeNull();
    expect(resolvedEvents()).toEqual([]);
  });

  it('ends a stored answer once the value is granted and cached, and tells the agent', async () => {
    const requestId = await pendingId();
    await cache.apply(GRANTED_PUSH);

    const response = await answer(requestId, { status: 'fulfilled' });

    expect(response.statusCode).toBe(204);
    expect(store.get(requestId)).toBeNull();
    expect(resolvedEvents()).toEqual([
      expect.objectContaining({ requestId, status: 'fulfilled', name: 'API_TOKEN' }),
    ]);
    expect(await notices()).toEqual([
      'Secret API_TOKEN is available — use devchain vault exec --only API_TOKEN -- <cmd>',
    ]);
    expect((await resolveValue()).json().env).toEqual({ API_TOKEN: STORED_CANARY });
    expect((await answer(requestId, { status: 'fulfilled' })).json().details).toEqual({
      code: 'VAULT_REQUEST_NOT_PENDING',
    });
  });

  it('keeps a session-only value in memory for the asking session and ends the request', async () => {
    const requestId = await pendingId();

    const response = await answer(requestId, {
      status: 'fulfilled',
      sessionValue: { value: SESSION_CANARY },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(store.get(requestId)).toBeNull();
    expect((await resolveValue()).json().env).toEqual({ API_TOKEN: SESSION_CANARY });
    expect(await notices()).toHaveLength(1);
  });

  it('refuses a session-only value for a stopped session and stores nothing', async () => {
    const requestId = await pendingId();
    sqlite.prepare(`UPDATE sessions SET status = 'stopped' WHERE id = ?`).run(CODER);

    const response = await answer(requestId, {
      status: 'fulfilled',
      sessionValue: { value: SESSION_CANARY },
    });

    expect([response.statusCode, response.json().details]).toEqual([
      409,
      { code: 'VAULT_REQUEST_SESSION_ENDED' },
    ]);
    expect(sessionValues.valuesFor(CODER)).toEqual([]);
    expect(store.get(requestId)).not.toBeNull();
  });

  it('denies with the reason, and refuses an unknown or ended request', async () => {
    const requestId = await pendingId();

    const denied = await answer(requestId, { status: 'denied', reason: 'Use staging' });
    const again = await answer(requestId, { status: 'denied' });
    const unknown = await answer('00000000-0000-4000-8000-000000000000', { status: 'denied' });

    expect(denied.statusCode).toBe(204);
    expect(await notices()).toEqual([
      'The user denied your request for secret API_TOKEN. Reason: Use staging',
    ]);
    for (const response of [again, unknown]) {
      expect([response.statusCode, response.json().details]).toEqual([
        409,
        { code: 'VAULT_REQUEST_NOT_PENDING' },
      ]);
    }
  });

  it('never echoes a body or a value in a response, an event, the DB or the logs', async () => {
    const requestId = await pendingId();
    sqlite.prepare(`UPDATE sessions SET status = 'stopped' WHERE id = ?`).run(CODER);
    const sessionValue = { value: SESSION_CANARY };

    const responses = [
      await answer(requestId, { status: 'fulfilled', sessionValue, extra: SESSION_CANARY }),
      await answer(requestId, {
        status: 'fulfilled',
        sessionValue: { value: `${SESSION_CANARY}\n` },
      }),
      await answer(requestId, { status: 'fulfilled', sessionValue }),
      await answer('missing', { status: 'fulfilled', sessionValue }),
      await answer(requestId, { status: 'fulfilled', sessionValue }, {}),
      await list(),
      await app.inject({
        method: 'POST',
        url: `/api/host/vault/requests/${requestId}/resolve`,
        headers: { ...auth, 'content-type': 'application/json' },
        payload: `{"status":"fulfilled","sessionValue":{"value":${SESSION_CANARY}}}`,
      }),
    ];

    expect(responses.map((response) => response.statusCode)).toEqual([
      400, 400, 409, 409, 401, 200, 400,
    ]);
    expectNoCanaries(
      {
        responses: responses.map((response) => response.body),
        events: published,
        db: dumpDatabase(sqlite),
        logs: mockLogLines,
      },
      canaryForms([SESSION_CANARY]),
    );
  });

  describe('use requests', () => {
    const resolveGated = () =>
      app.inject({
        method: 'POST',
        url: '/api/vault/sessions/resolve',
        payload: { sessionId: CODER, names: ['GATED_TOKEN'] },
      });
    const codeOf = (response: { statusCode: number; json(): { details?: { code?: string } } }) => [
      response.statusCode,
      response.json().details?.code,
    ];
    async function usePendingId(): Promise<string> {
      await cache.apply(gatedPush([]));
      expect(codeOf(await resolveGated())).toEqual([409, 'VAULT_USE_APPROVAL_PENDING']);
      const [request] = store.listPending();
      expect(request).toMatchObject({ type: 'use', entryId: 'e-gated', name: 'GATED_TOKEN' });
      return request.requestId;
    }

    it.each([
      ['session', 200],
      ['once', 409],
    ])('applies a %s approval to the session here and tells the agent', async (decision, again) => {
      const requestId = await usePendingId();

      const response = await answer(requestId, { status: 'approved', decision });

      expect(response.statusCode).toBe(204);
      expect(store.get(requestId)).toBeNull();
      expect(await notices()).toEqual([
        'Secret GATED_TOKEN is available — use devchain vault exec --only GATED_TOKEN -- <cmd>',
      ]);
      expect((await resolveGated()).json().env).toEqual({ GATED_TOKEN: STORED_CANARY });
      expect((await resolveGated()).statusCode).toBe(again);
    });

    it('denies the use for the session here', async () => {
      const requestId = await usePendingId();

      expect((await answer(requestId, { status: 'denied' })).statusCode).toBe(204);

      expect(codeOf(await resolveGated())).toEqual([403, 'VAULT_USE_DENIED']);
      expect(store.listPending()).toEqual([]);
    });

    it('refuses a session approval for a stopped session and keeps the request', async () => {
      const requestId = await usePendingId();
      sqlite.prepare(`UPDATE sessions SET status = 'stopped' WHERE id = ?`).run(CODER);

      const response = await answer(requestId, { status: 'approved', decision: 'session' });

      expect(codeOf(response)).toEqual([409, 'VAULT_REQUEST_SESSION_ENDED']);
      expect(store.get(requestId)).not.toBeNull();
    });

    it('ends a family approval only once the pushed snapshot holds the approval row', async () => {
      const requestId = await usePendingId();
      const family = { status: 'approved', decision: 'family' };

      const early = await answer(requestId, family);
      expect(codeOf(early)).toEqual([409, 'VAULT_REQUEST_APPROVAL_NOT_DELIVERED']);
      expect(store.get(requestId)).not.toBeNull();

      await cache.apply(gatedPush([{ entryId: 'e-gated', projectId: 'A', familySlug: 'coder' }]));
      expect((await answer(requestId, family)).statusCode).toBe(204);
      expect(store.get(requestId)).toBeNull();
      expect((await resolveGated()).json().env).toEqual({ GATED_TOKEN: STORED_CANARY });
    });

    it('ends a use request only with a decision or a denial, and approves nothing else', async () => {
      const useId = await usePendingId();
      const createId = await pendingId();

      const responses = [
        await answer(useId, { status: 'fulfilled' }),
        await answer(useId, { status: 'approved' }),
        await answer(createId, { status: 'approved', decision: 'session' }),
      ];

      expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400]);
      expect(responses[0].json().details).toEqual({ code: 'VAULT_REQUEST_ANSWER_TYPE_MISMATCH' });
      expect(responses[2].json().details).toEqual({ code: 'VAULT_REQUEST_ANSWER_TYPE_MISMATCH' });
      expect([store.get(useId), store.get(createId)]).not.toContain(null);
      expect(resolvedEvents()).toEqual([]);
    });
  });

  it('rejects any extra field on the request list wire, such as a value', () => {
    const schema = hostRoutes.listVaultRequests.statuses[200];
    const request = {
      requestId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
      type: 'grant',
      name: 'API_TOKEN',
      kind: 'secret',
      description: 'Token',
      projectId: 'p1',
      sessionId: 's1',
      agentId: 'a1',
      agentName: 'Coder',
      familySlug: 'coder',
      entryId: 'e1',
      createdAt: 1,
      expiresAt: 2,
    };

    expect(schema.safeParse({ requests: [request] }).success).toBe(true);
    expect(schema.safeParse({ requests: [{ ...request, value: 'x' }] }).success).toBe(false);
  });
});
