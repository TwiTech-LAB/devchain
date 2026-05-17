import { Type } from '@nestjs/common';
import { Test, TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { MainAppModule } from '../../app.main.module';
import { NormalAppModule } from '../../app.normal.module';
import { DB_CONNECTION } from '../../modules/storage/db/db.provider';
import { STORAGE_SERVICE } from '../../modules/storage/interfaces/storage.interface';
import { TerminalIOService } from '../../modules/terminal/services/terminal-io/terminal-io.service';
import { ProcessExecutor } from '../../modules/terminal/services/process-executor/process-executor.port';
import { ProviderAdapterFactory } from '../../modules/providers/adapters';
import { REALTIME_BROADCASTER } from '../../modules/realtime/ports/realtime-broadcaster.port';
import { NoopRealtimeBroadcastAdapter } from '../../modules/realtime/services/noop-realtime-broadcast.adapter';
import { TunnelClientService } from '../../modules/cloud-tunnel/services/tunnel-client.service';
import { TunnelHandlerService } from '../../modules/cloud-tunnel/services/tunnel-handler.service';
import { TunnelKeypairService } from '../../modules/cloud-tunnel/services/tunnel-keypair.service';

type AppBootstrapRoot = 'normal' | 'main';

interface InMemoryBootstrapDb {
  sqlite: Database.Database;
  db: BetterSQLite3Database;
}

export interface AppBootstrapFixture {
  moduleRef: TestingModule;
  sqlite: Database.Database;
  close: () => Promise<void>;
}

export function createAppBootstrapTestingModule(
  root: AppBootstrapRoot,
  db: BetterSQLite3Database,
): TestingModuleBuilder {
  const rootModule = getRootModule(root);
  const builder = Test.createTestingModule({ imports: [rootModule] });
  return applyAppBootstrapMocks(builder, db);
}

export async function compileAppBootstrapFixture(
  root: AppBootstrapRoot,
): Promise<AppBootstrapFixture> {
  const { sqlite, db } = createInMemoryBootstrapDb();
  let moduleRef: TestingModule | undefined;

  try {
    moduleRef = await createAppBootstrapTestingModule(root, db).compile();
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return {
    moduleRef,
    sqlite,
    close: async () => {
      await moduleRef?.close();
      sqlite.close();
    },
  };
}

export function applyAppBootstrapMocks(
  builder: TestingModuleBuilder,
  db: BetterSQLite3Database,
): TestingModuleBuilder {
  return builder
    .overrideProvider(DB_CONNECTION)
    .useValue(db)
    .overrideProvider(STORAGE_SERVICE)
    .useValue(createBootstrapStorageMock())
    .overrideProvider(ProcessExecutor)
    .useValue(createProcessExecutorMock())
    .overrideProvider(TerminalIOService)
    .useValue(createTerminalIOMock())
    .overrideProvider(ProviderAdapterFactory)
    .useValue(createProviderAdapterFactoryMock())
    .overrideProvider(REALTIME_BROADCASTER)
    .useClass(NoopRealtimeBroadcastAdapter)
    .overrideProvider(TunnelClientService)
    .useValue(createTunnelClientMock())
    .overrideProvider(TunnelHandlerService)
    .useValue(createTunnelHandlerMock())
    .overrideProvider(TunnelKeypairService)
    .useValue(createTunnelKeypairMock());
}

function getRootModule(root: AppBootstrapRoot): Type<unknown> {
  return root === 'normal' ? NormalAppModule : MainAppModule;
}

function createInMemoryBootstrapDb(): InMemoryBootstrapDb {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite);

  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder: join(__dirname, '../../..', 'drizzle') });
  sqlite.pragma('foreign_keys = ON');

  return { sqlite, db };
}

