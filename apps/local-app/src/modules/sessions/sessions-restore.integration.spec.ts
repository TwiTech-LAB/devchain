/**
 * Integration tests for POST /api/sessions/:id/restore.
 * Boots a real NestJS app with a temp SQLite DB; mocks TerminalIOService and PtyService
 * so no actual processes are spawned.
 */
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { MainAppModule } from '../../app.main.module';
import { resetEnvConfig } from '../../common/config/env.config';
import { ORCHESTRATOR_DB_CONNECTION } from '../orchestrator/orchestrator-storage/db/orchestrator.provider';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import { TerminalIOService } from '../terminal/services/terminal-io/terminal-io.service';
import { PtyService } from '../terminal/services/pty.service';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';

jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const NOW = '2026-01-01T00:00:00.000Z';

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
}

interface SeedAgentOpts {
  projectId: string;
  agentId: string;
  providerName?: string;
  binPath?: string;
}

function seedAgent(
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

function seedSession(
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
  const originalEnv = {
    DEVCHAIN_MODE: process.env.DEVCHAIN_MODE,
    DATABASE_URL: process.env.DATABASE_URL,
    REPO_ROOT: process.env.REPO_ROOT,
    DB_PATH: process.env.DB_PATH,
    DB_FILENAME: process.env.DB_FILENAME,
    TEMPLATES_DIR: process.env.TEMPLATES_DIR,
  };

  let app: NestFastifyApplication | null = null;
  let moduleRef: TestingModule | null = null;
  let dbDir: string | null = null;
  let sqlite: Database.Database | null = null;

  const mockTerminalIO = {
    createEmptySession: jest.fn().mockResolvedValue({ name: 'tmux-session' }),
    disableAlternateScreen: jest.fn().mockResolvedValue(undefined),
    destroySession: jest.fn().mockResolvedValue(undefined),
    typeCommand: jest.fn().mockResolvedValue(undefined),
    waitForOutput: jest.fn().mockResolvedValue(true),
    sessionExists: jest.fn().mockResolvedValue(false),
    startHealthCheck: jest.fn(),
    deliver: jest.fn().mockResolvedValue({ confirmed: true, method: 'bracketed-paste' }),
    deliverImmediate: jest.fn().mockResolvedValue({ confirmed: true, method: 'bracketed-paste' }),
    sendControl: jest.fn().mockResolvedValue(undefined),
  };
  const mockPty = { startStreaming: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();

    dbDir = await mkdtemp(join(tmpdir(), 'devchain-restore-'));
    process.env.DEVCHAIN_MODE = 'main';
    process.env.DATABASE_URL = 'postgres://devchain:devchain@127.0.0.1:5432/devchain_test';
    process.env.REPO_ROOT = process.cwd();
    process.env.DB_PATH = dbDir;
    process.env.DB_FILENAME = 'test.db';
    resetEnvConfig();

    moduleRef = await Test.createTestingModule({
      imports: [MainAppModule],
    })
      .overrideProvider(ORCHESTRATOR_DB_CONNECTION)
      .useValue({})
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

    const db = moduleRef.get<BetterSQLite3Database>(DB_CONNECTION);
    sqlite = getRawSqliteClient(db);
  });

  afterEach(async () => {
    sqlite = null;
    if (app) {
      await app.close();
      app = null;
    }
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = null;
    }
    if (dbDir) {
      await rm(dbDir, { recursive: true, force: true });
      dbDir = null;
    }
    process.env.DEVCHAIN_MODE = originalEnv.DEVCHAIN_MODE;
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    process.env.REPO_ROOT = originalEnv.REPO_ROOT;
    process.env.DB_PATH = originalEnv.DB_PATH;
    process.env.DB_FILENAME = originalEnv.DB_FILENAME;
    process.env.TEMPLATES_DIR = originalEnv.TEMPLATES_DIR;
    resetEnvConfig();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Authorization / validation
  // ──────────────────────────────────────────────────────────────────────────

  it('returns 400 when body is missing projectId', async () => {
    const res = await app!.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/sessions/nonexistent-id/restore',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

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
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId });

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

    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId, status: 'running' });

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

  it('returns 409 NO_PROVIDER_SESSION_ID when provider_session_id is null', async () => {
    const projectId = uuid(4);
    const agentId = uuid(30);
    const sessionId = uuid(300);

    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId, providerSessionId: null });

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
    expect(body.details?.code).toBe('NO_PROVIDER_SESSION_ID');
  });

  it('returns 409 PROVIDER_MISMATCH when launch-time provider differs from current', async () => {
    const projectId = uuid(5);
    const agentId = uuid(40);
    const sessionId = uuid(400);

    // Agent's current provider is 'claude'; session was launched with 'codex'
    seedAgent(sqlite!, { projectId, agentId, providerName: 'claude' });
    seedSession(sqlite!, { sessionId, agentId, providerNameAtLaunch: 'codex' });

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

    seedAgent(sqlite!, { projectId, agentId, providerName: 'claude' });
    seedSession(sqlite!, {
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

    seedAgent(sqlite!, { projectId, agentId, providerName: 'claude' });
    seedSession(sqlite!, {
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

    seedAgent(sqlite!, { projectId, agentId, providerName: 'claude' });
    seedSession(sqlite!, { sessionId, agentId });

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
    expect(mockTerminalIO.destroySession).toHaveBeenCalledTimes(1);
  });

  it('event emission: session.restored published; session.started NOT published', async () => {
    const projectId = uuid(9);
    const agentId = uuid(80);
    const sessionId = uuid(800);

    seedAgent(sqlite!, { projectId, agentId, providerName: 'claude' });
    seedSession(sqlite!, { sessionId, agentId });

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
