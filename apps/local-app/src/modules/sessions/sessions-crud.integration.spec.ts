/**
 * Integration tests for PATCH /api/sessions/:id (rename) and
 * DELETE /api/sessions/:id/record (hard delete).
 *
 * Uses the same NestJS + temp SQLite pattern as sessions-history.integration.spec.ts.
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
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';

jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

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

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'devchain-sessions-rename-'));
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
    Object.assign(process.env, originalEnv);
    resetEnvConfig();
  });

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

  it('clears name when null is sent', async () => {
    const projectId = uuid(1);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId, name: 'Old Name' });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        payload: { projectId, name: null },
      });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.name).toBeNull();

    const row = sqlite!.prepare('SELECT name FROM sessions WHERE id = ?').get(sessionId) as {
      name: string | null;
    };
    expect(row.name).toBeNull();
  });

  it('trims whitespace and stores NULL for whitespace-only name', async () => {
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
        payload: { projectId, name: '   ' },
      });

    expect(res.statusCode).toBe(200);
    const row = sqlite!.prepare('SELECT name FROM sessions WHERE id = ?').get(sessionId) as {
      name: string | null;
    };
    expect(row.name).toBeNull();
  });

  it('returns 400 for name exceeding 120 characters', async () => {
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
        payload: { projectId, name: 'x'.repeat(121) },
      });

    expect(res.statusCode).toBe(400);
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

  it('returns 400 when projectId is missing', async () => {
    const sessionId = uuid(100);

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'PATCH',
        url: `/api/sessions/${sessionId}`,
        payload: { name: 'Test' },
      });

    expect(res.statusCode).toBe(400);
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

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'devchain-sessions-delete-'));
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
    Object.assign(process.env, originalEnv);
    resetEnvConfig();
  });

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

  it('deletes a failed session record', async () => {
    const projectId = uuid(1);
    const agentId = uuid(10);
    const sessionId = uuid(100);
    seedAgent(sqlite!, { projectId, agentId });
    seedSession(sqlite!, { sessionId, agentId, status: 'failed' });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/record?projectId=${projectId}`,
      });

    expect(res.statusCode).toBe(200);
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

  it('returns 404 for non-existent session', async () => {
    const projectId = uuid(1);
    const sessionId = uuid(999);

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'DELETE',
        url: `/api/sessions/${sessionId}/record?projectId=${projectId}`,
      });

    expect(res.statusCode).toBe(404);
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

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'devchain-sessions-mapper-'));
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
    Object.assign(process.env, originalEnv);
    resetEnvConfig();
  });

  const mappers = [
    { name: 'getSession', method: 'GET', url: (id: string) => `/api/sessions/${id}` },
    {
      name: 'getAgentSessionHistory',
      method: 'GET',
      url: (_id: string) => `/api/sessions/agents/${uuid(10)}/history?projectId=${uuid(1)}`,
    },
  ];

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