function createBootstrapStorageMock(): Record<string, jest.Mock> {
  const methodCache = new Map<string, jest.Mock>();
  const predefined: Record<string, jest.Mock> = {
    getFeatureFlags: jest.fn().mockResolvedValue({}),
    getRegistryConfig: jest.fn().mockReturnValue({
      url: '',
      cacheDir: '',
      checkUpdatesOnStartup: false,
    }),
    getProjectTemplateMetadata: jest.fn().mockResolvedValue(null),
    setProjectTemplateMetadata: jest.fn().mockResolvedValue(undefined),
    listProviders: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listProjects: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listStatuses: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listEpicsByStatus: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    getEpic: jest.fn().mockResolvedValue(null),
    getAgent: jest.fn().mockResolvedValue({ providerConfigId: null }),
    getProfileProviderConfig: jest.fn().mockResolvedValue({ providerName: null, providerId: null }),
    getProvider: jest.fn().mockResolvedValue({ name: null }),
  };

  return new Proxy(predefined, {
    get(target, prop: string | symbol) {
      if (typeof prop !== 'string') {
        return Reflect.get(target, prop);
      }
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        return undefined;
      }
      if (!methodCache.has(prop)) {
        methodCache.set(prop, jest.fn().mockResolvedValue(undefined));
      }
      return target[prop] ?? methodCache.get(prop);
    },
  });
}

function createProcessExecutorMock(): jest.Mocked<ProcessExecutor> {
  return {
    run: jest.fn().mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
    }),
    spawnDaemon: jest.fn().mockResolvedValue({ pid: 0 }),
  };
}

function createTerminalIOMock(): Record<string, jest.Mock> {
  return {
    createSession: jest.fn().mockResolvedValue({ name: 'test-session' }),
    destroySession: jest.fn().mockResolvedValue(undefined),
    listSessions: jest.fn().mockResolvedValue([]),
    sessionExists: jest.fn().mockResolvedValue(false),
    createEmptySession: jest.fn().mockResolvedValue({ name: 'test-session' }),
    disableAlternateScreen: jest.fn().mockResolvedValue(undefined),
    typeCommand: jest.fn().mockResolvedValue(undefined),
    listAllSessionNames: jest.fn().mockResolvedValue(new Set()),
    deliver: jest.fn().mockResolvedValue({ delivered: true }),
    deliverImmediate: jest.fn().mockResolvedValue({ confirmed: true, nonce: 'test' }),
    sendControl: jest.fn().mockResolvedValue(undefined),
    capture: jest.fn().mockResolvedValue({ output: '', truncated: false }),
    getCursorPosition: jest.fn().mockResolvedValue(null),
    waitForOutput: jest.fn().mockResolvedValue({ matched: false, output: '' }),
    healthCheck: jest.fn().mockResolvedValue({ ok: true }),
    onModuleDestroy: jest.fn(),
  };
}

function createProviderAdapterFactoryMock(): Record<string, jest.Mock> {
  const adapter = { runtimePromptBehavior: {} };
  return {
    getAdapter: jest.fn().mockReturnValue(adapter),
    isSupported: jest.fn().mockReturnValue(true),
    getSupportedProviders: jest.fn().mockReturnValue(['test']),
    getPostPasteDelayMsForAgent: jest.fn().mockResolvedValue(undefined),
  };
}

function createTunnelClientMock(): Record<string, jest.Mock> {
  return {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    handleCloudConnected: jest.fn(),
    handleCloudDisconnected: jest.fn(),
  };
}

function createTunnelHandlerMock(): Record<string, jest.Mock> {
  return {
    handle: jest.fn().mockResolvedValue({ jsonrpc: '2.0', id: 'test', result: null }),
  };
}

function createTunnelKeypairMock(): Record<string, jest.Mock> {
  return {
    getOrCreate: jest.fn().mockResolvedValue({
      publicKey: 'test-public-key',
      privateKey: 'test-private-key',
      instanceId: 'test-instance',
    }),
    setInstanceId: jest.fn().mockResolvedValue(undefined),
    sign: jest.fn().mockResolvedValue('test-signature'),
  };
}
