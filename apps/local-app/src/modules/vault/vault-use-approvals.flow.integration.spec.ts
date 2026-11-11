/**
 * Use approvals end to end on home: a gated entry asked for by name → a `use` request →
 * each answer (this session, once, the family, deny) → what later resolves of the same
 * and of a sibling session get. Test layer: app integration. The gate, the one-shot
 * reserve and commit around delivery, the request store, the answer route and the
 * family rows only meet in the whole app. Terminal IO, the PTY and processes are the
 * stubbed edges.
 */
const mockLogLines: unknown[] = [];
jest.mock('../../common/logging/logger', () => {
  const record = (...args: unknown[]) => mockLogLines.push(args);
  const child = { info: record, warn: record, error: record, debug: record, trace: record };
  return { createLogger: () => child, logger: child };
});

import { EventEmitter2 } from '@nestjs/event-emitter';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../../app.module';
import { resetEnvConfig } from '../../common/config/env.config';
import { VaultUnavailableError } from '../../common/errors/error-types';
import { applyExternalBoundaryMocks } from '../../common/test/app-bootstrap.helper';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { canaryForms, dumpDatabase, expectNoCanaries } from '../../common/test/vault-canary.helper';
import { McpService } from '../mcp/services/mcp.service';
import { ProviderAdapterFactory } from '../providers/adapters';
import { PROVIDER_CLI_INSTALL_ROOT } from '../providers/services/provider-cli-install-state.service';
import { SettingsService } from '../settings/services/settings.service';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { PtyService } from '../terminal/services/pty.service';
import { TerminalIOService } from '../terminal/services/terminal-io/terminal-io.service';
import { VAULT_KEYSTORE, VaultKeystoreUnavailableError } from './vault-keystore';
import { VaultUseApprovalStore } from './vault-use-approvals';
import { VaultValueReader } from './vault-value-reader';

const OPEN = 'canary-use-open-71c2';
const FOR_SESSION = 'canary-use-session-3e8a';
const FOR_ONCE = 'canary-use-once-b5d0';
const FOR_FAMILY = 'canary-use-family-9f14';
const FOR_DENY = 'canary-use-deny-c62b';
const ALL_CANARIES = canaryForms([OPEN, FOR_SESSION, FOR_ONCE, FOR_FAMILY, FOR_DENY]);

const PROJECT = randomUUID();
const AGENT = randomUUID();
const SIBLING = randomUUID();
const ISOLATED_ENV = [
  'HOME',
  'DB_PATH',
  'DB_FILENAME',
  'SKIP_PREFLIGHT',
  'PROVIDER_CLI_CHECKS_ENABLED',
  'DEVCHAIN_HOST_ETC_DIR',
  'RUNTIME_DIRECTORY',
];

type Response = Awaited<ReturnType<NestFastifyApplication['inject']>>;

