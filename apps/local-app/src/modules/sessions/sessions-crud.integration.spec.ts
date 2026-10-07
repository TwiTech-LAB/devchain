/**
 * Integration tests for session rename, record deletion, history mapping, and restore.
 *
 * Boots one real NestJS app from the migrated SQLite snapshot for the file.
 */
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../app.module';
import { resetEnvConfig } from '../../common/config/env.config';
import { DB_CONNECTION } from '../storage/db/db.provider';
import type Database from 'better-sqlite3';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { applyExternalBoundaryMocks } from '../../common/test/app-bootstrap.helper';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { SettingsService } from '../settings/services/settings.service';
import { PROVIDER_CLI_INSTALL_ROOT } from '../providers/services/provider-cli-install-state.service';
import { ProviderAdapterFactory } from '../providers/adapters';
import { TerminalIOService } from '../terminal/services/terminal-io/terminal-io.service';
import { PtyService } from '../terminal/services/pty.service';
import { TerminalSessionRegistry } from '../terminal/services/terminal-session/terminal-session-registry';

jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// Reuse the app while clearing fixture domain rows between cases.
let app: NestFastifyApplication;
let sqlite: Database.Database;
let rootDir: string;
const isolatedEnv = [
  'HOME',
  'DB_PATH',
  'DB_FILENAME',
  'DATABASE_URL',
  'TEMPLATES_DIR',
  'SKIP_PREFLIGHT',
  'PROVIDER_CLI_CHECKS_ENABLED',
  'DEVCHAIN_HOST_ETC_DIR',
];
const savedEnv = new Map(isolatedEnv.map((key) => [key, process.env[key]]));
const mockTerminalIO = {
  createEmptySession: jest.fn().mockResolvedValue({ name: 'tmux-session' }),
  setAlternateScreen: jest.fn().mockResolvedValue(undefined),
  destroySession: jest.fn().mockResolvedValue(undefined),
  destroyExpectedSession: jest.fn().mockResolvedValue({ outcome: 'destroyed' }),
  typeCommand: jest.fn().mockResolvedValue(undefined),
  waitForOutput: jest.fn().mockResolvedValue(true),
  sessionExists: jest.fn().mockResolvedValue(false),
  listAllSessionNames: jest.fn().mockResolvedValue(new Set()),
  startHealthCheck: jest.fn(),
  deliver: jest.fn().mockResolvedValue({ confirmed: true, method: 'bracketed-paste' }),
  deliverImmediate: jest.fn().mockResolvedValue({ confirmed: true, method: 'bracketed-paste' }),
  sendControl: jest.fn().mockResolvedValue(undefined),
};
const mockPty = {
  setOutputHandler: jest.fn(),
  startStreaming: jest.fn().mockResolvedValue(undefined),
  stopStreaming: jest.fn(),
};
beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'devchain-session-http-'));
  Object.assign(process.env, {
    HOME: rootDir,
    DB_PATH: rootDir,
    DB_FILENAME: 'test.db',
    SKIP_PREFLIGHT: '1',
    PROVIDER_CLI_CHECKS_ENABLED: 'false',
    DEVCHAIN_HOST_ETC_DIR: join(rootDir, 'etc'),
  });
  resetEnvConfig();
  const fixture = createTestDatabase();
  sqlite = fixture.sqlite;
  const settings = new SettingsService(fixture.db, new EventEmitter2());
  await settings.updateSettings({
    registry: { cacheDir: join(rootDir, 'registry'), checkUpdatesOnStartup: false },
    skills: { syncOnStartup: false },
  });
  const moduleRef = await applyExternalBoundaryMocks(
    Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DB_CONNECTION)
      .useValue(fixture.db),
  )
    .overrideProvider(ProviderAdapterFactory)
    .useClass(ProviderAdapterFactory)
    .overrideProvider(PROVIDER_CLI_INSTALL_ROOT)
    .useValue(join(rootDir, 'provider-clis'))
    .overrideProvider(TerminalIOService)
    .useValue(mockTerminalIO)
    .overrideProvider(PtyService)
    .useValue(mockPty)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
