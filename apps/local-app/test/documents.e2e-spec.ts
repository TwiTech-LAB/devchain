import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { setupTestDb, teardownTestDb } from './helpers/test-db';

process.env.SKIP_PREFLIGHT = '1';

describe('Documents API absence', () => {
  let app: NestFastifyApplication;

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

  it('returns 404 for every retired /api/documents route', async () => {
    const listResponse = await app.inject({ method: 'GET', url: '/api/documents' });
    expect(listResponse.statusCode).toBe(404);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { projectId: 'project-1', title: 'Retired', contentMd: '# Retired' },
    });
    expect(createResponse.statusCode).toBe(404);

    const itemResponse = await app.inject({
      method: 'GET',
      url: '/api/documents/00000000-0000-0000-0000-000000000001',
    });
    expect(itemResponse.statusCode).toBe(404);

    const slugResponse = await app.inject({
      method: 'GET',
      url: '/api/documents/by-slug',
      query: { projectId: 'project-1', slug: 'retired' },
    });
    expect(slugResponse.statusCode).toBe(404);
  });
});
