/**
 * Integration tests for GET /api/sessions/agents/:agentId/history.
 * Bootstraps a real NestJS app with a temp SQLite database and seeds data
 * via raw SQL to avoid dependency on the full service layer.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises';
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

/** Insert minimal rows required to satisfy FK constraints for an agent. */
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

describe('GET /api/sessions/agents/:agentId/history', () => {
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
    dbDir = await mkdtemp(join(tmpdir(), 'devchain-sessions-history-'));
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
    process.env.DEVCHAIN_MODE = originalEnv.DEVCHAIN_MODE;
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    process.env.REPO_ROOT = originalEnv.REPO_ROOT;
    process.env.DB_PATH = originalEnv.DB_PATH;
    process.env.DB_FILENAME = originalEnv.DB_FILENAME;
    process.env.TEMPLATES_DIR = originalEnv.TEMPLATES_DIR;
    resetEnvConfig();
  });

  // ────────────────────────────────────────────────────────────────
  // Authorization
  // ────────────────────────────────────────────────────────────────

  it('returns 400 when projectId query param is missing', async () => {
    const agentId = uuid(1);
    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/api/sessions/agents/${agentId}/history`,
      });
    expect(res.statusCode).toBe(400);
  });

  it('returns 403 when agent belongs to a different project', async () => {
    const projectId = uuid(1);
    const otherProjectId = uuid(2);
    const agentId = uuid(10);

    // Seed agent under projectId; query with otherProjectId
    seedAgent(sqlite!, { projectId, agentId });

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/api/sessions/agents/${agentId}/history?projectId=${otherProjectId}`,
      });
    expect(res.statusCode).toBe(403);
  });

  // ────────────────────────────────────────────────────────────────
  // Pagination invariants
  // ────────────────────────────────────────────────────────────────

  it('paginates fully: total is stable, cursor advances, no duplicates, nextCursor null on last page', async () => {
    const projectId = uuid(3);
    const agentId = uuid(20);
    seedAgent(sqlite!, { projectId, agentId });

    // Seed 25 stopped sessions with distinct timestamps
    const totalSeeded = 25;
    for (let i = 0; i < totalSeeded; i++) {
      const sessionId = uuid(1000 + i);
      const ts = new Date(2026, 0, 1, 0, i).toISOString();
      sqlite!
        .prepare(
          `INSERT INTO sessions (id, agent_id, status, started_at, last_activity_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, agentId, 'stopped', ts, ts, ts, ts);
    }

    const seenIds = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    let stableTotal: number | null = null;

    // Paginate with limit=10 (default is 20, pass explicit 10)
    while (true) {
      const url = cursor
        ? `/api/sessions/agents/${agentId}/history?projectId=${projectId}&limit=10&cursor=${cursor}`
        : `/api/sessions/agents/${agentId}/history?projectId=${projectId}&limit=10`;

      const res = await app!.getHttpAdapter().getInstance().inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);

      type Payload = {
        items: { id: string }[];
        nextCursor: string | null;
        hasMore: boolean;
        total: number;
      };
      const payload = JSON.parse(res.payload) as Payload;

      // total is stable across all pages
      if (stableTotal === null) {
        stableTotal = payload.total;
      } else {
        expect(payload.total).toBe(stableTotal);
      }

      // No duplicate IDs
      for (const item of payload.items) {
        expect(seenIds.has(item.id)).toBe(false);
        seenIds.add(item.id);
      }

      pageCount++;

      if (!payload.hasMore) {
        expect(payload.nextCursor).toBeNull();
        break;
      }
      cursor = payload.nextCursor!;
    }

    // All seeded sessions must be covered
    expect(seenIds.size).toBe(totalSeeded);
    expect(stableTotal).toBe(totalSeeded);
    // 25 items at 10/page → 3 pages
    expect(pageCount).toBe(3);
  });

  // ────────────────────────────────────────────────────────────────
  // Lazy size backfill
  // ────────────────────────────────────────────────────────────────

  it('backfills size_bytes on first page request and persists to DB', async () => {
    const projectId = uuid(4);
    const agentId = uuid(30);
    seedAgent(sqlite!, { projectId, agentId });

    // Write a real file so stat() succeeds
    const transcriptFile = join(dbDir!, 'session.jsonl');
    await writeFile(transcriptFile, 'test content');

    const sessionId = uuid(2000);
    sqlite!
      .prepare(
        `INSERT INTO sessions (id, agent_id, status, started_at, transcript_path, size_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, agentId, 'stopped', NOW, transcriptFile, null, NOW, NOW);

    // Confirm size_bytes is NULL before the request
    const before = sqlite!
      .prepare('SELECT size_bytes FROM sessions WHERE id = ?')
      .get(sessionId) as { size_bytes: number | null };
    expect(before.size_bytes).toBeNull();

    const res = await app!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/api/sessions/agents/${agentId}/history?projectId=${projectId}`,
      });
    expect(res.statusCode).toBe(200);

    type Payload = { items: { id: string; sizeBytes: number | null }[]; total: number };
    const payload = JSON.parse(res.payload) as Payload;

    const item = payload.items.find((i) => i.id === sessionId);
    expect(item).toBeDefined();
    expect(item!.sizeBytes).toBeGreaterThan(0);

    // DB row should also be updated
    const after = sqlite!
      .prepare('SELECT size_bytes FROM sessions WHERE id = ?')
      .get(sessionId) as { size_bytes: number | null };
    expect(after.size_bytes).toBeGreaterThan(0);
  });
});
