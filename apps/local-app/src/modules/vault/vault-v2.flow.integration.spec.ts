/**
 * Vault v2 end to end on home: access → launch without values → resolve → revoke and
 * rotate without a restart → agent requests → no value outside the resolve response.
 * Test layer: app integration. Each step has its own spec; only the whole app shows
 * that the launch pipeline, the resolve route, the access layer and the request flow
 * hold together. Terminal IO, the PTY and processes are the stubbed edges.
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../../app.module';
import { resetEnvConfig } from '../../common/config/env.config';
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
import { vaultInstructionBlock } from './vault-instructions';
import { VAULT_KEYSTORE, VaultKeystoreUnavailableError } from './vault-keystore';
import { VaultSessionValueStore } from './vault-session-values';

const SECRET_A = 'canary-e2e-secret-4d1a';
const KEY_B = '-----BEGIN KEY-----\ncanary-e2e-file-8b2c\n';
const ROTATED_A = 'canary-e2e-rotated-0f7e';
const SESSION_ONLY = 'canary-e2e-session-6a93';
const ALL_CANARIES = canaryForms([SECRET_A, 'canary-e2e-file-8b2c', ROTATED_A, SESSION_ONLY]);

const PROJECT = randomUUID();
const AGENT = randomUUID();
const ISOLATED_ENV = [
  'HOME',
  'DB_PATH',
  'DB_FILENAME',
  'SKIP_PREFLIGHT',
  'PROVIDER_CLI_CHECKS_ENABLED',
  'DEVCHAIN_HOST_ETC_DIR',
  'RUNTIME_DIRECTORY',
];

describe('Vault v2 end to end', () => {
  let app: NestFastifyApplication;
  let sqlite: Database.Database;
  let root: string;
  let sessionId: string;
  let ids: { secret: string; file: string; shared: string };
  const savedEnv = new Map(ISOLATED_ENV.map((key) => [key, process.env[key]]));
  const events: unknown[] = [];
  /** Every REST response body except the resolve route's, the one value-returning route. */
  const otherBodies: Array<{ url: string; body: string }> = [];
  const terminalIO = {
    createEmptySession: jest.fn().mockResolvedValue({ name: 'tmux-e2e' }),
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
    if (url !== '/api/vault/sessions/resolve') otherBodies.push({ url, body: response.body });
    return response;
  }
  const resolveValues = (names?: string[]) =>
    http('POST', '/api/vault/sessions/resolve', { sessionId, ...(names && { names }) });
  const tool = (name: string, params: Record<string, unknown>) =>
    app.get(McpService).handleToolCall(name, { sessionId: sessionId.slice(0, 8), ...params });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-e2e-'));
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
       VALUES ('p-coder', ?, 'Coder', 'coder', 'T', 'T'), ('p-reviewer', ?, 'Reviewer', 'reviewer', 'T', 'T')`,
      PROJECT,
      PROJECT,
    );
    insert(`INSERT INTO profile_provider_configs
              (id, profile_id, provider_id, name, position, created_at, updated_at)
            VALUES ('c-coder', 'p-coder', 'prov', 'default', 0, 'T', 'T')`);
    insert(
      `INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
       VALUES (?, ?, 'p-coder', 'c-coder', 'Coder', 'T', 'T')`,
      AGENT,
      PROJECT,
    );
    insert(
      `INSERT INTO prompts (id, project_id, title, content, created_at, updated_at)
       VALUES ('prompt-init', ?, 'Initialize Agent', 'You are {agent_name}.', 'T', 'T')`,
      PROJECT,
    );
    insert(`INSERT INTO settings (id, key, value, created_at, updated_at)
            VALUES ('s-init', 'initialSessionPromptId', 'prompt-init', 'T', 'T')`);

    expect((await http('POST', '/api/vault/setup', { mode: 'recovery' })).statusCode).toBe(200);
    const coders = [{ projectId: PROJECT, mode: 'families', familySlugs: ['coder'] }];
    const create = async (body: object) => {
      const response = await http('POST', '/api/vault/entries', body);
      expect(response.statusCode).toBe(201);
      return response.json().id as string;
    };
    ids = {
      secret: await create({
        projects: coders,
        name: 'SECRET_A',
        kind: 'secret',
        description: 'API secret',
        value: SECRET_A,
      }),
      file: await create({
        projects: coders,
        name: 'KEY_B',
        kind: 'file',
        description: 'Deploy key',
        value: KEY_B,
      }),
      shared: await create({
        projects: [{ projectId: PROJECT, mode: 'families', familySlugs: ['reviewer'] }],
        name: 'SHARED_C',
        kind: 'secret',
        description: 'Reviewer token',
        value: 'canary-e2e-shared-31d7',
      }),
    };
    const access = await http('PUT', `/api/vault/projects/${PROJECT}/grants`, {
      entries: [],
      access: { mode: 'families', familySlugs: ['coder'] },
    });
    expect(access.statusCode).toBe(200);
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

  it('1. launches an agent of the family with no value in the launch, and the Vault block in its prompt', async () => {
    const launched = await http('POST', '/api/sessions/launch', {
      projectId: PROJECT,
      agentId: AGENT,
    });
    expect(launched.statusCode).toBe(201);
    sessionId = launched.json().id;

    const [, typedArgs] = terminalIO.typeCommand.mock.calls[0] as [unknown, string[]];
    const script = readFileSync(typedArgs[1], 'utf8');
    expect(script).toContain(`DEVCHAIN_SESSION_ID=${sessionId}`);
    expect(script).not.toMatch(/SECRET_A|KEY_B/);
    expectNoCanaries({ launchScript: script }, ALL_CANARIES);
    const prompt = terminalIO.deliver.mock.calls[0][1] as string;
    expect(prompt).toBe(`You are Coder.\n\n${vaultInstructionBlock(2)}`);
  }, 30_000);

  it('2. resolves the values for the session, and a narrower resolve keeps the earlier file', async () => {
    const full = await resolveValues();
    expect(full.statusCode).toBe(200);
    const { env, files } = full.json() as {
      env: Record<string, string>;
      files: Record<string, string>;
    };
    expect(env).toEqual({ SECRET_A });
    expect(Object.keys(files)).toEqual(['KEY_B']);
    expect(readFileSync(files.KEY_B, 'utf8')).toBe(KEY_B);
    expect(statSync(files.KEY_B).mode & 0o777).toBe(0o600);
    const used = sqlite
      .prepare('SELECT id FROM vault_entries WHERE last_used_at IS NOT NULL ORDER BY name')
      .all();
    expect(used).toEqual(expect.arrayContaining([{ id: ids.secret }, { id: ids.file }]));

    const narrow = await resolveValues(['SECRET_A']);
    expect(narrow.json()).toEqual({ env: { SECRET_A }, files: {}, needsApproval: [] });
    expect(readFileSync(files.KEY_B, 'utf8')).toBe(KEY_B);
  });

  it('3. refuses after access is revoked, then serves a replaced value with no restart', async () => {
    await http('PUT', `/api/vault/projects/${PROJECT}/grants`, {
      entries: [],
      access: { mode: 'none' },
    });
    const refused = await resolveValues(['SECRET_A']);
    expect([refused.statusCode, refused.json().details]).toEqual([
      403,
      { code: 'VAULT_NOT_ENABLED' },
    ]);

    await http('PUT', `/api/vault/projects/${PROJECT}/grants`, {
      entries: [],
      access: { mode: 'families', familySlugs: ['coder'] },
    });
    const replaced = await http('PUT', `/api/vault/entries/${ids.secret}/value`, {
      value: ROTATED_A,
    });
    expect(replaced.statusCode).toBe(200);

    expect((await resolveValues(['SECRET_A'])).json().env).toEqual({ SECRET_A: ROTATED_A });
    expect(terminalIO.typeCommand).toHaveBeenCalledTimes(1);
  });

  it('4. fulfils agent requests: a session-only value until the session stops, and an added grant', async () => {
    const created = await tool('devchain_vault_request', {
      name: 'NEW_TOKEN',
      description: 'Token for the deploy',
    });
    expect(created).toMatchObject({ success: true, data: { status: 'pending' } });
    const createId = (created.data as { requestId: string }).requestId;
    const fulfilled = await http('POST', `/api/vault/requests/${createId}/fulfill`, {
      value: SESSION_ONLY,
      permanent: false,
    });
    expect(fulfilled.statusCode).toBe(200);
    expect((await resolveValues(['NEW_TOKEN'])).json().env).toEqual({ NEW_TOKEN: SESSION_ONLY });
    const listed = await tool('devchain_vault_list', {});
    expect((listed.data as { entries: Array<{ name: string }> }).entries).toContainEqual(
      expect.objectContaining({ name: 'NEW_TOKEN', status: 'available' }),
    );

    const grant = await tool('devchain_vault_request', {
      name: 'SHARED_C',
      description: 'Need the reviewer token',
    });
    const grantId = (grant.data as { requestId: string }).requestId;
    expect(
      (await http('POST', `/api/vault/requests/${grantId}/fulfill`, { permanent: true }))
        .statusCode,
    ).toBe(200);
    const grants = await http('GET', `/api/vault/grants?projectId=${PROJECT}`);
    expect(
      (grants.json() as Array<{ entryId: string; familySlug: string }>)
        .filter((row) => row.entryId === ids.shared)
        .map((row) => row.familySlug)
        .sort(),
    ).toEqual(['coder', 'reviewer']);

    expect((await http('DELETE', `/api/sessions/${sessionId}`)).statusCode).toBeLessThan(300);
    await new Promise((settle) => setTimeout(settle, 0));
    expect(app.get(VaultSessionValueStore).valuesFor(sessionId)).toEqual([]);
  });

  it('5. keeps every value out of REST bodies other than resolve, logs, events and the DB', () => {
    expect(otherBodies.length).toBeGreaterThan(10);
    expectNoCanaries(
      {
        restBodies: otherBodies,
        logs: mockLogLines,
        events,
        db: dumpDatabase(sqlite),
        typedCommands: terminalIO.typeCommand.mock.calls,
        deliveredText: terminalIO.deliver.mock.calls,
      },
      ALL_CANARIES,
    );
  });
});