describe('Vault use approvals end to end', () => {
  let app: NestFastifyApplication;
  let sqlite: Database.Database;
  let root: string;
  /** A session of the coder family, and a sibling session of the same family. */
  let session: string;
  let sibling: string;
  let ids: Record<'session' | 'once' | 'family' | 'deny', string>;
  const savedEnv = new Map(ISOLATED_ENV.map((key) => [key, process.env[key]]));
  const events: unknown[] = [];
  /** Every REST response body except the resolve route's 200s, the one value-returning answer. */
  const otherBodies: Array<{ url: string; body: string }> = [];
  const toolResults: unknown[] = [];
  const terminalIO = {
    createEmptySession: jest.fn().mockResolvedValue({ name: 'tmux-use' }),
    setAlternateScreen: jest.fn().mockResolvedValue(undefined),
    destroySession: jest.fn().mockResolvedValue(undefined),
    destroyExpectedSession: jest.fn().mockResolvedValue({ outcome: 'destroyed' }),
    typeCommand: jest.fn().mockResolvedValue(undefined),
    waitForOutput: jest.fn().mockResolvedValue(true),
    sessionExists: jest.fn().mockResolvedValue(true),
    listAllSessionNames: jest.fn().mockResolvedValue(new Set()),
    startHealthCheck: jest.fn(),
    deliver: jest.fn().mockResolvedValue({ confirmed: true, method: 'bracketed-paste' }),
    deliverImmediate: jest.fn().mockResolvedValue({ confirmed: true }),
    sendControl: jest.fn().mockResolvedValue(undefined),
  };

  async function http(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) {
    const response = await app.inject({ method, url, ...(payload && { payload }) });
    if (url !== '/api/vault/sessions/resolve' || response.statusCode !== 200) {
      otherBodies.push({ url, body: response.body });
    }
    return response;
  }
  const resolve = (sessionId: string, names?: string[]) =>
    http('POST', '/api/vault/sessions/resolve', { sessionId, ...(names && { names }) });
  const refusal = (response: Response) => [
    response.statusCode,
    (response.json() as { details?: unknown }).details,
  ];
  const pending = async () =>
    (await http('GET', '/api/vault/requests')).json() as Array<{
      requestId: string;
      type: string;
      name: string;
      sessionId: string;
    }>;
  /** The one pending request of `sessionId` for `name`. */
  async function requestFor(sessionId: string, name: string) {
    const matching = (await pending()).filter(
      (request) => request.sessionId === sessionId && request.name === name,
    );
    expect(matching).toEqual([expect.objectContaining({ type: 'use' })]);
    return matching[0].requestId;
  }
  const approve = (requestId: string, decision: string) =>
    http('POST', `/api/vault/requests/${requestId}/approve`, { decision });
  /** An explicit ask that the gate holds for approval and turns into a `use` request. */
  async function askByName(sessionId: string, name: string) {
    expect(refusal(await resolve(sessionId, [name]))).toEqual([
      409,
      { code: 'VAULT_USE_APPROVAL_PENDING', names: [name] },
    ]);
    return requestFor(sessionId, name);
  }
  const envOf = async (sessionId: string, name: string) => {
    const response = await resolve(sessionId, [name]);
    expect(response.statusCode).toBe(200);
    return (response.json() as { env: Record<string, string> }).env[name];
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-use-'));
    mkdirSync(join(root, 'run'), { mode: 0o700 });
    mkdirSync(join(root, 'project'));
    Object.assign(process.env, {
      HOME: root,
      DB_PATH: root,
      DB_FILENAME: 'test.db',
      SKIP_PREFLIGHT: '1',
      PROVIDER_CLI_CHECKS_ENABLED: 'false',
      DEVCHAIN_HOST_ETC_DIR: join(root, 'etc'),
      RUNTIME_DIRECTORY: join(root, 'run'),
    });
    resetEnvConfig();
    const fixture = createTestDatabase();
    sqlite = fixture.sqlite;
    await new SettingsService(fixture.db, new EventEmitter2()).updateSettings({
      registry: { cacheDir: join(root, 'registry'), checkUpdatesOnStartup: false },
      skills: { syncOnStartup: false },
    });
    const unavailable = () => Promise.reject(new VaultKeystoreUnavailableError());
    const moduleRef = await applyExternalBoundaryMocks(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DB_CONNECTION)
        .useValue(fixture.db),
    )
      .overrideProvider(ProviderAdapterFactory)
      .useClass(ProviderAdapterFactory)
      .overrideProvider(PROVIDER_CLI_INSTALL_ROOT)
      .useValue(join(root, 'provider-clis'))
      .overrideProvider(TerminalIOService)
      .useValue(terminalIO)
      .overrideProvider(PtyService)
      .useValue({
        setOutputHandler: jest.fn(),
        startStreaming: jest.fn().mockResolvedValue(undefined),
        stopStreaming: jest.fn(),
      })
      .overrideProvider(VAULT_KEYSTORE)
      .useValue({
        isAvailable: () => false,
        read: unavailable,
        write: unavailable,
        remove: unavailable,
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    app.get(EventEmitter2).onAny((event, payload) => events.push([event, payload]));

    const insert = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    insert(
      `INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, 'Alpha', ?, 'T', 'T')`,
      PROJECT,
      join(root, 'project'),
    );
    insert(`INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
            VALUES ('prov', 'claude', '/usr/bin/true', 1, 'T', 'T')`);
    insert(
      `INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
       VALUES ('p-coder', ?, 'Coder', 'coder', 'T', 'T')`,
      PROJECT,
    );
    insert(`INSERT INTO profile_provider_configs
              (id, profile_id, provider_id, name, position, created_at, updated_at)
            VALUES ('c-coder', 'p-coder', 'prov', 'default', 0, 'T', 'T')`);
    insert(
      `INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
       VALUES (?, ?, 'p-coder', 'c-coder', 'Coder', 'T', 'T'),
              (?, ?, 'p-coder', 'c-coder', 'Coder Two', 'T', 'T')`,
      AGENT,
      PROJECT,
      SIBLING,
      PROJECT,
    );

    expect((await http('POST', '/api/vault/setup', { mode: 'recovery' })).statusCode).toBe(200);
    const coders = [{ projectId: PROJECT, mode: 'families', familySlugs: ['coder'] }];
    const create = async (name: string, value: string, approvalRequired: boolean) => {
      const response = await http('POST', '/api/vault/entries', {
        projects: coders,
        name,
        kind: 'secret',
        description: `${name} for the deploy`,
        value,
        approvalRequired,
      });
      expect(response.statusCode).toBe(201);
      return response.json().id as string;
    };
    await create('OPEN_TOKEN', OPEN, false);
    ids = {
      session: await create('GATED_SESSION', FOR_SESSION, true),
      once: await create('GATED_ONCE', FOR_ONCE, true),
      family: await create('GATED_FAMILY', FOR_FAMILY, true),
      deny: await create('GATED_DENY', FOR_DENY, true),
    };
    const access = await http('PUT', `/api/vault/projects/${PROJECT}/grants`, {
      entries: [],
      access: { mode: 'families', familySlugs: ['coder'] },
    });
    expect(access.statusCode).toBe(200);

    const launch = async (agentId: string) => {
      const launched = await http('POST', '/api/sessions/launch', { projectId: PROJECT, agentId });
      expect(launched.statusCode).toBe(201);
      return launched.json().id as string;
    };
    session = await launch(AGENT);
    sibling = await launch(SIBLING);
  }, 60_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      sqlite?.close();
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetEnvConfig();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('1. a resolve without names omits the gated entries, names them, and asks nobody', async () => {
    const response = await resolve(session);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      env: { OPEN_TOKEN: OPEN },
      files: {},
      needsApproval: ['GATED_DENY', 'GATED_FAMILY', 'GATED_ONCE', 'GATED_SESSION'],
    });
    expect(await pending()).toEqual([]);
  });

  it('2. "this session" lets the session use the entry on every resolve, and no other session', async () => {
    const requestId = await askByName(session, 'GATED_SESSION');
    // Asking again before the answer opens no second request.
    expect((await resolve(session, ['GATED_SESSION'])).statusCode).toBe(409);
    expect(await pending()).toHaveLength(1);

    expect((await approve(requestId, 'session')).statusCode).toBe(200);

    expect(await envOf(session, 'GATED_SESSION')).toBe(FOR_SESSION);
    expect(await envOf(session, 'GATED_SESSION')).toBe(FOR_SESSION);
    const siblingId = await askByName(sibling, 'GATED_SESSION');
    expect((await http('POST', `/api/vault/requests/${siblingId}/deny`)).statusCode).toBe(204);
  });

  it('3. "once" gives exactly one delivery, and a failed delivery spends nothing', async () => {
    const requestId = await askByName(session, 'GATED_ONCE');
    expect((await approve(requestId, 'once')).statusCode).toBe(200);
    jest
      .spyOn(app.get(VaultValueReader), 'read')
      .mockRejectedValueOnce(new VaultUnavailableError('locked'));

    expect((await resolve(session, ['GATED_ONCE'])).statusCode).toBe(503);
    expect(await envOf(session, 'GATED_ONCE')).toBe(FOR_ONCE);

    const again = await askByName(session, 'GATED_ONCE');
    expect((await http('POST', `/api/vault/requests/${again}/deny`)).statusCode).toBe(204);
  });

  it('4. "the family" lasts for every session of the family until the approval is removed', async () => {
    const requestId = await askByName(session, 'GATED_FAMILY');

    expect((await approve(requestId, 'family')).statusCode).toBe(200);

    expect(await envOf(session, 'GATED_FAMILY')).toBe(FOR_FAMILY);
    expect(await envOf(sibling, 'GATED_FAMILY')).toBe(FOR_FAMILY);
    expect(await pending()).toEqual([]);
    const removed = await http(
      'DELETE',
      `/api/vault/entries/${ids.family}/approvals/${PROJECT}/coder`,
    );
    expect(removed.statusCode).toBeLessThan(300);
    const reGated = await askByName(sibling, 'GATED_FAMILY');
    expect((await http('POST', `/api/vault/requests/${reGated}/deny`)).statusCode).toBe(204);
  });

  it('5. a denial holds for the session without new asks, and an explicit request reopens it', async () => {
    const requestId = await askByName(session, 'GATED_DENY');
    expect((await http('POST', `/api/vault/requests/${requestId}/deny`)).statusCode).toBe(204);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(refusal(await resolve(session, ['GATED_DENY']))).toEqual([
        403,
        { code: 'VAULT_USE_DENIED', names: ['GATED_DENY'] },
      ]);
    }
    expect(await pending()).toEqual([]);

    const reAsked = await app.get(McpService).handleToolCall('devchain_vault_request', {
      sessionId: session.slice(0, 8),
      name: 'GATED_DENY',
      description: 'I need it for the release',
    });
    toolResults.push(reAsked);
    expect(reAsked).toMatchObject({ success: true, data: { status: 'pending', type: 'use' } });
    const reopened = (reAsked.data as { requestId: string }).requestId;
    expect((await approve(reopened, 'session')).statusCode).toBe(200);
    expect(await envOf(session, 'GATED_DENY')).toBe(FOR_DENY);
  });

  it('6. a session approval ends with the session', async () => {
    const approvals = app.get(VaultUseApprovalStore);
    expect(approvals.hasSessionApproval(session, ids.session)).toBe(true);

    expect((await http('DELETE', `/api/sessions/${session}`)).statusCode).toBeLessThan(300);
    await new Promise((settle) => setTimeout(settle, 0));

    expect(approvals.hasSessionApproval(session, ids.session)).toBe(false);
  });

  it('7. keeps every value out of REST bodies other than resolve, tools, logs, events and the DB', () => {
    expect(otherBodies.length).toBeGreaterThan(20);
    expectNoCanaries(
      {
        restBodies: otherBodies,
        tools: toolResults,
        logs: mockLogLines,
        events,
        db: dumpDatabase(sqlite),
        deliveredText: terminalIO.deliver.mock.calls,
      },
      ALL_CANARIES,
    );
  });
});
