import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { EventsService } from '../events/services/events.service';
import { EpicTimeController } from './controllers/epic-time.controller';
import { EpicTimeService } from './services/epic-time.service';
import { EpicTimeStore } from './services/epic-time.store';

const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const CHILD_ID = '22222222-2222-4222-8222-222222222222';

// Layer: backend API integration. A small Fastify/Nest boundary is the cheapest
// proof that real routes and global error mapping expose the intended contract.
describe('Epic time summary API', () => {
  let sqlite: Database.Database;
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE epics (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, parent_id TEXT
      );
      CREATE TABLE epic_time_segments (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, epic_id TEXT,
        agent_id_snapshot TEXT NOT NULL,
        agent_name_snapshot TEXT NOT NULL,
        attribution_source TEXT NOT NULL DEFAULT 'direct',
        team_id_snapshot TEXT, team_name_snapshot TEXT,
        duration_ms INTEGER NOT NULL,
        last_activity_at TEXT NOT NULL, closed_at TEXT, updated_at TEXT NOT NULL
      );
      -- Minimal route-resolver tables: the resolved-scope statement reads them
      -- even when no routes exist.
      CREATE TABLE epic_relations (
        id TEXT PRIMARY KEY,
        left_epic_id TEXT NOT NULL,
        right_epic_id TEXT NOT NULL,
        type TEXT NOT NULL,
        direction TEXT NOT NULL
      );
      CREATE TABLE external_task_links (
        id TEXT PRIMARY KEY,
        epic_id TEXT NOT NULL
      );
      INSERT INTO epics (id, project_id, title, parent_id) VALUES
        ('${ROOT_ID}', 'project-1', 'Root task', NULL),
        ('${CHILD_ID}', 'project-1', 'Child task', '${ROOT_ID}');
      INSERT INTO epic_time_segments
        (id, project_id, epic_id, agent_id_snapshot, agent_name_snapshot,
         attribution_source, team_id_snapshot, team_name_snapshot, duration_ms,
         last_activity_at, closed_at, updated_at)
      VALUES
        ('direct', 'project-1', '${ROOT_ID}', 'agent-1', 'Coder',
         'direct', NULL, NULL, 60000,
         '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
         '2026-01-02T00:00:00.000Z'),
        ('child', 'project-1', '${CHILD_ID}', 'agent-1', 'Coder',
         'direct', NULL, NULL, 60000,
         '2026-01-02T00:01:00.000Z', '2026-01-02T00:01:00.000Z',
         '2026-01-02T00:01:00.000Z'),
        ('team', 'project-1', '${ROOT_ID}', 'agent-1', 'Coder',
         'team', 'team-1', 'Builders', 60000,
         '2026-01-02T00:02:00.000Z', '2026-01-02T00:02:00.000Z',
         '2026-01-02T00:02:00.000Z'),
        ('open', 'project-1', '${ROOT_ID}', 'agent-1', 'Coder',
         'direct', NULL, NULL, 60000,
         '2026-01-02T00:02:00.000Z', NULL, '2026-01-02T00:02:00.000Z');
    `);
    moduleRef = await Test.createTestingModule({
      controllers: [EpicTimeController],
      providers: [
        EpicTimeStore,
        EpicTimeService,
        { provide: DB_CONNECTION, useValue: drizzle(sqlite) },
        { provide: EventsService, useValue: { publish: jest.fn().mockResolvedValue(null) } },
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

  it('serves equal root detail and batch totals while excluding open segments', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/epics/${ROOT_ID}/time-logs?timeZone=UTC`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({
      isRoot: true,
      directMinutes: 2,
      totalMinutes: 3,
      includesRelatedTime: false,
      items: [
        {
          activityDate: '2026-01-02',
          agentId: 'agent-1',
          agentName: 'Coder',
          attributionSource: 'direct',
          teamId: null,
          teamName: null,
          minutes: 2,
        },
        {
          activityDate: '2026-01-02',
          agentId: 'agent-1',
          agentName: 'Coder',
          attributionSource: 'team',
          teamId: 'team-1',
          teamName: 'Builders',
          minutes: 1,
        },
      ],
      taskItems: [
        {
          epicId: ROOT_ID,
          epicTitle: 'Root task',
          groupEpicId: ROOT_ID,
          groupEpicTitle: 'Root task',
          isDirect: true,
          minutes: 2,
        },
        {
          epicId: CHILD_ID,
          epicTitle: 'Child task',
          groupEpicId: ROOT_ID,
          groupEpicTitle: 'Root task',
          isDirect: false,
          minutes: 1,
        },
      ],
    });

    const batch = await app.inject({
      method: 'POST',
      url: '/api/epics/time-summary/batch',
      payload: { epicIds: [ROOT_ID], timeZone: 'UTC' },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toEqual({ items: [{ epicId: ROOT_ID, totalMinutes: 3 }] });
  });

  it('serves mixed root and child batch totals that agree with detail', async () => {
    const childDetail = await app.inject({
      method: 'GET',
      url: `/api/epics/${CHILD_ID}/time-logs?timeZone=UTC`,
    });
    expect(childDetail.statusCode).toBe(200);
    expect(childDetail.json().totalMinutes).toBe(1);

    const batch = await app.inject({
      method: 'POST',
      url: '/api/epics/time-summary/batch',
      payload: { epicIds: [CHILD_ID, ROOT_ID], timeZone: 'UTC' },
    });
    expect(batch.statusCode).toBe(200);
    // The child focal stays self-only inside the same response that rolls
    // its minutes up under the root focal.
    expect(batch.json()).toEqual({
      items: [
        { epicId: CHILD_ID, totalMinutes: 1 },
        { epicId: ROOT_ID, totalMinutes: 3 },
      ],
    });
  });

  it('maps invalid timezone, missing detail, and missing batch validation safely', async () => {
    const invalidZone = await app.inject({
      method: 'GET',
      url: `/api/epics/${ROOT_ID}/time-logs?timeZone=Not%2FAZone`,
    });
    expect(invalidZone.statusCode).toBe(400);
    expect(invalidZone.json()).toMatchObject({ code: 'validation_error' });

    const missing = await app.inject({
      method: 'GET',
      url: '/api/epics/33333333-3333-4333-8333-333333333333/time-logs?timeZone=UTC',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'not_found' });

    const missingBatch = await app.inject({
      method: 'POST',
      url: '/api/epics/time-summary/batch',
      payload: {
        epicIds: [CHILD_ID, '33333333-3333-4333-8333-333333333333'],
        timeZone: 'UTC',
      },
    });
    expect(missingBatch.statusCode).toBe(400);
    expect(missingBatch.json()).toMatchObject({
      code: 'validation_error',
      details: { invalidCount: 1, invalidEpicIds: ['33333333-3333-4333-8333-333333333333'] },
    });
  });
});
