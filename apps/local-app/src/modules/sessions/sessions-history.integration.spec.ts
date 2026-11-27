/**
 * HTTP integration tests for session history, trees and save points.
 * Bootstraps a real NestJS app with a temp SQLite database and seeds data
 * via raw SQL to avoid dependency on the full service layer.
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'fs/promises';
import { delimiter, dirname, join } from 'path';
import { tmpdir } from 'os';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../../app.module';
import { resetEnvConfig } from '../../common/config/env.config';
import { devinTranscriptPath } from '../../common/devin-transcript-paths';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { beforeRollbackRecordId, SessionRowStore } from '../storage/sessions/session-row.store';
import { ProjectWriteGate } from '../storage/write-gate/project-write-gate';
import type Database from 'better-sqlite3';

import { EventEmitter2 } from '@nestjs/event-emitter';
import { applyExternalBoundaryMocks } from '../../common/test/app-bootstrap.helper';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { SettingsService } from '../settings/services/settings.service';
import { MobileChatRpcService } from '../cloud-tunnel/services/mobile-chat-rpc.service';
import { PROVIDER_CLI_INSTALL_ROOT } from '../providers/services/provider-cli-install-state.service';
import { ProviderCliVersionProbe } from '../providers/services/provider-cli-version-probe.service';
import type { CreateSessionSavePointInput } from '../providers/adapters/capabilities/session-fork.capability';
import { ProviderAdapterFactory } from '../providers/adapters';
import type { AntigravityAdapter } from '../providers/adapters/antigravity.adapter';
import { ClaudeAdapter } from '../providers/adapters/claude.adapter';
import {
  PROVIDER_ROOTS,
  TranscriptPathValidator,
} from '../session-reader/services/transcript-path-validator.service';
import { TerminalIOService } from '../terminal/services/terminal-io/terminal-io.service';
import { PtyService } from '../terminal/services/pty.service';
import { TerminalSessionRegistry } from '../terminal/services/terminal-session/terminal-session-registry';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import { ChildProcessExecutor } from '../terminal/services/process-executor/child-process-executor';
import { PreflightService } from '../core/services/preflight.service';
import { SessionsService } from './services/sessions.service';
import { SessionLifecycleFacade } from './services/session-lifecycle-facade.service';
import { SessionSavePointsService } from './services/session-save-points.service';
import { SessionContextResolver } from '../mcp/services/utils/session-context-resolver';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import type {
  SessionHistoryResponseDto,
  SessionTreeNodeDto,
  SessionTreeResponseDto,
} from './dtos/sessions.dto';

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
    .overrideProvider(TranscriptPathValidator)
    .useValue(
      new TranscriptPathValidator({
        ...PROVIDER_ROOTS,
        claude: [join(rootDir, '.claude', 'projects')],
        opencode: [join(rootDir, PROVIDER_ROOTS.opencode[0])],
        agy: [join(rootDir, PROVIDER_ROOTS.agy[0])],
      }),
    )
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
      'team_members',
      'teams',
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
const LATER = '2026-01-01T00:05:00.000Z';

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

  it('paginates ordinary sessions with stable totals while skipping save points', async () => {
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
    const savePointIds = Array.from({ length: 10 }, (_, index) => uuid(2000 + index));
    for (const id of savePointIds) {
      const ts = new Date(2026, 0, 1, 0, 1).toISOString();
      sqlite
        .prepare(
          `INSERT INTO sessions (id, agent_id, parent_session_id, kind, status, started_at,
                                 transcript_path, provider_session_id, created_at, updated_at)
           VALUES (?, ?, ?, 'save_point', 'stopped', ?, '/tmp/saved.jsonl', ?, ?, ?)`,
        )
        .run(id, agentId, uuid(1000), ts, id, ts, ts);
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
        expect(savePointIds).not.toContain(item.id);
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

  it('lists the family of the agent only with scope=family, with the owner on each row', async () => {
    const projectId = uuid(5);
    const agentId = uuid(30);
    const cloneId = uuid(31);
    seedAgent(sqlite, { projectId, agentId });
    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, disabled,
                             created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Clone', 1, ?, ?)`,
      )
      .run(cloneId, projectId, uuid(900), uuid(902), NOW, NOW);
    for (const [id, owner, status] of [
      [uuid(1100), agentId, 'stopped'],
      [uuid(1101), cloneId, 'failed'],
      [uuid(1102), cloneId, 'running'],
    ]) {
      sqlite
        .prepare(
          `INSERT INTO sessions (id, agent_id, status, started_at, last_activity_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, owner, status, NOW, LATER, NOW, NOW);
    }
    const list = async (query: string) => {
      const res = await app
        .getHttpAdapter()
        .getInstance()
        .inject({ url: `/api/sessions/agents/${agentId}/history?projectId=${projectId}${query}` });
      expect(res.statusCode).toBe(200);
      return res.json<SessionHistoryResponseDto>();
    };

    const family = await list('&scope=family&limit=1');
    expect(family).toMatchObject({
      total: 2,
      hasMore: true,
      items: [{ id: uuid(1101), agentId: cloneId, agentName: 'Clone', status: 'failed' }],
    });
    expect(
      (await list(`&scope=family&cursor=${family.nextCursor}`)).items.map(({ id }) => id),
    ).toEqual([uuid(1100)]);
    expect(await list('')).toMatchObject({
      total: 1,
      items: [{ id: uuid(1100), agentId, agentName: 'Test Agent' }],
    });

    // The phone list shares the SQL, so only real rows show what each `family` value exposes.
    const phone = app.get(MobileChatRpcService);
    const phoneRows = async (family?: unknown) =>
      (await phone.listSessions({ agentId, projectId, family })).items.map(
        ({ id, agentId: owner, agentName }) => [id, owner, agentName],
      );
    const own = [uuid(1100), agentId, 'Test Agent'];
    expect(await phoneRows()).toEqual([own]);
    expect(await phoneRows('true')).toEqual([own]);
    expect(await phoneRows(true)).toEqual([[uuid(1101), cloneId, 'Clone'], own]);
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

// Fastify with the migrated SQLite schema verifies HTTP conflicts, real lineage queries and writes.
describe('session save points and tree API', () => {
  const sessionRows = () => sqlite.prepare('SELECT id, agent_id, status FROM sessions').all();
  const sessionStatus = (id: string) =>
    (sqlite.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as { status: string })
      .status;
  const projectId = uuid(41);
  const agentId = uuid(42);
  const sourceId = uuid(43);
  const providerSessionId = uuid(44);
  const providerId = uuid(901);
  const treeUrl = `/api/sessions/agents/${agentId}/tree?projectId=${projectId}`;
  const adapterWithoutFork = { providerName: 'claude', buildLaunchArgs: () => ({ argv: [] }) };

  interface SessionFixture {
    id: string;
    status: SessionTreeNodeDto['status'];
    kind?: SessionTreeNodeDto['kind'];
    parentId?: string;
    nativeId?: string | null;
    path?: string | null;
    providerName?: string | null;
    activityState?: 'idle' | 'busy' | null;
    tmuxName?: string;
    endedAt?: string;
    lastActivityAt?: string;
  }

  function seedSession(session: SessionFixture): void {
    sqlite
      .prepare(
        `INSERT INTO sessions (id, agent_id, kind, status, parent_session_id, provider_session_id,
          transcript_path, provider_name_at_launch, activity_state, started_at, ended_at,
          last_activity_at, created_at, updated_at, tmux_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        agentId,
        session.kind ?? 'session',
        session.status,
        session.parentId ?? null,
        session.nativeId ?? null,
        session.path ?? null,
        session.providerName === undefined ? 'claude' : session.providerName,
        session.activityState ?? null,
        NOW,
        session.endedAt ?? null,
        session.lastActivityAt ?? null,
        NOW,
        NOW,
        session.tmuxName ?? null,
      );
  }

  function addTeamMembership(teamId: string, isLead: boolean): void {
    sqlite
      .prepare(
        `INSERT INTO teams (id, project_id, name, team_lead_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(teamId, projectId, teamId, isLead ? agentId : null, NOW, NOW);
    sqlite
      .prepare('INSERT INTO team_members (team_id, agent_id, created_at) VALUES (?, ?, ?)')
      .run(teamId, agentId, NOW);
  }

  /** A second agent of the same profile, so of the same family. */
  const familyAgentId = uuid(1200);
  function seedFamilyAgent(): void {
    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         SELECT ?, project_id, profile_id, provider_config_id, 'Clone', created_at, updated_at
         FROM agents WHERE id = ?`,
      )
      .run(familyAgentId, agentId);
  }
  /** Sets a row's owner and inherited ids. */
  function setLineage(id: string, inherited: string[], owner = agentId): void {
    sqlite
      .prepare('UPDATE sessions SET agent_id = ?, inherited_session_ids = ? WHERE id = ?')
      .run(owner, JSON.stringify(inherited), id);
  }
  /** MCP session lookup over the app's rows: it fails when two running rows share an id. */
  const resolveSession = (id: string) =>
    new SessionContextResolver(app.get(STORAGE_SERVICE), app.get(SessionsService)).resolve(id);
  const lineageRefusal = {
    message: 'A related session is running on agent "Clone"',
    details: { code: 'SESSION_LINEAGE_RUNNING', agentId: familyAgentId },
  };

  const inject = () => app.getHttpAdapter().getInstance();
  const save = (targetProjectId = projectId) =>
    inject().inject({
      method: 'POST',
      url: `/api/sessions/${sourceId}/save-points`,
      payload: { projectId: targetProjectId },
    });
  const savedRows = () => sqlite.prepare("SELECT * FROM sessions WHERE kind = 'save_point'").all();

  beforeEach(() => {
    seedAgent(sqlite, { projectId, agentId });
    sqlite
      .prepare('UPDATE providers SET bin_path = ? WHERE id = ?')
      .run('/test/claude', providerId);
  });

  describe('POST /api/sessions/:id/save-points', () => {
    let sourcePath: string;
    const sourceContents = JSON.stringify({ sessionId: providerSessionId, type: 'user' }) + '\n';

    beforeEach(async () => {
      sourcePath = join(
        rootDir,
        '.claude',
        'projects',
        'save-http-test',
        `${providerSessionId}.jsonl`,
      );
      await mkdir(dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, sourceContents);
    });

    function seedSource(overrides: Partial<SessionFixture> = {}): void {
      seedSession({
        id: sourceId,
        status: 'running',
        activityState: 'idle',
        nativeId: providerSessionId,
        path: sourcePath,
        lastActivityAt: NOW,
        ...overrides,
      });
    }

    it.each(['idle', null] as const)(
      'copies a running session with activity state %s',
      async (activityState) => {
        seedSource({ activityState });

        const response = await save();

        const node = response.json<SessionTreeNodeDto>();
        expect({ status: response.statusCode, node }).toMatchObject({ status: 201 });
        expect(node).toMatchObject({
          kind: 'save_point',
          status: 'stopped',
          parentSessionId: sourceId,
          lastActivityAt: null,
          providerNameAtLaunch: 'claude',
          transcriptAvailable: true,
          name: null,
        });
        expect(node.providerSessionId).not.toBe(providerSessionId);
        expect(node).not.toHaveProperty('transcriptPath');
        const copyPath = join(dirname(sourcePath), `${node.providerSessionId}.jsonl`);
        expect(await readFile(copyPath, 'utf8')).toBe(
          JSON.stringify({ sessionId: node.providerSessionId, type: 'user' }) + '\n',
        );
        expect(await readFile(sourcePath, 'utf8')).toBe(sourceContents);
        expect(savedRows()).toEqual([
          expect.objectContaining({
            id: node.id,
            kind: 'save_point',
            status: 'stopped',
            agent_id: agentId,
            parent_session_id: sourceId,
            provider_session_id: node.providerSessionId,
            provider_name_at_launch: 'claude',
            transcript_path: copyPath,
            size_bytes: (await stat(copyPath)).size,
            tmux_session_id: null,
            epic_id: null,
            last_activity_at: null,
            activity_state: null,
            name: null,
          }),
        ]);
      },
    );

    it.each<{ code: string; source: Partial<SessionFixture>; member?: boolean }>([
      { code: 'SESSION_NOT_RUNNING', source: { status: 'stopped', activityState: 'busy' } },
      { code: 'SESSION_BUSY', source: { activityState: 'busy', path: null } },
      { code: 'NO_PROVIDER_SESSION_ID', source: { nativeId: null } },
      { code: 'SAVE_POINTS_TEAM_MEMBER', source: {}, member: true },
    ])('rejects $code with 409 before inserting storage', async ({ code, source, member }) => {
      seedSource(source);
      if (member) addTeamMembership(uuid(45), false);

      const response = await save();

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ details: { code } });
      expect(savedRows()).toHaveLength(0);
    });

    // HTTP and SQLite verify that the ID reserved for the adapter matches the stored row and that the size stays null.
    it('passes the new row ID and helper environment and keeps database transcript size null', async () => {
      const databasePath = join(rootDir, PROVIDER_ROOTS.opencode[0], 'save-test.db');
      await mkdir(dirname(databasePath), { recursive: true });
      await writeFile(databasePath, 'shared transcript container');
      seedSource({ providerName: 'opencode', path: databasePath });
      const configuredEnv = {
        CLI_HOME: '/test/home',
        CLI_NO_UPDATE: '0',
        TMUX: 'configured-tmux',
        DEVCHAIN_SESSION_ID: 'configured-session',
        DEVCHAIN_HOOK_PROVIDER: 'configured-provider',
      };
      sqlite
        .prepare("UPDATE providers SET name = 'opencode', env = ? WHERE id = ?")
        .run(JSON.stringify(configuredEnv), providerId);
      const createSavePoint = jest.fn(async ({ sessionId }: CreateSessionSavePointInput) => ({
        providerSessionId: `ses_${sessionId}`,
        transcriptPath: databasePath,
      }));
      const adapter = {
        ...adapterWithoutFork,
        providerName: 'opencode',
        launchEnv: { CLI_NO_UPDATE: '1' },
        launchUnsetEnv: ['TMUX'],
        supportsForkForVersion: (version: string) => version === 'opencode 2.0.31',
        createSavePoint,
        prepareForkLaunch: jest.fn(),
      };
      const mockAdapter = jest
        .spyOn(app.get(ProviderAdapterFactory), 'getAdapter')
        .mockReturnValueOnce(adapter);
      const probe = jest
        .spyOn(app.get(ProviderCliVersionProbe), 'probeForFork')
        .mockResolvedValueOnce({ providerBinPath: '/test/claude', cliVersion: 'opencode 2.0.31' });
      try {
        const response = await save();

        const node = response.json<SessionTreeNodeDto>();
        expect(response.statusCode).toBe(201);
        expect(node).toMatchObject({ providerSessionId: `ses_${node.id}`, sizeBytes: null });
        const [input] = createSavePoint.mock.calls[0];
        expect(input).toMatchObject({
          projectId,
          sessionId: node.id,
          cliVersion: 'opencode 2.0.31',
          env: configuredEnv,
          helperEnv: { CLI_HOME: '/test/home', CLI_NO_UPDATE: '1' },
        });
        for (const key of ['TMUX', 'DEVCHAIN_SESSION_ID', 'DEVCHAIN_HOOK_PROVIDER']) {
          expect(input.helperEnv).not.toHaveProperty(key);
        }
        expect(savedRows()).toEqual([
          expect.objectContaining({ id: node.id, transcript_path: databasePath, size_bytes: null }),
        ]);
      } finally {
        probe.mockRestore();
        mockAdapter.mockRestore();
      }
    });

    it('reports availability and saves an agy session without probing the CLI', async () => {
      const databasePath = join(rootDir, PROVIDER_ROOTS.agy[0], 'conversations', 'save-test.db');
      await mkdir(dirname(databasePath), { recursive: true });
      await writeFile(databasePath, 'agy conversation');
      seedSource({ providerName: 'agy', path: databasePath });
      sqlite.prepare("UPDATE providers SET name = 'agy' WHERE id = ?").run(providerId);
      const agy = app.get(ProviderAdapterFactory).getAdapter('agy') as AntigravityAdapter;
      const createSavePoint = jest
        .spyOn(agy, 'createSavePoint')
        .mockImplementation(async ({ sessionId }) => ({
          providerSessionId: `copy-${sessionId}`,
          transcriptPath: databasePath,
        }));
      const versionProbe = app.get(ProviderCliVersionProbe);
      const probes = [jest.spyOn(versionProbe, 'probe'), jest.spyOn(versionProbe, 'probeForFork')];
      try {
        const tree = await inject().inject({ url: treeUrl });
        expect(tree.json<SessionTreeResponseDto>().savePoints).toEqual({ available: true });

        const response = await save();

        expect(response.statusCode).toBe(201);
        expect(createSavePoint.mock.calls[0][0].cliVersion).toBeUndefined();
        for (const probe of probes) expect(probe).not.toHaveBeenCalled();
      } finally {
        for (const probe of probes) probe.mockRestore();
        createSavePoint.mockRestore();
      }
    });

    // The save route exercises persisted configuration and proves rejection before adapter work or insertion.
    it('rejects a configured launchRejectEnv variable before creating a copy', async () => {
      seedSource();
      sqlite
        .prepare('UPDATE providers SET env = ? WHERE id = ?')
        .run(JSON.stringify({ CLI_STORE: '/test/other-store' }), providerId);
      const adapter = {
        ...adapterWithoutFork,
        launchRejectEnv: ['CLI_STORE'],
        launchUnsetEnv: ['CLI_STORE'],
        createSavePoint: jest.fn(),
        prepareForkLaunch: jest.fn(),
      };
      const mockAdapter = jest
        .spyOn(app.get(ProviderAdapterFactory), 'getAdapter')
        .mockReturnValueOnce(adapter);
      try {
        const response = await save();

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          message: expect.stringContaining('CLI_STORE is not supported'),
        });
        expect(adapter.createSavePoint).not.toHaveBeenCalled();
        expect(savedRows()).toHaveLength(0);
      } finally {
        mockAdapter.mockRestore();
      }
    });

    it.each(['missing', 'symlink outside the allowed root'])(
      'does not insert a save point when the copy is %s',
      async (fixture) => {
        seedSource();
        const copyPath = join(dirname(sourcePath), `${uuid(46)}.jsonl`);
        if (fixture !== 'missing') {
          const outside = join(rootDir, 'outside.jsonl');
          await writeFile(outside, sourceContents);
          await symlink(outside, copyPath);
        }
        const create = jest
          .spyOn(app.get(ClaudeAdapter), 'createSavePoint')
          .mockResolvedValueOnce({ providerSessionId: uuid(46), transcriptPath: copyPath });
        try {
          const response = await save();
          expect(response.statusCode).toBe(400);
          expect(response.json()).toMatchObject({ message: expect.stringContaining('transcript') });
          expect(create).toHaveBeenCalledTimes(1);
          expect(savedRows()).toHaveLength(0);
        } finally {
          create.mockRestore();
        }
      },
    );

    it('checks project ownership before copying', async () => {
      seedSource();
      const response = await save(uuid(47));
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ details: { code: 'SESSION_PROJECT_MISMATCH' } });
      expect(savedRows()).toHaveLength(0);
    });

    it('rejects a session that becomes busy while its transcript is being validated', async () => {
      seedSource();
      const validator = app.get(TranscriptPathValidator);
      const validate = validator.validateForRead.bind(validator);
      const spy = jest
        .spyOn(validator, 'validateForRead')
        .mockImplementationOnce(async (path, provider) => {
          const verified = await validate(path, provider);
          sqlite.prepare("UPDATE sessions SET activity_state = 'busy' WHERE id = ?").run(sourceId);
          return verified;
        });

      try {
        const response = await save();
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ details: { code: 'SESSION_BUSY' } });
        expect(savedRows()).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      { turn: 'is still running', endState: 'busy' },
      { turn: 'has already finished', endState: 'idle' },
    ])('rejects a copy when a turn that started during it $turn', async ({ endState }) => {
      seedSource();
      const adapter = app.get(ClaudeAdapter);
      const copy = adapter.createSavePoint.bind(adapter);
      const spy = jest.spyOn(adapter, 'createSavePoint').mockImplementationOnce(async (input) => {
        // The terminal activity service writes this on each turn start, outside the agent lock.
        sqlite
          .prepare('UPDATE sessions SET activity_state = ?, busy_since = ? WHERE id = ?')
          .run(endState, LATER, sourceId);
        return copy(input);
      });

      try {
        const response = await save();
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ details: { code: 'SESSION_BUSY' } });
        expect(savedRows()).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  /**
   * Freezes the project inside the first call of `method` on `target`, after its real result is
   * ready: the request then reaches its stop with a project that is no longer writable.
   */
  function freezeDuringFirst<T extends object>(target: T, method: keyof T & string): () => void {
    const gate = app.get(ProjectWriteGate);
    const original = (target[method] as (...args: unknown[]) => unknown).bind(target);
    jest.spyOn(target, method as never).mockImplementationOnce((async (...args: unknown[]) => {
      const result = await original(...args);
      gate.markFrozen(projectId, NOW);
      return result;
    }) as never);
    return () => gate.markThawed(projectId);
  }

  describe('start and restore with replacement', () => {
    const savePointId = uuid(70);
    const runningId = uuid(71);
    const runningProviderId = uuid(72);
    const tmuxName = 'replacement-target';
    let savePath: string;

    beforeEach(async () => {
      const projectRoot = join(rootDir, 'start-http-project');
      await mkdir(projectRoot, { recursive: true });
      sqlite.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(projectRoot, projectId);
      savePath = join(
        rootDir,
        '.claude',
        'projects',
        'start-http-test',
        `${providerSessionId}.jsonl`,
      );
      await mkdir(dirname(savePath), { recursive: true });
      // A test can replace the save point with a symlink; write a regular file again.
      await rm(savePath, { force: true });
      await writeFile(
        savePath,
        JSON.stringify({ sessionId: providerSessionId, type: 'user' }) + '\n',
      );

      const now = Date.now();
      let elapsed = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => now + elapsed);
      mockTerminalIO.waitForOutput.mockImplementation(async () => {
        elapsed += 7_000;
        return true;
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
      mockTerminalIO.waitForOutput.mockResolvedValue(true);
    });

    const row = (id: string) => sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    const start = (replaceRunningSessionId?: string, forkSourceId = savePointId) =>
      inject().inject({
        method: 'POST',
        url: `/api/sessions/${forkSourceId}/start`,
        payload: { projectId, replaceRunningSessionId },
      });
    const restore = (id: string, replaceRunningSessionId?: string) =>
      inject().inject({
        method: 'POST',
        url: `/api/sessions/${id}/restore`,
        payload: { projectId, replaceRunningSessionId },
      });

    function seedSavePoint(overrides: Partial<SessionFixture> = {}) {
      seedSession({
        id: savePointId,
        kind: 'save_point',
        status: 'stopped',
        nativeId: providerSessionId,
        path: savePath,
        ...overrides,
      });
    }

    function seedRunning() {
      seedSession({ id: runningId, status: 'running', nativeId: runningProviderId, tmuxName });
    }

    it.each(['save during copy', 'fork before insert', 'fork during planning'] as const)(
      'refuses the lineage write when the project freezes for %s',
      async (operation) => {
        const gate = app.get(ProjectWriteGate);
        const adapter = app.get(ClaudeAdapter);
        const freeze = () => {
          expect(gate.isWritable(projectId)).toBe(true);
          gate.markFrozen(projectId, NOW);
        };

        if (operation === 'save during copy') {
          seedSession({
            id: sourceId,
            status: 'running',
            nativeId: providerSessionId,
            path: savePath,
          });
          const createSavePoint = adapter.createSavePoint.bind(adapter);
          jest.spyOn(adapter, 'createSavePoint').mockImplementationOnce(async (input) => {
            const copy = await createSavePoint(input);
            freeze();
            return copy;
          });
        } else if (operation === 'fork before insert') {
          seedSavePoint();
          const store = app.get(SessionRowStore);
          const insert = store.insertForkedSession.bind(store);
          jest.spyOn(store, 'insertForkedSession').mockImplementationOnce((input) => {
            freeze();
            return insert(input);
          });
        } else {
          seedSavePoint();
          const prepareForkLaunch = adapter.prepareForkLaunch.bind(adapter);
          jest.spyOn(adapter, 'prepareForkLaunch').mockImplementationOnce(async (input) => {
            const plan = await prepareForkLaunch(input);
            freeze();
            return plan;
          });
        }

        const filesBefore = (await readdir(dirname(savePath))).sort();
        try {
          const response = await (operation === 'save during copy' ? save() : start());

          expect(response.statusCode).toBe(423);
          expect(response.json()).toMatchObject({ code: 'PROJECT_FROZEN', details: { projectId } });
          const child = { status: 'failed', parent_session_id: savePointId };
          const source = {
            id: operation === 'save during copy' ? sourceId : savePointId,
            parent_session_id: null,
          };
          expect(
            sqlite
              .prepare(
                `SELECT id, status, parent_session_id FROM sessions WHERE agent_id = ?
                        ORDER BY parent_session_id`,
              )
              .all(agentId),
          ).toEqual([
            expect.objectContaining(source),
            ...(operation === 'fork during planning' ? [expect.objectContaining(child)] : []),
          ]);
          expect(mockTerminalIO.createEmptySession).not.toHaveBeenCalled();
          if (operation !== 'save during copy') {
            expect((await readdir(dirname(savePath))).sort()).toEqual(filesBefore);
          }
        } finally {
          gate.markThawed(projectId);
        }
      },
    );

    it.each([false, true])('starts a child with replacement requested = %s', async (replace) => {
      seedSavePoint();
      if (replace) seedRunning();
      const original = row(savePointId);

      const response = await start(replace ? runningId : undefined);

      expect(response.statusCode).toBe(201);
      const { id } = response.json<{ id: string }>();
      expect(id).not.toBe(savePointId);
      const child = row(id) as { provider_session_id: string };
      expect(child.provider_session_id).not.toBe(id);
      expect(child).toMatchObject({
        agent_id: agentId,
        kind: 'session',
        parent_session_id: savePointId,
        status: 'running',
        provider_session_id: expect.any(String),
        transcript_path: join(dirname(savePath), `${child.provider_session_id}.jsonl`),
      });
      expect(row(savePointId)).toEqual(original);
      if (replace) {
        expect(row(runningId)).toMatchObject({
          status: 'stopped',
          provider_session_id: runningProviderId,
        });
        expect(mockTerminalIO.destroyExpectedSession).toHaveBeenCalledWith(
          { name: tmuxName },
          expect.anything(),
        );
        expect(mockTerminalIO.destroyExpectedSession.mock.invocationCallOrder[0]).toBeLessThan(
          mockTerminalIO.createEmptySession.mock.invocationCallOrder[0],
        );
      }
    });

    // HTTP and SQLite verify that the same persisted source can be forked and then restored.
    it.each(['stopped', 'failed', 'running'] as const)(
      'forks a %s session and leaves it restorable',
      async (status) => {
        const running = status === 'running';
        seedSession({
          id: sourceId,
          status,
          nativeId: providerSessionId,
          path: savePath,
          tmuxName: running ? tmuxName : undefined,
        });
        const inheritedIds = [uuid(75), uuid(76)];
        sqlite
          .prepare('UPDATE sessions SET inherited_session_ids = ? WHERE id = ?')
          .run(JSON.stringify(inheritedIds), sourceId);
        const original = row(sourceId);
        const originalTranscript = await readFile(savePath);

        // A running source is the session that the fork replaces.
        const response = await start(running ? sourceId : undefined, sourceId);

        expect(response.statusCode).toBe(201);
        const { id: childId } = response.json<{ id: string }>();
        expect(row(childId)).toMatchObject({
          kind: 'session',
          status: 'running',
          parent_session_id: sourceId,
          inherited_session_ids: JSON.stringify([...inheritedIds, sourceId]),
        });
        if (running) {
          expect(row(sourceId)).toMatchObject({
            status: 'stopped',
            provider_session_id: providerSessionId,
          });
        } else {
          expect(row(sourceId)).toEqual(original);
        }
        expect(await readFile(savePath)).toEqual(originalTranscript);

        const restored = await restore(sourceId, childId);
        expect(restored.statusCode).toBe(201);
        expect(restored.json()).toMatchObject({ id: sourceId, status: 'running' });
        expect(row(childId)).toMatchObject({ status: 'stopped' });
      },
    );

    describe('with a related session', () => {
      const parentId = uuid(1201);
      const childId = uuid(1202);
      const siblingId = uuid(1203);

      beforeEach(() => {
        seedFamilyAgent();
      });

      function seedChild(): void {
        seedSession({
          id: childId,
          status: 'stopped',
          nativeId: providerSessionId,
          path: savePath,
        });
        setLineage(childId, [parentId]);
      }

      // HTTP, SQLite, the transcript folder and MCP lookup show a refusal that changes nothing.
      it.each([
        { scenario: "A's child whose parent runs on B", related: parentId, source: childId },
        {
          scenario: 'a save point whose sibling fork runs on B',
          related: siblingId,
          source: savePointId,
        },
      ])('refuses to fork $scenario before any stop or copy', async ({ related, source }) => {
        seedSession({ id: related, status: 'running', nativeId: uuid(1204), tmuxName: 'on-b' });
        setLineage(related, related === siblingId ? [parentId] : [], familyAgentId);
        if (source === childId) seedChild();
        else {
          seedSavePoint();
          setLineage(savePointId, [parentId]);
        }
        seedRunning();
        const rowsBefore = sessionRows();
        const filesBefore = (await readdir(dirname(savePath))).sort();

        for (const attempt of [1, 2]) {
          const response = await start(runningId, source);

          expect({ attempt, status: response.statusCode }).toEqual({ attempt, status: 409 });
          expect(response.json()).toMatchObject(lineageRefusal);
          expect(sessionRows()).toEqual(rowsBefore);
          expect((await readdir(dirname(savePath))).sort()).toEqual(filesBefore);
          expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
          expect(await resolveSession(parentId)).toMatchObject({ success: true });
        }
      });

      it('forks a child whose running parent is the confirmed replacement', async () => {
        seedSession({ id: parentId, status: 'running', nativeId: uuid(1204), tmuxName });
        seedChild();

        const response = await start(parentId, childId);

        expect(response.statusCode).toBe(201);
        expect(row(parentId)).toMatchObject({ status: 'stopped' });
        expect(row(response.json<{ id: string }>().id)).toMatchObject({ status: 'running' });
        expect(await resolveSession(parentId)).toMatchObject({ success: true });
      });

      // The spy starts the parent between the lock-held check and the insert transaction.
      it('refuses the fork in its insert transaction when the parent starts after the check', async () => {
        seedSession({ id: parentId, status: 'stopped', nativeId: uuid(1204) });
        setLineage(parentId, [], familyAgentId);
        seedChild();
        const store = app.get(SessionRowStore);
        const insert = store.insertForkedSession.bind(store);
        jest.spyOn(store, 'insertForkedSession').mockImplementationOnce((input) => {
          sqlite.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(parentId);
          return insert(input);
        });
        const filesBefore = (await readdir(dirname(savePath))).sort();

        const response = await start(undefined, childId);

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject(lineageRefusal);
        expect(sessionRows()).toHaveLength(2);
        expect((await readdir(dirname(savePath))).sort()).toEqual(filesBefore);
        expect(mockTerminalIO.createEmptySession).not.toHaveBeenCalled();
        expect(await resolveSession(parentId)).toMatchObject({ success: true });
      });

      // B's restore and A's fork take different agent locks; their write transactions decide.
      it('runs exactly one of a restore of the parent and a fork of its child', async () => {
        seedSession({ id: parentId, status: 'stopped', nativeId: uuid(1204) });
        setLineage(parentId, [], familyAgentId);
        seedChild();

        const responses = await Promise.all([restore(parentId), start(undefined, childId)]);

        expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
        expect(responses.find(({ statusCode }) => statusCode === 409)!.json()).toMatchObject({
          details: { code: 'SESSION_LINEAGE_RUNNING' },
        });
        expect(
          sqlite.prepare("SELECT id FROM sessions WHERE status = 'running'").all(),
        ).toHaveLength(1);
        expect(await resolveSession(parentId)).toMatchObject({ success: true });
      });
    });

    // HTTP and the terminal boundary verify rejection before a replacement takes effect.
    it.each([
      { scenario: 'no replacement', code: 'INVALID_SESSION_STATE', replacement: undefined },
      { scenario: 'a different replacement', code: 'INVALID_SESSION_STATE', replacement: uuid(74) },
      { scenario: 'a busy source', code: 'SESSION_BUSY', replacement: runningId, busy: true },
      {
        scenario: 'a turn that starts during the last provider check',
        code: 'SESSION_BUSY',
        replacement: runningId,
        busyLate: true,
      },
    ])(
      'rejects a running fork source with $scenario before stopping it',
      async ({ code, replacement, busy, busyLate }) => {
        seedSession({
          id: runningId,
          status: 'running',
          nativeId: providerSessionId,
          path: savePath,
          tmuxName,
          activityState: busy ? 'busy' : undefined,
        });
        if (busyLate) {
          const savePoints = app.get(SessionSavePointsService);
          const getForkSupport = savePoints.getForkSupport.bind(savePoints);
          let calls = 0;
          jest.spyOn(savePoints, 'getForkSupport').mockImplementation(async (...args) => {
            // The first call is the preflight; the second is the check right before the stop.
            if (++calls === 2) {
              sqlite
                .prepare("UPDATE sessions SET activity_state = 'busy' WHERE id = ?")
                .run(runningId);
            }
            return getForkSupport(...args);
          });
        }

        const response = await start(replacement, runningId);

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ details: { code } });
        expect(row(runningId)).toMatchObject({ status: 'running' });
        expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
      },
    );

    // HTTP, SQLite, and the terminal boundary show that preflight errors leave the running session active.
    it.each([
      { code: 'PROVIDER_MISMATCH', source: { providerName: 'codex' } },
      { code: 'SAVE_POINTS_TEAM_MEMBER', member: true },
      { code: 'NO_PROVIDER_SESSION_ID', source: { nativeId: null } },
      { code: 'RUNNING_SESSION_CHANGED', replacement: 'missing' },
      { code: 'RUNNING_SESSION_CHANGED', replacement: 'different' },
      { code: 'validation_error', status: 400, envSource: 'provider' },
      { code: 'validation_error', status: 400, envSource: 'profile during preflight' },
    ])(
      'returns $code before stopping the running session ($replacement $envSource)',
      async ({ code, status = 409, source, member, replacement, envSource }) => {
        seedSavePoint(source);
        seedRunning();
        if (member) addTeamMembership(uuid(73), false);
        const prepareForkLaunch = jest.fn();
        const preflight = app.get(PreflightService);
        const runChecks = preflight.runChecks.bind(preflight);
        const checkProvider = jest.spyOn(preflight, 'runChecks');
        if (envSource) {
          const adapter = {
            ...adapterWithoutFork,
            forkReadsSavePointTranscript: true,
            supportsForkForVersion: (version: string) => version === '2.0.0',
            launchRejectEnv: ['COPILOT_HOME'],
            launchUnsetEnv: ['COPILOT_HOME'],
            createSavePoint: jest.fn(),
            prepareForkLaunch,
          };
          jest.spyOn(app.get(ProviderAdapterFactory), 'getAdapter').mockReturnValue(adapter);
          jest.spyOn(app.get(ProviderCliVersionProbe), 'probeForFork').mockResolvedValue({
            providerBinPath: '/test/claude',
            cliVersion: '2.0.0',
          });
          const forbiddenEnv = JSON.stringify({ COPILOT_HOME: '/test/other-store' });
          if (envSource === 'provider') {
            sqlite
              .prepare('UPDATE providers SET env = ? WHERE id = ?')
              .run(forbiddenEnv, providerId);
          } else {
            checkProvider.mockImplementationOnce(async (...args) => {
              const result = await runChecks(...args);
              sqlite
                .prepare(
                  `UPDATE profile_provider_configs SET env = ?
                   WHERE id = (SELECT provider_config_id FROM agents WHERE id = ?)`,
                )
                .run(forbiddenEnv, agentId);
              return result;
            });
          }
        }
        const expected =
          replacement === 'missing'
            ? undefined
            : replacement === 'different'
              ? uuid(74)
              : runningId;

        const response = await start(expected);

        expect(response.statusCode).toBe(status);
        if (envSource) {
          expect(response.json()).toMatchObject({
            code,
            message: expect.stringContaining('COPILOT_HOME is not supported'),
          });
          expect(checkProvider).toHaveBeenCalledTimes(envSource === 'provider' ? 0 : 1);
          expect(prepareForkLaunch).not.toHaveBeenCalled();
          expect(
            sqlite.prepare('SELECT id FROM sessions WHERE parent_session_id = ?').all(savePointId),
          ).toEqual([]);
        } else {
          expect(response.json()).toMatchObject({ details: { code } });
        }
        expect(row(runningId)).toMatchObject({ status: 'running' });
        expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
      },
    );

    // The three HTTP routes and the running SQLite row show that each caller applies the same eligibility rule.
    it.each(['no fork capability', 'unsupported installed version'] as const)(
      'reports %s in the tree and rejects save and replacement',
      async (reason) => {
        seedSavePoint();
        seedSession({
          id: sourceId,
          status: 'running',
          nativeId: runningProviderId,
          path: savePath,
          tmuxName,
        });
        const versionedAdapter = {
          ...adapterWithoutFork,
          supportsForkForVersion: (version: string) => version.startsWith('2.'),
          createSavePoint: jest.fn(),
          prepareForkLaunch: jest.fn(),
        };
        const mockAdapter = jest
          .spyOn(app.get(ProviderAdapterFactory), 'getAdapter')
          .mockReturnValue(reason === 'no fork capability' ? adapterWithoutFork : versionedAdapter);
        const probe = jest
          .spyOn(app.get(ProviderCliVersionProbe), 'probeForFork')
          .mockResolvedValue({ providerBinPath: '/test/claude', cliVersion: '1.9.0' });
        try {
          const tree = await inject().inject({ url: treeUrl });
          expect(tree.statusCode).toBe(200);
          expect(tree.json<SessionTreeResponseDto>().savePoints).toEqual({
            available: false,
            reason: 'PROVIDER_UNSUPPORTED',
          });

          for (const response of [await save(), await start(sourceId)]) {
            expect(response.statusCode).toBe(409);
            expect(response.json()).toMatchObject({
              details: { code: 'SAVE_POINTS_UNSUPPORTED_PROVIDER' },
            });
          }
          expect(row(sourceId)).toMatchObject({ status: 'running' });
          expect(savedRows()).toHaveLength(1);
          expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
          expect(versionedAdapter.createSavePoint).not.toHaveBeenCalled();
          expect(versionedAdapter.prepareForkLaunch).not.toHaveBeenCalled();
        } finally {
          probe.mockRestore();
          mockAdapter.mockRestore();
        }
      },
    );

    // HTTP, SQLite, and executable stubs exercise real PATH lookup through all three fork callers.
    it.each([
      { server: '2.0.31', configured: '1.19.0', eligible: false },
      { server: '1.19.0', configured: '2.0.31', eligible: true },
      { server: '2.0.31', configured: null, eligible: false },
    ])(
      'uses configured OpenCode $configured with server OpenCode $server for tree, save and fork',
      async ({ server, configured, eligible }) => {
        const fixture = await realpath(await mkdtemp(join(rootDir, 'fork-cli-path-')));
        const serverDir = join(fixture, 'server');
        const configuredDir = join(fixture, 'configured');
        await mkdir(serverDir);
        await mkdir(configuredDir);
        const callsPath = join(fixture, 'cli-calls');
        await writeFile(callsPath, '');
        const stub = (version: string, name: string) =>
          [
            '#!/bin/sh',
            `printf '%s %s\\n' '${name}' "$1" >> "$FORK_TEST_CALLS"`,
            'if [ "${0##*/}" != opencode ]; then',
            '  [ "$1" = --version ] || exit 1',
            '  printf "dispatcher v0.1.0\\n"',
            '  exit 0',
            'fi',
            'case "$1" in',
            `  --version) printf '%s\\n' 'opencode v${version}' ;;`,
            '  api)',
            `    [ '${version.split('.')[0]}' = 2 ] || exit 1`,
            '    case "$4" in',
            '      sessionID=ses_running) printf \'{"data":{"id":"ses_saved"}}\\n\' ;;',
            '      sessionID=ses_checkpoint) printf \'{"data":{"id":"ses_child"}}\\n\' ;;',
            '      *) exit 1 ;;',
            '    esac ;;',
            'esac',
          ].join('\n');
        const serverBin = join(serverDir, 'opencode');
        const configuredBin = join(configuredDir, 'opencode');
        const dispatcher = join(configuredDir, 'dispatcher');
        const cliPaths = [serverBin, configuredBin, dispatcher, 'opencode'];
        await writeFile(serverBin, stub(server, 'server'), { mode: 0o700 });
        if (configured) {
          await writeFile(dispatcher, stub(configured, 'configured'), { mode: 0o700 });
          await symlink(dispatcher, configuredBin);
        }

        const databasePath = join(rootDir, PROVIDER_ROOTS.opencode[0], 'fork-cli-path.db');
        await mkdir(dirname(databasePath), { recursive: true });
        await writeFile(databasePath, 'session container');
        const setProviderPath = (path: string) =>
          sqlite
            .prepare(
              "UPDATE providers SET name = 'opencode', bin_path = 'opencode', env = ? WHERE id = ?",
            )
            .run(JSON.stringify({ PATH: path, FORK_TEST_CALLS: callsPath }), providerId);
        setProviderPath(configuredDir);
        seedSavePoint({ providerName: 'opencode', nativeId: 'ses_checkpoint', path: databasePath });
        seedSession({
          id: sourceId,
          status: 'running',
          providerName: 'opencode',
          nativeId: 'ses_running',
          path: databasePath,
          tmuxName,
        });

        const replacedEnv = jest.replaceProperty(process, 'env', {
          ...process.env,
          PATH: [serverDir, process.env.PATH].filter(Boolean).join(delimiter),
          FORK_TEST_CALLS: callsPath,
        });
        const run = jest.mocked(app.get(ProcessExecutor).run);
        const runMock = run.getMockImplementation()!;
        const executor = new ChildProcessExecutor();
        run.mockImplementation((request) => {
          const [bin, action] = request.argv;
          return cliPaths.includes(bin) || (bin === 'which' && action === 'opencode')
            ? executor.run(request)
            : runMock(request);
        });
        if (eligible) {
          const sessions = app.get(SessionsService);
          const terminate = sessions.terminateSessionUnderLock.bind(sessions);
          jest
            .spyOn(sessions, 'terminateSessionUnderLock')
            .mockImplementationOnce(async (...args) => {
              const result = await terminate(...args);
              setProviderPath(serverDir);
              return result;
            });
        }

        try {
          const tree = await inject().inject({ url: treeUrl });
          const saved = await save();
          const forked = await start(sourceId);
          expect(tree.statusCode).toBe(200);
          expect(tree.json<SessionTreeResponseDto>().savePoints).toEqual(
            eligible ? { available: true } : { available: false, reason: 'PROVIDER_UNSUPPORTED' },
          );
          if (eligible) {
            expect(saved.statusCode).toBe(201);
            expect(saved.json()).toMatchObject({ providerSessionId: 'ses_saved' });
            expect(forked.statusCode).toBe(201);
            expect(row(forked.json<{ id: string }>().id)).toMatchObject({
              provider_session_id: 'ses_child',
              status: 'running',
            });
            expect(
              run.mock.calls
                .map(([request]) => request)
                .filter(({ argv: [bin] }) => cliPaths.includes(bin))
                .map(({ argv: [bin, action], env }) => [bin, action, env?.PATH]),
            ).toEqual([
              [configuredBin, '--version', configuredDir],
              [configuredBin, 'api', configuredDir],
              [configuredBin, 'api', configuredDir],
            ]);
            expect(await readFile(callsPath, 'utf8')).toBe(
              'configured --version\nconfigured api\nconfigured api\n',
            );
          } else {
            for (const response of [saved, forked]) {
              expect(response.statusCode).toBe(409);
              expect(response.json()).toMatchObject({
                details: { code: 'SAVE_POINTS_UNSUPPORTED_PROVIDER' },
              });
            }
            expect(row(sourceId)).toMatchObject({ status: 'running' });
            expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
            expect(await readFile(callsPath, 'utf8')).toBe(
              configured ? 'configured --version\n' : '',
            );
          }
        } finally {
          run.mockImplementation(runMock);
          replacedEnv.restore();
        }
      },
    );

    it('leaves the original running when provider readiness fails', async () => {
      seedSavePoint();
      seedRunning();
      jest.spyOn(app.get(PreflightService), 'runChecks').mockResolvedValueOnce({
        overall: 'fail',
        checks: [{ name: 'provider', status: 'fail', message: 'preflight failed' }],
        providers: [],
        supportedMcpProviders: [],
        timestamp: NOW,
      });

      const response = await start(runningId);

      expect(response.statusCode).toBe(400);
      expect(row(runningId)).toMatchObject({ status: 'running' });
      expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
    });

    // HTTP and SQLite expose the conflict and the original row across both lifecycle boundaries.
    it.each(['preflight', 'after termination'] as const)(
      'returns a provider mismatch when the selected configuration changes %s',
      async (timing) => {
        seedSavePoint();
        seedRunning();
        const codexProviderId = uuid(903);
        const codexConfigId = uuid(904);
        sqlite
          .prepare(
            `INSERT INTO providers (id, name, bin_path, created_at, updated_at)
                    VALUES (?, 'codex', '/test/codex', ?, ?)`,
          )
          .run(codexProviderId, NOW, NOW);
        sqlite
          .prepare(
            `INSERT INTO profile_provider_configs
                      (id, profile_id, provider_id, name, position, created_at, updated_at)
                    SELECT ?, profile_id, ?, 'Codex', 1, ?, ? FROM agents WHERE id = ?`,
          )
          .run(codexConfigId, codexProviderId, NOW, NOW, agentId);
        const selectCodex = () => {
          sqlite
            .prepare('UPDATE agents SET provider_config_id = ? WHERE id = ?')
            .run(codexConfigId, agentId);
        };
        if (timing === 'preflight') {
          const preflight = app.get(PreflightService);
          const runChecks = preflight.runChecks.bind(preflight);
          jest.spyOn(preflight, 'runChecks').mockImplementationOnce(async (...args) => {
            const result = await runChecks(...args);
            selectCodex();
            return result;
          });
        } else {
          const sessions = app.get(SessionsService);
          const terminate = sessions.terminateSessionUnderLock.bind(sessions);
          jest
            .spyOn(sessions, 'terminateSessionUnderLock')
            .mockImplementationOnce(async (...args) => {
              await terminate(...args);
              selectCodex();
            });
        }
        const prepareFork = jest.spyOn(app.get(ClaudeAdapter), 'prepareForkLaunch');

        const response = await start(runningId);

        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ details: { code: 'PROVIDER_MISMATCH' } });
        expect(row(runningId)).toMatchObject({
          status: timing === 'preflight' ? 'running' : 'stopped',
        });
        expect(mockTerminalIO.destroyExpectedSession).toHaveBeenCalledTimes(
          timing === 'preflight' ? 0 : 1,
        );
        expect(
          sqlite.prepare('SELECT id FROM sessions WHERE parent_session_id = ?').all(savePointId),
        ).toEqual([]);
        expect(prepareFork).not.toHaveBeenCalled();
        expect(mockTerminalIO.createEmptySession).not.toHaveBeenCalled();
        expect(mockTerminalIO.typeCommand).not.toHaveBeenCalled();
      },
    );

    // Real paths and SQLite show that transcript preflight precedes both termination and insertion.
    it.each([
      { scenario: 'a session transcript is missing', kind: 'session', provider: 'claude' },
      {
        scenario: 'a save point transcript is outside the provider root',
        kind: 'save_point',
        provider: 'claude',
      },
      { scenario: 'a Devin export is missing', kind: 'session', provider: 'devin' },
    ] as const)('leaves the running session alone when $scenario', async ({ kind, provider }) => {
      const transcriptPath =
        provider === 'devin' ? devinTranscriptPath(rootDir, sourceId) : savePath;
      sqlite.prepare('UPDATE providers SET name = ? WHERE id = ?').run(provider, providerId);
      seedSession({
        id: sourceId,
        kind,
        status: 'stopped',
        nativeId: providerSessionId,
        path: transcriptPath,
        providerName: provider,
      });
      seedRunning();
      await rm(transcriptPath, { force: true });
      if (kind === 'save_point') {
        const outside = join(rootDir, 'outside-save-point.jsonl');
        await writeFile(
          outside,
          JSON.stringify({ sessionId: providerSessionId, type: 'user' }) + '\n',
        );
        await symlink(outside, savePath);
      }

      const response = await start(runningId, sourceId);

      expect(response.statusCode).toBe(400);
      expect(row(runningId)).toMatchObject({ status: 'running' });
      expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
      expect(
        sqlite.prepare('SELECT id FROM sessions WHERE parent_session_id = ?').all(sourceId),
      ).toEqual([]);
    });

    it.each(['provider preparation', 'CLI launch'] as const)(
      'records a failed child and leaves the replaced session restorable when %s fails',
      async (failure) => {
        seedSavePoint();
        seedRunning();
        if (failure === 'provider preparation') {
          await writeFile(savePath, '{"malformed JSONL"}\n');
        } else {
          mockTerminalIO.typeCommand.mockRejectedValueOnce(new Error('launch failed'));
        }
        const bound = failure === 'CLI launch';
        const filesBefore = (await readdir(dirname(savePath))).sort();

        expect((await start(runningId)).statusCode).toBe(500);

        const children = sqlite
          .prepare<
            [string],
            { id: string; provider_session_id: string | null; transcript_path: string | null }
          >('SELECT id, kind, status, provider_session_id, transcript_path FROM sessions WHERE parent_session_id = ?')
          .all(savePointId);
        expect(children).toEqual([
          {
            id: expect.any(String),
            kind: 'session',
            status: 'failed',
            provider_session_id: bound ? expect.any(String) : null,
            transcript_path: bound ? expect.any(String) : null,
          },
        ]);
        if (!bound) {
          expect((await readdir(dirname(savePath))).sort()).toEqual(filesBefore);
        } else {
          const child = children[0];
          expect(child.transcript_path).toBe(
            join(dirname(savePath), `${child.provider_session_id}.jsonl`),
          );
          expect(await readFile(child.transcript_path!, 'utf8')).toBe(
            JSON.stringify({ sessionId: child.provider_session_id, type: 'user' }) + '\n',
          );
        }
        expect(row(runningId)).toMatchObject({ status: 'stopped' });
        expect((await restore(runningId)).statusCode).toBe(201);
        expect(row(runningId)).toMatchObject({ status: 'running' });
      },
    );

    // The provider lookup runs before the locked stop; only a check under the locks sees the freeze.
    it.each(['restore', 'fork'] as const)(
      'keeps the replacement running when the project freezes during the provider lookup of a %s',
      async (operation) => {
        seedSavePoint(operation === 'restore' ? { kind: 'session' } : {});
        seedRunning();
        const thaw = freezeDuringFirst(app.get(STORAGE_SERVICE), 'getProvider');
        try {
          const response = await (operation === 'restore'
            ? restore(savePointId, runningId)
            : start(runningId));

          expect(response.statusCode).toBe(423);
          expect(response.json()).toMatchObject({ code: 'PROJECT_FROZEN' });
          expect(row(runningId)).toMatchObject({ status: 'running', tmux_session_id: tmuxName });
          expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
        } finally {
          thaw();
        }
      },
    );

    it('restores the target in place only after the current session is confirmed for replacement', async () => {
      seedSavePoint({ kind: 'session' });
      seedRunning();

      const withoutReplacement = await restore(savePointId);
      expect(withoutReplacement.statusCode).toBe(409);
      expect(withoutReplacement.json()).toMatchObject({
        details: { code: 'INVALID_SESSION_STATE' },
      });
      const staleReplacement = await restore(savePointId, uuid(74));
      expect(staleReplacement.statusCode).toBe(409);
      expect(staleReplacement.json()).toMatchObject({
        details: { code: 'RUNNING_SESSION_CHANGED' },
      });
      expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();

      const confirmed = await restore(savePointId, runningId);
      expect(confirmed.statusCode).toBe(201);
      expect(confirmed.json()).toMatchObject({ id: savePointId, status: 'running' });
      expect(row(runningId)).toMatchObject({ status: 'stopped' });
    });
  });

  describe('POST /api/sessions/:id/rollback', () => {
    const sessionId = uuid(80);
    const currentNativeId = uuid(81);
    const savePointId = uuid(82);
    const savePointNativeId = uuid(83);
    const otherId = uuid(84);
    const inherited = [uuid(85)];
    let transcriptDir: string;
    let currentPath: string;
    let savePointPath: string;

    const transcript = (nativeId: string, message: string) =>
      JSON.stringify({ sessionId: nativeId, type: 'user', message }) + '\n';
    const row = (id: string) =>
      sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
        | Record<string, string | null>
        | undefined;
    const children = (parentId: string) =>
      sqlite
        .prepare('SELECT id FROM sessions WHERE parent_session_id = ? ORDER BY id')
        .all(parentId);
    const rollback = (body: {
      keepCurrent: boolean;
      replaceRunningSessionId?: string;
      savePointId?: string;
    }) =>
      inject().inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/rollback`,
        payload: { projectId, savePointId, ...body },
      });

    beforeEach(async () => {
      const projectRoot = join(rootDir, 'rollback-http-project');
      await mkdir(projectRoot, { recursive: true });
      sqlite.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(projectRoot, projectId);
      transcriptDir = join(rootDir, '.claude', 'projects', 'rollback-http-test');
      await rm(transcriptDir, { recursive: true, force: true });
      await mkdir(transcriptDir, { recursive: true });
      currentPath = join(transcriptDir, `${currentNativeId}.jsonl`);
      savePointPath = join(transcriptDir, `${savePointNativeId}.jsonl`);
      await writeFile(currentPath, transcript(currentNativeId, 'current turn'));
      await writeFile(savePointPath, transcript(savePointNativeId, 'saved turn'));

      seedSession({
        id: sessionId,
        status: 'stopped',
        nativeId: currentNativeId,
        path: currentPath,
      });
      sqlite
        .prepare('UPDATE sessions SET name = ?, inherited_session_ids = ? WHERE id = ?')
        .run('Kept name', JSON.stringify(inherited), sessionId);
      seedSession({
        id: savePointId,
        kind: 'save_point',
        status: 'stopped',
        parentId: sessionId,
        nativeId: savePointNativeId,
        path: savePointPath,
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    describe('with a related session', () => {
      const [parentId] = inherited;
      const siblingId = uuid(1210);
      const transcripts = async () => (await readdir(transcriptDir)).sort();

      beforeEach(() => {
        seedFamilyAgent();
      });

      // HTTP, SQLite and MCP lookup show a refusal that stops nothing and changes nothing.
      it.each([
        { scenario: 'its parent runs on B', related: parentId },
        { scenario: 'a sibling that shares an inherited id runs on B', related: siblingId },
      ])('refuses to roll back a fork on A while $scenario', async ({ related }) => {
        seedSession({ id: related, status: 'running', nativeId: uuid(1211), tmuxName: 'on-b' });
        setLineage(related, related === siblingId ? [parentId] : [], familyAgentId);
        seedSession({ id: otherId, status: 'running', nativeId: uuid(87), tmuxName: 'other' });
        const rowsBefore = sessionRows();
        const filesBefore = await transcripts();

        for (const attempt of [1, 2]) {
          const response = await rollback({ keepCurrent: true, replaceRunningSessionId: otherId });

          expect({ attempt, status: response.statusCode }).toEqual({ attempt, status: 409 });
          expect(response.json()).toMatchObject(lineageRefusal);
          expect(sessionRows()).toEqual(rowsBefore);
          expect(await transcripts()).toEqual(filesBefore);
          expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
          expect(await resolveSession(parentId)).toMatchObject({ success: true });
        }
      });

      it('rolls back while the running parent is the confirmed replacement', async () => {
        seedSession({ id: parentId, status: 'running', nativeId: uuid(1211), tmuxName: 'parent' });

        const response = await rollback({ keepCurrent: false, replaceRunningSessionId: parentId });

        expect(response.statusCode).toBe(201);
        expect(row(parentId)).toMatchObject({ status: 'stopped' });
        expect(row(sessionId)).toMatchObject({ status: 'running' });
        expect(await resolveSession(parentId)).toMatchObject({ success: true });
      });

      // The spy starts the parent after the copies and before the commit transaction.
      it.each([false, true])(
        'refuses the commit when the parent starts after the checks and discards every copy (keepCurrent %s)',
        async (keepCurrent) => {
          seedSession({ id: parentId, status: 'stopped', nativeId: uuid(1211) });
          setLineage(parentId, [], familyAgentId);
          const store = app.get(SessionRowStore);
          const commit = store.commitRollback.bind(store);
          const copiesAtCommit: string[] = [];
          jest.spyOn(store, 'commitRollback').mockImplementationOnce(async (input) => {
            copiesAtCommit.push(...(await transcripts()));
            sqlite.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(parentId);
            return commit(input);
          });
          const filesBefore = await transcripts();

          const response = await rollback({ keepCurrent });

          expect(response.statusCode).toBe(409);
          expect(response.json()).toMatchObject(lineageRefusal);
          // The fork copy, and with keepCurrent the record copy, existed when the commit refused.
          expect(copiesAtCommit).toHaveLength(filesBefore.length + (keepCurrent ? 2 : 1));
          expect(await transcripts()).toEqual(filesBefore);
          expect(row(beforeRollbackRecordId(sessionId))).toBeUndefined();
          expect(row(sessionId)).toMatchObject({
            status: 'stopped',
            provider_session_id: currentNativeId,
          });
          expect(mockTerminalIO.createEmptySession).not.toHaveBeenCalled();
          expect(await resolveSession(parentId)).toMatchObject({ success: true });
        },
      );
    });

    async function expectAtSavePoint() {
      const session = row(sessionId)!;
      expect(session).toMatchObject({
        id: sessionId,
        status: 'running',
        name: 'Kept name',
        epic_id: null,
        inherited_session_ids: JSON.stringify(inherited),
        activity_state: null,
        busy_since: null,
        size_bytes: null,
      });
      const nativeId = session.provider_session_id!;
      expect([currentNativeId, savePointNativeId, sessionId]).not.toContain(nativeId);
      expect(session.transcript_path).toBe(join(transcriptDir, `${nativeId}.jsonl`));
      expect(await readFile(session.transcript_path!, 'utf8')).toBe(
        transcript(nativeId, 'saved turn'),
      );
      return nativeId;
    }

    // HTTP and SQLite show that the row keeps its identity and moves to a copy of the save point.
    it('rolls back a stopped session, then the running busy session, on the same row', async () => {
      const savePoint = row(savePointId);

      const first = await rollback({ keepCurrent: false });

      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ id: sessionId, status: 'running' });
      const firstCopy = await expectAtSavePoint();
      expect(row(savePointId)).toEqual(savePoint);
      expect(await readFile(savePointPath, 'utf8')).toBe(
        transcript(savePointNativeId, 'saved turn'),
      );
      expect(await readFile(currentPath, 'utf8')).toBe(transcript(currentNativeId, 'current turn'));

      sqlite
        .prepare("UPDATE sessions SET activity_state = 'busy', busy_since = ? WHERE id = ?")
        .run(LATER, sessionId);
      const second = await rollback({ keepCurrent: false, replaceRunningSessionId: sessionId });

      expect(second.statusCode).toBe(201);
      expect(mockTerminalIO.destroyExpectedSession).toHaveBeenCalledTimes(1);
      expect(await expectAtSavePoint()).not.toBe(firstCopy);
      expect(children(sessionId)).toEqual([{ id: savePointId }]);
    });

    // HTTP and SQLite show the one-record rule and the in-place update that keeps forks attached.
    it('keeps one Before rollback record per session and replaces it only with keepCurrent', async () => {
      const recordId = beforeRollbackRecordId(sessionId);
      const forkOfRecord = uuid(86);

      expect((await rollback({ keepCurrent: true })).statusCode).toBe(201);

      const record = row(recordId)!;
      expect(record).toMatchObject({
        kind: 'save_point',
        status: 'stopped',
        parent_session_id: sessionId,
        name: null,
        inherited_session_ids: JSON.stringify([...inherited, sessionId]),
      });
      expect(record.provider_session_id).not.toBe(currentNativeId);
      expect(await readFile(record.transcript_path!, 'utf8')).toBe(
        transcript(record.provider_session_id!, 'current turn'),
      );
      seedSession({ id: forkOfRecord, status: 'stopped', parentId: recordId });
      sqlite
        .prepare('UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = ?')
        .run(NOW, NOW, recordId);

      const replaced = await rollback({ keepCurrent: true, replaceRunningSessionId: sessionId });

      expect(replaced.statusCode).toBe(201);
      const updated = row(recordId)!;
      expect(updated.provider_session_id).not.toBe(record.provider_session_id);
      expect(updated.started_at).not.toBe(NOW);
      expect(updated.ended_at).not.toBe(NOW);
      expect(await readFile(updated.transcript_path!, 'utf8')).toBe(
        transcript(updated.provider_session_id!, 'saved turn'),
      );
      expect(row(forkOfRecord)).toMatchObject({ parent_session_id: recordId });

      const kept = await rollback({ keepCurrent: false, replaceRunningSessionId: sessionId });

      expect(kept.statusCode).toBe(201);
      expect(row(recordId)).toEqual(updated);
      expect(children(sessionId)).toEqual(
        [{ id: savePointId }, { id: recordId }].sort((a, b) => a.id.localeCompare(b.id)),
      );
    });

    // HTTP and SQLite show which running session a confirmed replacement stops.
    it('stops a different running session only when it is the confirmed replacement', async () => {
      seedSession({
        id: otherId,
        status: 'running',
        nativeId: uuid(87),
        path: currentPath,
        tmuxName: 'other',
      });

      const stale = await rollback({ keepCurrent: false, replaceRunningSessionId: uuid(88) });

      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ details: { code: 'RUNNING_SESSION_CHANGED' } });
      expect(row(otherId)).toMatchObject({ status: 'running' });
      expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();

      const confirmed = await rollback({ keepCurrent: false, replaceRunningSessionId: otherId });

      expect(confirmed.statusCode).toBe(201);
      expect(row(otherId)).toMatchObject({ status: 'stopped' });
      await expectAtSavePoint();
      const restored = await inject().inject({
        method: 'POST',
        url: `/api/sessions/${otherId}/restore`,
        payload: { projectId, replaceRunningSessionId: sessionId },
      });
      expect(restored.statusCode).toBe(201);
    });

    it('keeps the replacement running when the project freezes during the provider lookup of a rollback', async () => {
      seedSession({ id: otherId, status: 'running', nativeId: uuid(87), tmuxName: 'other' });
      const thaw = freezeDuringFirst(app.get(STORAGE_SERVICE), 'getProvider');
      try {
        const response = await rollback({ keepCurrent: false, replaceRunningSessionId: otherId });

        expect(response.statusCode).toBe(423);
        expect(response.json()).toMatchObject({ code: 'PROJECT_FROZEN' });
        expect(row(otherId)).toMatchObject({ status: 'running', tmux_session_id: 'other' });
        expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
      } finally {
        thaw();
      }
    });

    // HTTP, SQLite, and the terminal boundary show that preflight refusals have no side effects.
    it.each([
      { code: 'SAVE_POINT_NOT_OF_SESSION', status: 409, foreign: true },
      { code: 'SAVE_POINTS_TEAM_MEMBER', status: 409, member: true },
      { code: 'validation_error', status: 400, missing: 'save point' },
      { code: 'validation_error', status: 400, missing: 'current', keepCurrent: true },
    ])(
      'refuses $code ($missing) before it stops the running session',
      async ({ code, status, foreign, member, missing, keepCurrent = false }) => {
        seedSession({ id: otherId, status: 'running', nativeId: uuid(87), tmuxName: 'other' });
        const foreignSavePoint = uuid(89);
        if (foreign) {
          seedSession({
            id: foreignSavePoint,
            kind: 'save_point',
            status: 'stopped',
            parentId: otherId,
            nativeId: savePointNativeId,
            path: savePointPath,
          });
        }
        if (member) addTeamMembership(uuid(90), false);
        if (missing) await rm(missing === 'current' ? currentPath : savePointPath);
        const session = row(sessionId);

        const response = await rollback({
          keepCurrent,
          replaceRunningSessionId: otherId,
          ...(foreign && { savePointId: foreignSavePoint }),
        });

        expect(response.statusCode).toBe(status);
        expect(response.json()).toMatchObject(status === 409 ? { details: { code } } : { code });
        expect(row(otherId)).toMatchObject({ status: 'running' });
        expect(row(sessionId)).toEqual(session);
        expect(row(beforeRollbackRecordId(sessionId))).toBeUndefined();
        expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
      },
    );
  });

  // HTTP, SQLite and the terminal boundary show which stops the expected owner lets through.
  it('DELETE /api/sessions/:id stops nothing for another expected owner and follows the owner without one', async () => {
    const running = uuid(91);
    seedSession({ id: running, status: 'running', nativeId: uuid(92), tmuxName: 'running' });
    const stop = (query = '') =>
      inject().inject({ method: 'DELETE', url: `/api/sessions/${running}${query}` });

    expect((await stop('?expectedAgentId=not-a-uuid')).statusCode).toBe(400);
    expect((await stop(`?expectedAgentId=${uuid(93)}`)).statusCode).toBe(200);
    expect(sessionStatus(running)).toBe('running');
    expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();

    expect((await stop()).statusCode).toBe(200);
    expect(sessionStatus(running)).toBe('stopped');
  });

  describe('restart while the project freezes', () => {
    const runningId = uuid(95);

    afterEach(() => {
      jest.restoreAllMocks();
    });

    // Each restart reads the running session, then stops it: the freeze lands between the two.
    it.each([
      {
        path: 'web',
        run: async () => {
          const response = await inject().inject({
            method: 'POST',
            url: `/api/agents/${agentId}/restart`,
            payload: { projectId },
          });
          return { status: response.statusCode, code: response.json<{ code: string }>().code };
        },
        expected: { status: 423, code: 'PROJECT_FROZEN' },
      },
      {
        path: 'team (lifecycle facade)',
        run: async () => {
          const error = await app
            .get(SessionLifecycleFacade)
            .restart(agentId, projectId, { source: 'team-management' })
            .catch((caught: { statusCode: number; code: string }) => caught);
          return {
            status: (error as { statusCode: number }).statusCode,
            code: (error as { code: string }).code,
          };
        },
        expected: { status: 423, code: 'PROJECT_FROZEN' },
      },
      {
        path: 'phone',
        run: async () => {
          const phone = app.get(MobileChatRpcService);
          const { operationId } = await phone.restartAgent({ agentId, projectId });
          let operation = await phone.getOperationStatus({ operationId, projectId });
          for (let attempt = 0; operation?.status === 'running' && attempt < 1000; attempt += 1) {
            await new Promise((resolve) => setImmediate(resolve));
            operation = await phone.getOperationStatus({ operationId, projectId });
          }
          return { status: operation?.status, code: operation?.errorCode };
        },
        expected: { status: 'failed', code: 'PROJECT_FROZEN' },
      },
    ])(
      '$path restart refuses as frozen and keeps the running session',
      async ({ run, expected }) => {
        seedSession({
          id: runningId,
          status: 'running',
          nativeId: uuid(96),
          tmuxName: 'restart-me',
        });
        const thaw = freezeDuringFirst(app.get(SessionsService), 'listActiveSessions');
        try {
          await expect(run()).resolves.toEqual(expected);
          expect(sessionStatus(runningId)).toBe('running');
          expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
          expect(mockTerminalIO.createEmptySession).not.toHaveBeenCalled();
        } finally {
          thaw();
        }
      },
    );
  });

  describe('restart with an inaccessible provider binary', () => {
    // The real preflight runs `access` on the configured path, so the check is not faked.
    it('POST /api/agents/:id/restart refuses before the stop and leaves the session running', async () => {
      const runningId = uuid(97);
      seedSession({
        id: runningId,
        status: 'running',
        nativeId: uuid(98),
        tmuxName: 'restart-me',
      });
      sqlite
        .prepare('UPDATE providers SET bin_path = ? WHERE id = ?')
        .run(join(rootDir, 'missing', 'claude'), providerId);

      // The suite skips preflight; this test needs the real binary check.
      process.env.SKIP_PREFLIGHT = '0';
      let response: Awaited<ReturnType<ReturnType<typeof inject>['inject']>>;
      try {
        response = await inject().inject({
          method: 'POST',
          url: `/api/agents/${agentId}/restart`,
          payload: { projectId },
        });
      } finally {
        process.env.SKIP_PREFLIGHT = '1';
      }

      expect(response.statusCode).toBe(400);
      expect(response.json<{ message: string }>().message).toContain('failed the binary check');
      expect(sessionStatus(runningId)).toBe('running');
      expect(mockTerminalIO.destroyExpectedSession).not.toHaveBeenCalled();
      expect(mockTerminalIO.createEmptySession).not.toHaveBeenCalled();
    }, 20_000);
  });

  describe('GET /api/sessions/agents/:agentId/tree', () => {
    it('pages roots and keeps running and stopped sessions and deep descendants in their root page', async () => {
      const latest = '2026-01-02T00:00:00.000Z';
      const running = uuid(51);
      const tiedRoot = uuid(52);
      const firstRoot = uuid(53);
      const saved = uuid(54);
      const fork = uuid(55);
      const openCodeSessions = [uuid(56), uuid(57)];
      seedSession({ id: running, status: 'running' });
      // A stored size of NULL with a readable transcript: the tree reports the file size.
      const transcript = join(rootDir, 'tree-size.jsonl');
      await writeFile(transcript, '{"type":"user"}\n');
      seedSession({ id: tiedRoot, status: 'stopped', lastActivityAt: latest, path: transcript });
      seedSession({
        id: firstRoot,
        status: 'stopped',
        endedAt: latest,
        path: transcript,
        providerName: 'unknown',
      });
      seedSession({ id: saved, status: 'stopped', kind: 'save_point', parentId: firstRoot });
      seedSession({
        id: fork,
        status: 'stopped',
        parentId: saved,
        path: transcript,
        providerName: null,
      });
      const sharedDatabase = join(rootDir, PROVIDER_ROOTS.opencode[0], 'opencode.db');
      await mkdir(dirname(sharedDatabase), { recursive: true });
      await writeFile(sharedDatabase, 'shared transcript container');
      for (const id of openCodeSessions) {
        seedSession({
          id,
          status: 'stopped',
          parentId: firstRoot,
          nativeId: `ses_${id}`,
          path: sharedDatabase,
          providerName: 'opencode',
        });
      }

      const fetchPage = async (cursor?: string | null) => {
        const response = await inject().inject({
          url: `${treeUrl}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        });
        expect(response.statusCode).toBe(200);
        return response.json<SessionTreeResponseDto>();
      };

      const first = await fetchPage();
      expect(first).toMatchObject({
        total: 3,
        hasMore: true,
        nextCursor: expect.any(String),
        savePoints: { available: true },
      });
      expect(
        first.items.map(({ id, kind, parentSessionId, status }) => [
          id,
          kind,
          parentSessionId,
          status,
        ]),
      ).toEqual([
        [firstRoot, 'session', null, 'stopped'],
        [openCodeSessions[1], 'session', firstRoot, 'stopped'],
        [openCodeSessions[0], 'session', firstRoot, 'stopped'],
        [saved, 'save_point', firstRoot, 'stopped'],
        [fork, 'session', saved, 'stopped'],
      ]);
      expect(first.items).toEqual(
        expect.arrayContaining(
          [firstRoot, fork, ...openCodeSessions].map((id) =>
            expect.objectContaining({ id, sizeBytes: null }),
          ),
        ),
      );
      const second = await fetchPage(first.nextCursor);
      expect(second).toMatchObject({
        total: 3,
        hasMore: true,
        nextCursor: expect.any(String),
        items: [{ id: tiedRoot, sizeBytes: 16 }],
      });
      const last = await fetchPage(second.nextCursor);
      expect(last).toMatchObject({
        total: 3,
        hasMore: false,
        nextCursor: null,
        items: [{ id: running, status: 'running', kind: 'session', parentSessionId: null }],
      });
    });

    it.each([
      {
        state: 'team member',
        teamRole: 'member',
        expected: { available: false, reason: 'TEAM_MEMBER' },
      },
      {
        state: 'team member with an unsupported provider',
        teamRole: 'member',
        unsupported: true,
        expected: { available: false, reason: 'TEAM_MEMBER' },
      },
      {
        state: 'team lead who also belongs to another team',
        teamRole: 'lead',
        expected: { available: true },
      },
    ])(
      'reports save-point availability for a $state',
      async ({ teamRole, unsupported, expected }) => {
        const mockAdapter = unsupported
          ? jest
              .spyOn(app.get(ProviderAdapterFactory), 'getAdapter')
              .mockReturnValue(adapterWithoutFork)
          : undefined;
        if (teamRole) {
          addTeamMembership(uuid(61), false);
          if (teamRole === 'lead') addTeamMembership(uuid(62), true);
        }
        try {
          const response = await inject().inject({ url: treeUrl });
          expect(response.statusCode).toBe(200);
          expect(response.json<SessionTreeResponseDto>().savePoints).toEqual(expected);
        } finally {
          mockAdapter?.mockRestore();
        }
      },
    );

    // SQLite rows and HTTP show that only the derived record ID marks a Before rollback node.
    it('marks only the save point with the derived ID as beforeRollback', async () => {
      const root = uuid(64);
      const record = beforeRollbackRecordId(root);
      seedSession({ id: root, status: 'stopped' });
      seedSession({ id: uuid(65), kind: 'save_point', status: 'stopped', parentId: root });
      seedSession({ id: record, kind: 'save_point', status: 'stopped', parentId: root });
      seedSession({ id: uuid(66), status: 'stopped', parentId: record });

      const response = await inject().inject({ url: treeUrl });

      expect(response.statusCode).toBe(200);
      const marked = response
        .json<SessionTreeResponseDto>()
        .items.filter((node) => node.beforeRollback)
        .map((node) => node.id);
      expect(marked).toEqual([record]);
    });

    it('uses the same project-mismatch error as flat history', async () => {
      const response = await inject().inject({ url: treeUrl.replace(projectId, uuid(63)) });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ message: 'PROJECT_MISMATCH' });
    });
  });
});
