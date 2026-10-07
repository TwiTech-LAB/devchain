/**
 * Integration tests for GET /api/sessions/agents/:agentId/history.
 * Bootstraps a real NestJS app with a temp SQLite database and seeds data
 * via raw SQL to avoid dependency on the full service layer.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises';
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
    const transcriptFile = join(rootDir, 'session.jsonl');
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
