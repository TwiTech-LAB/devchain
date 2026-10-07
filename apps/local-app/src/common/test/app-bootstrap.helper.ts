import { Test, TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { AppModule } from '../../app.module';
import { DB_CONNECTION } from '../../modules/storage/db/db.provider';
import { STORAGE_SERVICE } from '../../modules/storage/interfaces/storage.interface';
import { TerminalIOService } from '../../modules/terminal/services/terminal-io/terminal-io.service';
import { ChildProcessExecutor } from '../../modules/terminal/services/process-executor/child-process-executor';
import { ProcessExecutor } from '../../modules/terminal/services/process-executor/process-executor.port';
import { ProviderAdapterFactory } from '../../modules/providers/adapters';
import { REALTIME_BROADCASTER } from '../../modules/realtime/ports/realtime-broadcaster.port';
import { NoopRealtimeBroadcastAdapter } from '../../modules/realtime/services/noop-realtime-broadcast.adapter';
import { TunnelClientService } from '../../modules/cloud-tunnel/services/tunnel-client.service';
import { TunnelHandlerService } from '../../modules/cloud-tunnel/services/tunnel-handler.service';
import { TunnelKeypairService } from '../../modules/cloud-tunnel/services/tunnel-keypair.service';
import {
  NodeSyncthingLauncher,
  SyncthingLauncher,
} from '../../modules/file-sync/syncthing-launcher';
import { HomeGitGuardService } from '../../modules/file-sync/home-git-guard.service';
import { FileSyncService } from '../../modules/file-sync/file-sync.service';
import { FakeFileSyncService } from '../../modules/file-sync/testing/fake-file-sync.service';
import { createTestDatabase } from './test-database.helper';

interface InMemoryBootstrapDb {
  sqlite: Database.Database;
  db: BetterSQLite3Database;
}

export interface AppBootstrapFixture {
  moduleRef: TestingModule;
  sqlite: Database.Database;
  close: () => Promise<void>;
}

export function createAppBootstrapTestingModule(db: BetterSQLite3Database): TestingModuleBuilder {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  return applyAppBootstrapMocks(builder, db);
}

export async function compileAppBootstrapFixture(): Promise<AppBootstrapFixture> {
  const { sqlite, db } = createInMemoryBootstrapDb();
  let moduleRef: TestingModule | undefined;

  try {
    moduleRef = await createAppBootstrapTestingModule(db).compile();
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
  return applyExternalBoundaryMocks(
    builder
      .overrideProvider(DB_CONNECTION)
      .useValue(db)
      .overrideProvider(STORAGE_SERVICE)
      .useValue(createBootstrapStorageMock())
      .overrideProvider(REALTIME_BROADCASTER)
      .useClass(NoopRealtimeBroadcastAdapter),
  );
}

/**
 * Replaces only what reaches outside the process — tmux/process spawning,
 * provider CLIs, Syncthing, the cloud tunnel — so real storage and realtime can run.
 * Without `realFileSync`, file sync is an in-memory `FakeFileSyncService` whose
 * folders are always in sync, and Syncthing is never started.
 */
export function applyExternalBoundaryMocks(
  builder: TestingModuleBuilder,
  options: { realFileSync?: boolean; realTunnelHandler?: boolean } = {},
): TestingModuleBuilder {
  const processMock = createProcessExecutorMock();
  if (options.realFileSync) {
    const child = new ChildProcessExecutor();
    const fallback = processMock.run.getMockImplementation()!;
    processMock.run.mockImplementation((request) =>
      request.argv[0] === 'git' ? child.run(request) : fallback(request),
    );
  }
  const withFileSync = options.realFileSync
    ? // Only Syncthing and its Git maintenance use real processes.
      builder
        .overrideProvider(SyncthingLauncher)
        .useValue(new NodeSyncthingLauncher(new ChildProcessExecutor()))
    : builder
        .overrideProvider(SyncthingLauncher)
        .useValue(createSyncthingLauncherMock())
        .overrideProvider(FileSyncService)
        .useValue(new FakeFileSyncService())
        .overrideProvider(HomeGitGuardService)
        .useValue({
          install: async () => null,
          remove: async (_projectId: string, options: { refreshIndex: boolean }) => ({
            removed: false,
            indexRefreshed: options.refreshIndex ? true : null,
            warning: null,
          }),
          reinstall: async () => null,
        });
  const withHandler = options.realTunnelHandler
    ? withFileSync
    : withFileSync.overrideProvider(TunnelHandlerService).useValue(createTunnelHandlerMock());
  return withHandler
    .overrideProvider(ProcessExecutor)
    .useValue(processMock)
    .overrideProvider(TerminalIOService)
    .useValue(createTerminalIOMock())
    .overrideProvider(ProviderAdapterFactory)
    .useValue(createProviderAdapterFactoryMock())
    .overrideProvider(TunnelClientService)
    .useValue(createTunnelClientMock())
    .overrideProvider(TunnelKeypairService)
    .useValue(createTunnelKeypairMock());
}

function createInMemoryBootstrapDb(): InMemoryBootstrapDb {
  return createMigratedDatabase(':memory:');
}

/** Opens (or creates) a SQLite database at `path` with every migration applied. */
export function createMigratedDatabase(path: string): InMemoryBootstrapDb {
  if (path === ':memory:') return createTestDatabase();

  const sqlite = new Database(path);
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
    getRegistryConfig: jest.fn().mockReturnValue({
      url: '',
      cacheDir: '',
      checkUpdatesOnStartup: false,
    }),
    getProjectTemplateMetadata: jest.fn().mockResolvedValue(null),
    setProjectTemplateMetadata: jest.fn().mockResolvedValue(undefined),
    listProviders: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listProjects: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listFrozenProjects: jest.fn().mockResolvedValue([]),
    listRemoteProjectBindings: jest.fn().mockResolvedValue([]),
    listRemoteOperations: jest.fn().mockResolvedValue([]),
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
    destroyExpectedSession: jest.fn().mockResolvedValue({ outcome: 'destroyed' }),
    listSessions: jest.fn().mockResolvedValue([]),
    sessionExists: jest.fn().mockResolvedValue(false),
    createEmptySession: jest.fn().mockResolvedValue({ name: 'test-session' }),
    setAlternateScreen: jest.fn().mockResolvedValue(undefined),
    typeCommand: jest.fn().mockResolvedValue(undefined),
    listAllSessionNames: jest.fn().mockResolvedValue(new Set()),
    deliver: jest.fn().mockResolvedValue({ delivered: true }),
    deliverImmediate: jest.fn().mockResolvedValue({ confirmed: true, nonce: 'test' }),
    sendControl: jest.fn().mockResolvedValue(undefined),
    capture: jest.fn().mockResolvedValue({ output: '', truncated: false }),
    getCursorPosition: jest.fn().mockResolvedValue(null),
    waitForOutput: jest.fn().mockResolvedValue({ matched: false, output: '' }),
    healthCheck: jest.fn().mockResolvedValue({ ok: true }),
    beforeApplicationShutdown: jest.fn(),
  };
}

function createProviderAdapterFactoryMock(): Record<string, jest.Mock> {
  const adapter = { runtimePromptBehavior: {} };
  return {
    getAdapter: jest.fn().mockReturnValue(adapter),
    isSupported: jest.fn().mockReturnValue(true),
    getSupportedProviders: jest.fn().mockReturnValue(['test']),
    getRuntimePromptBehaviorForAgent: jest.fn().mockResolvedValue({}),
  };
}

function createTunnelClientMock(): Record<string, jest.Mock> {
  return {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    handleCloudConnected: jest.fn(),
    handleCloudDisconnected: jest.fn(),
    canPush: jest.fn().mockReturnValue(false),
    sendPush: jest.fn().mockReturnValue(false),
    // Viewport sink surface (ViewportFrameSink): the streamer registers a ready listener in
    // onModuleInit and pushes frames through these. Return a no-op unsubscribe.
    sendViewport: jest.fn().mockReturnValue(false),
    onPushReady: jest.fn().mockReturnValue(() => {}),
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

/** Reports no binary, so booted apps never spawn Syncthing. */
function createSyncthingLauncherMock(): Record<string, jest.Mock> {
  return {
    findBinary: jest.fn().mockResolvedValue({
      found: false,
      version: null,
      error: 'Syncthing is disabled in this test.',
    }),
    spawn: jest.fn(),
    findChildPid: jest.fn().mockResolvedValue(null),
    isAlive: jest.fn().mockReturnValue(false),
    kill: jest.fn(),
  };
}