beforeEach(() => {
  jest.clearAllMocks();
  const registry = app.get(TerminalSessionRegistry);
  for (const sessionId of registry.list()) registry.dispose(sessionId);
  sqlite.transaction(() => {
    for (const table of [
      'chat_thread_session_invites',
      'chat_threads',
      'sessions',
      'agents',
      'projects',
      'profile_provider_configs',
      'agent_profiles',
      'providers',
    ])
      sqlite.prepare('DELETE FROM ' + table).run();
  })();
});
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
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  }
});

const NOW = '2026-01-01T00:00:00.000Z';

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
}

function seedAgent(sqlite: Database.Database, opts: { projectId: string; agentId: string }): void {
  const { projectId, agentId } = opts;
  const profileId = uuid(900);
  const providerId = uuid(901);
  const ppcId = uuid(902);

  sqlite
    .prepare(
      `INSERT INTO projects (id, name, root_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(projectId, 'Test Project', '/tmp/test', NOW, NOW);

  sqlite
    .prepare(
      `INSERT INTO providers (id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(providerId, 'claude', NOW, NOW);

  sqlite
    .prepare(
      `INSERT INTO agent_profiles (id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(profileId, 'Test Profile', NOW, NOW);

  sqlite
    .prepare(
      `INSERT INTO profile_provider_configs (id, profile_id, provider_id, name, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ppcId, profileId, providerId, 'default', 0, NOW, NOW);

  sqlite
    .prepare(
      `INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(agentId, projectId, profileId, ppcId, 'Test Agent', NOW, NOW);
}

function seedSession(
  sqlite: Database.Database,
  opts: { sessionId: string; agentId: string; status?: string; name?: string | null },
): void {
  const { sessionId, agentId, status = 'stopped', name = null } = opts;
  sqlite
    .prepare(
      `INSERT INTO sessions (id, agent_id, status, started_at, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, agentId, status, NOW, name, NOW, NOW);
}

describe('PATCH /api/sessions/:id (rename)', () => {
  it('sets name on a session and returns updated DTO', async () => {
    const projectId = uuid(1);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        payload: { projectId, name: 'My Session' },
      });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.name).toBe('My Session');

    const row = sqlite!.prepare('SELECT name FROM sessions WHERE id = ?').get(sessionId) as {
      name: string | null;
    };
    expect(row.name).toBe('My Session');
  });

  it('returns 403 for cross-project request', async () => {
    const projectId = uuid(1);
    const otherProjectId = uuid(2);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        payload: { projectId: otherProjectId, name: 'Hacked' },
      });

    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for non-existent session', async () => {
    const projectId = uuid(1);
    const sessionId = uuid(999);

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        payload: { projectId, name: 'Test' },
      });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/sessions/:id/record (hard delete)', () => {
  it('deletes a stopped session record', async () => {
    const projectId = uuid(1);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId, status: 'stopped' });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/record?projectId=${projectId}`,
      });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.deleted).toBe(true);

    const row = sqlite!.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    expect(row).toBeUndefined();
  });

  it('returns 409 for running session', async () => {
    const projectId = uuid(1);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId, status: 'running' });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/record?projectId=${projectId}`,
      });

    expect(res.statusCode).toBe(409);
    const row = sqlite!.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    expect(row).toBeDefined();
  });

  it('returns 403 for cross-project request', async () => {
    const projectId = uuid(1);
    const otherProjectId = uuid(2);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/record?projectId=${otherProjectId}`,
      });

    expect(res.statusCode).toBe(403);
    const row = sqlite!.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    expect(row).toBeDefined();
  });

  it('cascades: deletes associated transcripts rows', async () => {
    const projectId = uuid(1);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    const transcriptId = uuid(200);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId });

    sqlite!
      .prepare(
        `INSERT INTO transcripts (id, session_id, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(transcriptId, sessionId, 'test content', NOW, NOW);

    const beforeTranscript = sqlite!
      .prepare('SELECT * FROM transcripts WHERE id = ?')
      .get(transcriptId);
    expect(beforeTranscript).toBeDefined();

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/record?projectId=${projectId}`,
      });

    expect(res.statusCode).toBe(200);
    const afterTranscript = sqlite!
      .prepare('SELECT * FROM transcripts WHERE id = ?')
      .get(transcriptId);
    expect(afterTranscript).toBeUndefined();
  });

  it('cascades: deletes chat_thread_session_invites rows via explicit cleanup', async () => {
    const projectId = uuid(1);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    const inviteId = uuid(300);
    const threadId = uuid(400);
    const messageId = uuid(500);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId });

    sqlite!
      .prepare(
        `INSERT INTO chat_threads (id, project_id, created_by_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(threadId, projectId, 'system', NOW, NOW);

    sqlite!
      .prepare(
        `INSERT INTO chat_messages (id, thread_id, author_type, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(messageId, threadId, 'system', 'test', NOW);

    sqlite!
      .prepare(
        `INSERT INTO chat_thread_session_invites (id, thread_id, agent_id, session_id, invite_message_id, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(inviteId, threadId, agentId, sessionId, messageId, NOW);

    const beforeInvite = sqlite!
      .prepare('SELECT * FROM chat_thread_session_invites WHERE id = ?')
      .get(inviteId);
    expect(beforeInvite).toBeDefined();

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/record?projectId=${projectId}`,
      });

    expect(res.statusCode).toBe(200);
    const afterInvite = sqlite!
      .prepare('SELECT * FROM chat_thread_session_invites WHERE id = ?')
      .get(inviteId);
    expect(afterInvite).toBeUndefined();
  });
});

describe('SELECT mapper coverage: name field', () => {
  const mappers = [
    { name: 'getSession', method: 'GET', url: (id: string) => `/api/sessions/${id}` },
    {
      name: 'getAgentSessionHistory',
      method: 'GET',
      url: (_id: string) => `/api/sessions/agents/${uuid(10)}/history?projectId=${uuid(1)}`,
    },
  ] as const;

  it.each(mappers)('$name returns the name field', async ({ name, method, url }) => {
    const projectId = uuid(1);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId, name: 'Test Name' });

    const targetUrl =
      name === 'getAgentSessionHistory'
        ? `/api/sessions/agents/${agentId}/history?projectId=${projectId}`
        : url(sessionId);

    const res = await app!.getHttpAdapter().getInstance().inject({ method, url: targetUrl });
    expect(res.statusCode).toBe(200);

    if (name === 'getAgentSessionHistory') {
      const payload = JSON.parse(res.payload);
      const item = payload.items.find((i: { id: string }) => i.id === sessionId);
      expect(item).toBeDefined();
      expect(item.name).toBe('Test Name');
    } else {
      const body = JSON.parse(res.payload);
      expect(body.name).toBe('Test Name');
    }
  });

  it('getAgentSessionHistory includes name=null for unnamed sessions', async () => {
    const projectId = uuid(1);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId, name: null });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/api/sessions/agents/${agentId}/history?projectId=${projectId}`,
      });

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(res.payload);
    const item = payload.items.find((i: { id: string }) => i.id === sessionId);
    expect(item).toBeDefined();
    expect(item.name).toBeNull();
  });
});

