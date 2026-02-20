import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import {
  STORAGE_SERVICE,
  type StorageService,
} from '../src/modules/storage/interfaces/storage.interface';
import { setupTestDb, teardownTestDb, resetTestDb } from './helpers/test-db';
import { resetEnvConfig } from '../src/common/config/env.config';

process.env.SKIP_PREFLIGHT = '1';

describe('Container project scoping (E2E)', () => {
  let app: NestFastifyApplication;
  let storage: StorageService;

  beforeAll(async () => {
    setupTestDb();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    storage = app.get<StorageService>(STORAGE_SERVICE);
  });

  afterAll(async () => {
    await app.close();
    teardownTestDb();
    delete process.env.CONTAINER_PROJECT_ID;
    delete process.env.DEVCHAIN_MODE;
    resetEnvConfig();
  });

  beforeEach(() => {
    resetTestDb();
    delete process.env.CONTAINER_PROJECT_ID;
    delete process.env.DEVCHAIN_MODE;
    resetEnvConfig();
  });

  it('shows only the scoped project in GET /api/projects when CONTAINER_PROJECT_ID is set', async () => {
    const alpha = await storage.createProject({
      name: 'Alpha',
      description: null,
      rootPath: '/tmp/alpha',
      isTemplate: false,
    });
    await storage.createProject({
      name: 'Beta',
      description: null,
      rootPath: '/tmp/beta',
      isTemplate: false,
    });

    process.env.DEVCHAIN_MODE = 'normal';
    process.env.CONTAINER_PROJECT_ID = alpha.id;
    resetEnvConfig();

    const response = await app.inject({
      method: 'GET',
      url: '/api/projects',
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.payload) as {
      total: number;
      items: Array<{ id: string; name: string }>;
    };
    expect(payload.total).toBe(1);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].id).toBe(alpha.id);
    expect(payload.items[0].name).toBe('Alpha');
  });
});
