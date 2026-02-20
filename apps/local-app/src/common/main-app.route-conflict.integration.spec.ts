import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { MainAppModule } from '../app.main.module';
import { resetEnvConfig } from './config/env.config';
import { ORCHESTRATOR_DB_CONNECTION } from '../modules/orchestrator/orchestrator-storage/db/orchestrator.provider';

jest.mock('./logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

describe('Route conflict regression: /api/templates', () => {
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

  const setModeEnv = (mode: 'main') => {
    process.env.DEVCHAIN_MODE = mode;
    process.env.DATABASE_URL = 'postgres://devchain:devchain@127.0.0.1:5432/devchain_test';
    process.env.REPO_ROOT = process.cwd();
  };

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'devchain-main-route-conflict-'));
    process.env.DB_PATH = dbDir;
    process.env.DB_FILENAME = 'test.db';
    resetEnvConfig();
  });

  afterEach(async () => {
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

  it('bootstraps MainAppModule without duplicate GET /api/templates errors', async () => {
    setModeEnv('main');

    moduleRef = await Test.createTestingModule({
      imports: [MainAppModule],
    })
      .overrideProvider(ORCHESTRATOR_DB_CONNECTION)
      .useValue({})
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });

    await expect(app.init()).resolves.toBe(app);
    await app.getHttpAdapter().getInstance().ready();
  });

  it('keeps GET /api/templates available in main mode', async () => {
    setModeEnv('main');
    process.env.TEMPLATES_DIR = join(tmpdir(), `missing-main-templates-${Date.now()}`);

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

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/templates',
    });
    const payload = JSON.parse(response.payload) as { templates: unknown[]; total: number };

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(payload.templates)).toBe(true);
    expect(typeof payload.total).toBe('number');
  });
});