interface SeedAgentOpts {
  projectId: string;
  agentId: string;
  providerName?: string;
  binPath?: string;
}
function seedRestoreAgent(
  sqlite: Database.Database,
  { projectId, agentId, providerName = 'claude', binPath = '/usr/bin/claude' }: SeedAgentOpts,
): { providerId: string; profileId: string; ppcId: string } {
  const profileId = uuid(900);
  const providerId = uuid(901);
  const ppcId = uuid(902);

  sqlite
    .prepare(
      `INSERT INTO projects (id, name, root_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(projectId, 'Test Project', '/tmp/test', NOW, NOW);

  sqlite
    .prepare(
      `INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(providerId, providerName, binPath, 1, NOW, NOW);

  sqlite
    .prepare(
      `INSERT INTO agent_profiles (id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(profileId, 'Test Profile', NOW, NOW);

  sqlite
    .prepare(
      `INSERT INTO profile_provider_configs (id, profile_id, provider_id, name, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ppcId, profileId, providerId, 'default', 0, NOW, NOW);

  sqlite
    .prepare(
      `INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(agentId, projectId, profileId, ppcId, 'Test Agent', NOW, NOW);

  return { providerId, profileId, ppcId };
}
interface SeedSessionOpts {
  sessionId: string;
  agentId: string;
  status?: string;
  providerSessionId?: string | null;
  providerNameAtLaunch?: string | null;
  startedAt?: string;
}
function seedRestoreSession(
  sqlite: Database.Database,
  {
    sessionId,
    agentId,
    status = 'stopped',
    providerSessionId = 'prov-session-abc',
    providerNameAtLaunch = 'claude',
    startedAt = '2026-04-30T10:00:00.000Z',
  }: SeedSessionOpts,
): void {
  sqlite
    .prepare(
      `INSERT INTO sessions
         (id, agent_id, status, provider_session_id, provider_name_at_launch,
          started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, agentId, status, providerSessionId, providerNameAtLaunch, startedAt, NOW, NOW);
}
describe('POST /api/sessions/:id/restore', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Authorization / validation
  // ──────────────────────────────────────────────────────────────────────────

  it('returns 404 when session does not exist', async () => {
    const projectId = uuid(1);
    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/sessions/${uuid(99)}/restore`,
        payload: { projectId },
      });
    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when agent belongs to a different project', async () => {
    const projectId = uuid(1);
    const otherProjectId = uuid(2);
    const agentId = uuid(10);
    const sessionId = uuid(100);

    // Seed agent under projectId but request with otherProjectId
    seedRestoreAgent(sqlite!, { projectId, agentId });
    seedRestoreSession(sqlite!, { sessionId, agentId });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/restore`,
        payload: { projectId: otherProjectId },
      });
    expect(res.statusCode).toBe(403);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // State guard 409s
  // ──────────────────────────────────────────────────────────────────────────

  it('returns 409 INVALID_SESSION_STATE when session is running', async () => {
    const projectId = uuid(3);
    const agentId = uuid(20);
    const sessionId = uuid(200);

    seedRestoreAgent(sqlite!, { projectId, agentId });
    seedRestoreSession(sqlite!, { sessionId, agentId, status: 'running' });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/restore`,
        payload: { projectId },
      });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload) as { message: string; details?: { code?: string } };
    expect(body.details?.code).toBe('INVALID_SESSION_STATE');
  });

  it('returns 409 PROVIDER_MISMATCH when launch-time provider differs from current', async () => {
    const projectId = uuid(5);
    const agentId = uuid(40);
    const sessionId = uuid(400);

    // Agent's current provider is 'claude'; session was launched with 'codex'
    seedRestoreAgent(sqlite!, { projectId, agentId, providerName: 'claude' });
    seedRestoreSession(sqlite!, { sessionId, agentId, providerNameAtLaunch: 'codex' });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/restore`,
        payload: { projectId },
      });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload) as { message: string; details?: { code?: string } };
    expect(body.details?.code).toBe('PROVIDER_MISMATCH');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Success path
  // ──────────────────────────────────────────────────────────────────────────

  it('returns 200 with same id, status=running, preserved started_at', async () => {
    const projectId = uuid(6);
    const agentId = uuid(50);
    const sessionId = uuid(500);
    const originalStartedAt = '2026-04-30T08:00:00.000Z';

    seedRestoreAgent(sqlite!, { projectId, agentId, providerName: 'claude' });
    seedRestoreSession(sqlite!, {
      sessionId,
      agentId,
      providerSessionId: 'claude-prov-abc',
      providerNameAtLaunch: 'claude',
      startedAt: originalStartedAt,
    });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/restore`,
        payload: { projectId },
      });

    expect(res.statusCode).toBe(201);
    type Body = { id: string; status: string; startedAt: string; endedAt: string | null };
    const body = JSON.parse(res.payload) as Body;
    // (a) same session id preserved
    expect(body.id).toBe(sessionId);
    // (b) status flipped to running
    expect(body.status).toBe('running');
    // (c) started_at preserved (not overwritten)
    expect(body.startedAt).toBe(originalStartedAt);
    // (d) endedAt cleared
    expect(body.endedAt).toBeNull();

    // (e) DB row updated
    const row = sqlite!
      .prepare('SELECT status, ended_at, started_at FROM sessions WHERE id = ?')
      .get(sessionId) as { status: string; ended_at: string | null; started_at: string };
    expect(row.status).toBe('running');
    expect(row.ended_at).toBeNull();
    expect(row.started_at).toBe(originalStartedAt);

    // (f) tmux session created
    expect(mockTerminalIO.createEmptySession).toHaveBeenCalledTimes(1);
    // (g) CLI command sent
    expect(mockTerminalIO.typeCommand).toHaveBeenCalledTimes(1);
    // (h) NO deliver (no initial prompt on restore)
    expect(mockTerminalIO.deliver).not.toHaveBeenCalled();
  });

  it('CLI command includes --resume flag with providerSessionId (Claude adapter)', async () => {
    const projectId = uuid(7);
    const agentId = uuid(60);
    const sessionId = uuid(600);

    seedRestoreAgent(sqlite!, { projectId, agentId, providerName: 'claude' });
    seedRestoreSession(sqlite!, {
      sessionId,
      agentId,
      providerSessionId: 'prov-session-XYZ',
      providerNameAtLaunch: 'claude',
    });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/restore`,
        payload: { projectId },
      });
    expect(res.statusCode).toBe(201);

    // typeCommand receives (target, argv) — the full env-prefixed command array
    const [, commandArgs] = mockTerminalIO.typeCommand.mock.calls[0] as [
      { name: string },
      string[],
    ];
    // Should contain --resume and the providerSessionId
    const joined = commandArgs.join(' ');
    expect(joined).toContain('--resume');
    expect(joined).toContain('prov-session-XYZ');
  });

  it('rollback: reverts status to stopped when sendCommandArgs fails', async () => {
    const projectId = uuid(8);
    const agentId = uuid(70);
    const sessionId = uuid(700);

    seedRestoreAgent(sqlite!, { projectId, agentId, providerName: 'claude' });
    seedRestoreSession(sqlite!, { sessionId, agentId });

    mockTerminalIO.typeCommand.mockRejectedValueOnce(new Error('CLI spawn failed'));

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/restore`,
        payload: { projectId },
      });
    expect(res.statusCode).toBe(500);

    // DB row must be rolled back to 'stopped'
    const row = sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as {
      status: string;
    };
    expect(row.status).toBe('stopped');

    // Tmux session must be destroyed
    expect(mockTerminalIO.destroyExpectedSession).toHaveBeenCalledTimes(1);
  });

  it('event emission: session.restored published; session.started NOT published', async () => {
    const projectId = uuid(9);
    const agentId = uuid(80);
    const sessionId = uuid(800);

    seedRestoreAgent(sqlite!, { projectId, agentId, providerName: 'claude' });
    seedRestoreSession(sqlite!, { sessionId, agentId });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/restore`,
        payload: { projectId },
      });
    expect(res.statusCode).toBe(201);

    // Verify events in DB: session.restored must exist; session.started must not
    type EventRow = { name: string };
    const events = sqlite!
      .prepare('SELECT name FROM events ORDER BY published_at')
      .all() as EventRow[];
    const eventNames = events.map((e) => e.name);
    expect(eventNames).toContain('session.restored');
    expect(eventNames).not.toContain('session.started');
  });
});
