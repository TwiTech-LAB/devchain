import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import Database from 'better-sqlite3';
import { AppModule } from '../src/app.module';
import { setupTestDb, resetTestDb, teardownTestDb, getTestDbPath } from './helpers/test-db';

process.env.SKIP_PREFLIGHT = '1';

describe('Documents API', () => {
  let app: NestFastifyApplication;

  const seedProject = () => {
    const dbPath = getTestDbPath();
    if (!dbPath) {
      throw new Error('Test database not initialized');
    }

    const sqlite = new Database(dbPath);
    const now = new Date().toISOString();

    sqlite
      .prepare(
        `INSERT INTO projects (id, name, description, root_path, is_private, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('project-1', 'Project One', 'Test project', '/tmp/project-one', 0, now, now);

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
    seedProject();
  });

  it('creates, filters, retrieves, updates, and deletes documents', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: {
        projectId: 'project-1',
        title: 'Test Doc',
        slug: 'test-doc',
        contentMd: '# Hello\nThis is a test.',
        tags: ['docs', 'pinned'],
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const created = JSON.parse(createResponse.payload);
    expect(created.title).toBe('Test Doc');
    expect(created.slug).toBe('test-doc');
    expect(created.tags).toEqual(expect.arrayContaining(['docs', 'pinned']));

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/documents',
      query: { projectId: 'project-1' },
    });

    expect(listResponse.statusCode).toBe(200);
    const listPayload = JSON.parse(listResponse.payload);
    expect(listPayload.items).toHaveLength(1);
    expect(listPayload.items[0].title).toBe('Test Doc');

    const tagFiltered = await app.inject({
      method: 'GET',
      url: '/api/documents',
      query: { projectId: 'project-1', tag: 'docs' },
    });

    expect(tagFiltered.statusCode).toBe(200);
    const tagPayload = JSON.parse(tagFiltered.payload);
    expect(tagPayload.items).toHaveLength(1);

    const slugLookup = await app.inject({
      method: 'GET',
      url: '/api/documents/by-slug',
      query: { projectId: 'project-1', slug: 'test-doc' },
    });

    expect(slugLookup.statusCode).toBe(200);
    const slugPayload = JSON.parse(slugLookup.payload);
    expect(slugPayload.id).toBe(created.id);

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/documents/${created.id}`,
      payload: {
        title: 'Updated Doc',
        contentMd: '# Updated',
        tags: ['docs'],
        version: created.version,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updated = JSON.parse(updateResponse.payload);
    expect(updated.title).toBe('Updated Doc');
    expect(updated.tags).toEqual(['docs']);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${created.id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);

    const finalList = await app.inject({
      method: 'GET',
      url: '/api/documents',
      query: { projectId: 'project-1' },
    });

    const finalPayload = JSON.parse(finalList.payload);
    expect(finalPayload.items).toHaveLength(0);
  });
});
