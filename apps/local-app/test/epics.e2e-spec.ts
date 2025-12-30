import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import Database from 'better-sqlite3';
import { AppModule } from '../src/app.module';
import {
  setupTestDb,
  teardownTestDb,
  resetTestDb,
  seedTestData,
  getTestDbPath,
} from './helpers/test-db';

process.env.SKIP_PREFLIGHT = '1';

describe('Epics API hierarchy and comments', () => {
  let app: NestFastifyApplication;
  let projectId: string;
  let statusId: string;

  const seedAgents = (projectId: string, agentProfileId: string) => {
    const dbPath = getTestDbPath();
    if (!dbPath) {
      throw new Error('Test database not initialized');
    }

    const sqlite = new Database(dbPath);
    const now = new Date().toISOString();

    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('agent-1', projectId, agentProfileId, 'Helper Bot', now, now);

    sqlite.close();
  };

  beforeAll(async () => {
    setupTestDb();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    teardownTestDb();
  });

  beforeEach(() => {
    resetTestDb();
    const fixtures = seedTestData();
    projectId = fixtures.projectId;
    statusId = fixtures.statusId;
    seedAgents(projectId, fixtures.agentProfileId);
  });

  it('supports creating hierarchy, counting sub-epics, and managing comments', async () => {
    const parentResponse = await app.inject({
      method: 'POST',
      url: '/api/epics',
      payload: {
        projectId,
        statusId,
        title: 'Parent Epic',
        description: 'Top level work',
        tags: ['roadmap'],
      },
    });

    if (parentResponse.statusCode !== 201) {
      // eslint-disable-next-line no-console
      console.error('Parent epic create failed', parentResponse.payload);
    }

    expect(parentResponse.statusCode).toBe(201);
    const parentEpic = JSON.parse(parentResponse.payload);

    const childResponse = await app.inject({
      method: 'POST',
      url: '/api/epics',
      payload: {
        projectId,
        statusId,
        title: 'Child Epic',
        parentId: parentEpic.id,
      },
    });

    expect(childResponse.statusCode).toBe(201);
    const childEpic = JSON.parse(childResponse.payload);
    expect(childEpic.parentId).toBe(parentEpic.id);

    const subEpicsResponse = await app.inject({
      method: 'GET',
      url: `/api/epics?parentId=${parentEpic.id}`,
    });

    expect(subEpicsResponse.statusCode).toBe(200);
    const subEpicsPayload = JSON.parse(subEpicsResponse.payload);
    expect(subEpicsPayload.items).toHaveLength(1);

    const countsResponse = await app.inject({
      method: 'GET',
      url: `/api/epics/${parentEpic.id}/sub-epics/counts`,
    });

    expect(countsResponse.statusCode).toBe(200);
    const countsPayload = JSON.parse(countsResponse.payload);
    expect(countsPayload[statusId]).toBe(1);

    const commentCreate = await app.inject({
      method: 'POST',
      url: `/api/epics/${parentEpic.id}/comments`,
      payload: { authorName: 'User', content: 'Great progress!' },
    });

    expect(commentCreate.statusCode).toBe(201);

    const commentsList = await app.inject({
      method: 'GET',
      url: `/api/epics/${parentEpic.id}/comments`,
    });

    expect(commentsList.statusCode).toBe(200);
    const commentsPayload = JSON.parse(commentsList.payload);
    expect(commentsPayload.items[0].content).toBe('Great progress!');
  });
});
