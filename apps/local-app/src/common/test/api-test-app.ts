import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../../app.module';
import { PROVIDER_CLI_INSTALL_ROOT } from '../../modules/providers/services/provider-cli-install-state.service';
import { DB_CONNECTION } from '../../modules/storage/db/db.provider';
import { SettingsService } from '../../modules/settings/services/settings.service';
import {
  STORAGE_SERVICE,
  type StorageService,
} from '../../modules/storage/interfaces/storage.interface';
import { resetEnvConfig } from '../config/env.config';
import { normalizeFastifyFrameworkError } from '../http/runtime-route-classification';
import { applyExternalBoundaryMocks } from './app-bootstrap.helper';
import { createTestDatabase } from './test-database.helper';

export interface ApiTestApp {
  app: NestFastifyApplication;
  sqlite: Database.Database;
  storage: StorageService;
  rootDir: string;
  close(): Promise<void>;
}

export async function createApiTestApp(
  configure: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<ApiTestApp> {
  const rootDir = mkdtempSync(join(tmpdir(), 'devchain-api-'));
  const overrides = {
    HOME: rootDir,
    DEVCHAIN_CLOUD_UI_ENABLED: 'false',
    PROVIDER_CLI_CHECKS_ENABLED: 'false',
    DEVCHAIN_HOST_ETC_DIR: join(rootDir, 'host-etc'),
  };
  const savedEnv = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  resetEnvConfig();

  const { sqlite, db } = createTestDatabase();
  let app: NestFastifyApplication | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await app?.close();
    } finally {
      sqlite.close();
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetEnvConfig();
      rmSync(rootDir, { recursive: true, force: true });
    }
  };

  try {
    const settings = new SettingsService(db, new EventEmitter2());
    // The default cache path is captured at module load, before HOME is isolated.
    await settings.updateSettings({
      registry: { cacheDir: join(rootDir, 'registry-cache'), checkUpdatesOnStartup: false },
      skills: { syncOnStartup: false },
    });
    const builder = applyExternalBoundaryMocks(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DB_CONNECTION)
        .useValue(db)
        .overrideProvider(PROVIDER_CLI_INSTALL_ROOT)
        .useValue(join(rootDir, 'provider-clis')),
    );
    const moduleRef = await configure(builder).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false, frameworkErrors: normalizeFastifyFrameworkError }),
      { logger: false },
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return { app, sqlite, storage: app.get<StorageService>(STORAGE_SERVICE), rootDir, close };
  } catch (error) {
    await close();
    throw error;
  }
}
