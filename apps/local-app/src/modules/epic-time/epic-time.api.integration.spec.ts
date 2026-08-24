import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { DB_CONNECTION } from '../storage/db/db.provider';
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
        agent_name_snapshot TEXT NOT NULL, duration_ms INTEGER NOT NULL,
        last_activity_at TEXT NOT NULL, closed_at TEXT, updated_at TEXT NOT NULL
      );
      INSERT INTO epics (id, project_id, title, parent_id) VALUES
        ('${ROOT_ID}', 'project-1', 'Root task', NULL),
        ('${CHILD_ID}', 'project-1', 'Child task', '${ROOT_ID}');
      INSERT INTO epic_time_segments
        (id, project_id, epic_id, agent_id_snapshot, agent_name_snapshot, duration_ms,
         last_activity_at, closed_at, updated_at)
      VALUES
        ('direct', 'project-1', '${ROOT_ID}', 'agent-1', 'Coder', 30000,
         '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
         '2026-01-02T00:00:00.000Z'),
        ('child', 'project-1', '${CHILD_ID}', 'agent-1', 'Coder', 30000,
         '2026-01-02T00:01:00.000Z', '2026-01-02T00:01:00.000Z',
         '2026-01-02T00:01:00.000Z'),
        ('open', 'project-1', '${ROOT_ID}', 'agent-1', 'Coder', 60000,
         '2026-01-02T00:02:00.000Z', NULL, '2026-01-02T00:02:00.000Z');
    `);
    moduleRef = await Test.createTestingModule({
      controllers: [EpicTimeController],
      providers: [
        EpicTimeStore,
        EpicTimeService,
        { provide: DB_CONNECTION, useValue: drizzle(sqlite) },
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
      directMinutes: 0,
      totalMinutes: 1,
      items: [
        {
          activityDate: '2026-01-02',
          agentId: 'agent-1',
          agentName: 'Coder',
          minutes: 1,
        },
      ],
      taskItems: [
        {
          epicId: ROOT_ID,
          epicTitle: 'Root task',
          isDirect: true,
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
    expect(batch.json()).toEqual({ items: [{ epicId: ROOT_ID, totalMinutes: 1 }] });
  });

  it('maps invalid timezone, missing detail, and child batch validation safely', async () => {
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

    const childBatch = await app.inject({
      method: 'POST',
      url: '/api/epics/time-summary/batch',
      payload: { epicIds: [CHILD_ID], timeZone: 'UTC' },
    });
    expect(childBatch.statusCode).toBe(400);
    expect(childBatch.json()).toMatchObject({
      code: 'validation_error',
      details: { invalidCount: 1, invalidEpicIds: [CHILD_ID] },
    });
  });
});
