import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'node:path';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { EventsService } from '../events/services/events.service';
import { AgentTimeBufferController } from './controllers/agent-time-buffer.controller';
import { EpicTimeService } from './services/epic-time.service';
import { EpicTimeStore } from './services/epic-time.store';

const MIGRATIONS_FOLDER = join(__dirname, '../../../drizzle');
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '99999999-9999-4999-8999-999999999999';
const WORKSPACE_ID = '0defa017-0000-4000-8000-000000000001';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_AGENT_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_EPIC_ID = '44444444-4444-4444-8444-444444444444';
const FOREIGN_EPIC_ID = '55555555-5555-4555-8555-555555555555';

interface BufferItem {
  agentId: string;
  snapshotToken: string;
  minutes: number;
  durationMs: number;
  segmentCount: number;
  oldestActivityAt: string;
  newestActivityAt: string;
}

// Layer: backend API integration over the real migrated schema. Fastify plus
// foreign_keys=ON is the cheapest proof that the routes, the snapshot fence,
// and the post-commit hint wiring hold end to end.
describe('Agent time buffer assignment API', () => {
  let sqlite: Database.Database;
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let events: { publish: jest.Mock };
  let targetStatusId: string;
  let foreignStatusId: string;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    targetStatusId = seedProject(PROJECT_ID, WORKSPACE_ID);
    foreignStatusId = seedProject(OTHER_PROJECT_ID, '0defa017-0000-4000-8000-000000000002');
    seedAgent(AGENT_ID, 'Coder');
    seedAgent(OTHER_AGENT_ID, 'Reviewer');
    seedEpic(TARGET_EPIC_ID, PROJECT_ID, targetStatusId);
    seedEpic(FOREIGN_EPIC_ID, OTHER_PROJECT_ID, foreignStatusId);
    insertSegment(
      'buf-a',
      AGENT_ID,
      '2026-01-02T00:10:00.000Z',
      '2026-01-02T00:11:30.000Z',
      90_000,
    );
    insertSegment(
      'buf-b',
      AGENT_ID,
      '2026-01-02T00:20:00.000Z',
      '2026-01-02T00:20:30.000Z',
      30_000,
    );
    insertSegment(
      'buf-other',
      OTHER_AGENT_ID,
      '2026-01-02T00:15:00.000Z',
      '2026-01-02T00:15:00.000Z',
      60_000,
    );

    events = { publish: jest.fn().mockResolvedValue(null) };
    moduleRef = await Test.createTestingModule({
      controllers: [AgentTimeBufferController],
      providers: [
        EpicTimeStore,
        EpicTimeService,
        { provide: DB_CONNECTION, useValue: drizzle(sqlite) },
        { provide: EventsService, useValue: events },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    await moduleRef.close();
    sqlite.close();
  });

  function seedProject(id: string, workspaceId: string): string {
    const statusId = `status-${id}`;
    sqlite
      .prepare(
        `INSERT INTO projects
           (id, workspace_id, name, root_path, is_template, created_at, updated_at)
         VALUES (?, ?, ?, '/tmp/project', 0,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, workspaceId, id);
    sqlite
      .prepare(
        `INSERT INTO statuses
           (id, project_id, label, color, position, created_at, updated_at)
         VALUES (?, ?, 'New', '#fff', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(statusId, id);
    return statusId;
  }

  function seedAgent(id: string, name: string): void {
    const createdAt = '2026-01-01T00:00:00.000Z';
    sqlite
      .prepare(
        `INSERT INTO providers (id, name, mcp_configured, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?)`,
      )
      .run(`provider-${id}`, name, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(`profile-${id}`, PROJECT_ID, name, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO profile_provider_configs
           (id, profile_id, provider_id, name, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(`config-${id}`, `profile-${id}`, `provider-${id}`, name, createdAt, createdAt);
    sqlite
      .prepare(
        `INSERT INTO agents
           (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, PROJECT_ID, `profile-${id}`, `config-${id}`, name, createdAt, createdAt);
  }

  function seedEpic(id: string, projectId: string, statusId: string): void {
    sqlite
      .prepare(
        `INSERT INTO epics
           (id, project_id, title, status_id, agent_id, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(id, projectId, id, statusId);
  }

  function insertSegment(
    id: string,
    agentId: string,
    startedAt: string,
    lastActivityAt: string,
    durationMs: number,
    closedAt: string | null = lastActivityAt,
  ): void {
    sqlite
      .prepare(
        `INSERT INTO epic_time_segments
           (id, project_id, epic_id, session_id_snapshot, agent_id_snapshot,
            agent_name_snapshot, started_at, last_activity_at, closed_at,
            duration_ms, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        PROJECT_ID,
        `session-${id}`,
        agentId,
        'Coder',
        startedAt,
        lastActivityAt,
        closedAt,
        durationMs,
        lastActivityAt,
        lastActivityAt,
      );
  }

  function segmentRows(): Array<Record<string, unknown>> {
    return sqlite
      .prepare(`SELECT id, epic_id, updated_at FROM epic_time_segments ORDER BY id`)
      .all() as Array<Record<string, unknown>>;
  }

  it('serves the snapshot read and completes the fenced assignment over HTTP', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/api/agent-time-buffers?projectId=${PROJECT_ID}`,
    });
    expect(read.statusCode).toBe(200);
    const snapshot = read.json() as { capturedAt: string; items: BufferItem[] };
    expect(snapshot.capturedAt).toBe('2026-01-02T00:20:30.000Z');
    expect(snapshot.items).toHaveLength(2);
    const item = snapshot.items.find((entry) => entry.agentId === AGENT_ID)!;
    expect(item).toMatchObject({ minutes: 2, durationMs: 120_000, segmentCount: 2 });

    const assigned = await app.inject({
      method: 'POST',
      url: `/api/agent-time-buffers/${AGENT_ID}/assign`,
      payload: {
        projectId: PROJECT_ID,
        targetEpicId: TARGET_EPIC_ID,
        capturedAt: snapshot.capturedAt,
        snapshotToken: item.snapshotToken,
      },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toEqual({ workspaceId: WORKSPACE_ID });

    expect(segmentRows()).toEqual([
      expect.objectContaining({ id: 'buf-a', epic_id: TARGET_EPIC_ID }),
      expect.objectContaining({ id: 'buf-b', epic_id: TARGET_EPIC_ID }),
      expect.objectContaining({ id: 'buf-other', epic_id: null }),
    ]);
    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith('epic.time.scope.invalidated', {
      workspaceId: WORKSPACE_ID,
    });

    const replay = await app.inject({
      method: 'POST',
      url: `/api/agent-time-buffers/${AGENT_ID}/assign`,
      payload: {
        projectId: PROJECT_ID,
        targetEpicId: TARGET_EPIC_ID,
        capturedAt: snapshot.capturedAt,
        snapshotToken: item.snapshotToken,
      },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: 'conflict' });
    expect(events.publish).toHaveBeenCalledTimes(1);
  });

  it('maps validation and not-found failures to typed errors', async () => {
    const read = await app.inject({ method: 'GET', url: '/api/agent-time-buffers' });
    expect(read.statusCode).toBe(400);
    expect(read.json()).toMatchObject({ code: 'validation_error' });

    const extraField = await app.inject({
      method: 'POST',
      url: `/api/agent-time-buffers/${AGENT_ID}/assign`,
      payload: {
        projectId: PROJECT_ID,
        targetEpicId: TARGET_EPIC_ID,
        capturedAt: '2026-01-02T00:20:30.000Z',
        snapshotToken: 'a'.repeat(64),
        unexpected: true,
      },
    });
    expect(extraField.statusCode).toBe(400);
    expect(extraField.json()).toMatchObject({ code: 'validation_error' });

    const foreignTarget = await app.inject({
      method: 'POST',
      url: `/api/agent-time-buffers/${AGENT_ID}/assign`,
      payload: {
        projectId: PROJECT_ID,
        targetEpicId: FOREIGN_EPIC_ID,
        capturedAt: '2026-01-02T00:20:30.000Z',
        snapshotToken: 'a'.repeat(64),
      },
    });
    expect(foreignTarget.statusCode).toBe(404);
    expect(foreignTarget.json()).toMatchObject({ code: 'not_found' });
    expect(events.publish).not.toHaveBeenCalled();
  });
});
