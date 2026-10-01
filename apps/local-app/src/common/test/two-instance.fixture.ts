import { PROVIDER_CLI_INSTALL_ROOT } from '../../modules/providers/services/provider-cli-install-state.service';
import { TranscriptPathValidator } from '../../modules/session-reader/services/transcript-path-validator.service';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppModule } from '../../app.module';
import { resetEnvConfig } from '../config/env.config';
import { normalizeFastifyFrameworkError } from '../http/runtime-route-classification';
import { registerHostApiKeyBoundary } from '../../modules/remotes/host/host-api-key.setup';
import { registerHostTls } from '../../modules/remotes/host/host-tls.setup';
import { certificateFingerprint } from '../tls/certificate';
import { FIXTURE_TLS_DIR, fixtureTls } from './tls-fixture';
import { DB_CONNECTION } from '../../modules/storage/db/db.provider';
import {
  STORAGE_SERVICE,
  type StorageService,
} from '../../modules/storage/interfaces/storage.interface';
import type { Remote, RemoteBindingState } from '../../modules/storage/models/domain.models';
import { applyExternalBoundaryMocks, createMigratedDatabase } from './app-bootstrap.helper';
import { ProjectWriteAdmissionService } from '../../modules/remotes/admission/project-write-admission.service';
import { FILE_SYNC_PATHS, type FileSyncPaths } from '../../modules/file-sync/file-sync-paths';

/**
 * Two full DevChain apps in one Jest process — `home` and `host` — each on its
 * own random port with its own SQLite file. Only process/terminal/provider-CLI
 * and cloud-tunnel boundaries are mocked; storage, realtime, the remotes module
 * and the `/r` proxy are real.
 *
 * Both apps share `process.env` (so one HOME temp dir and one env config): the
 * env config is a process-wide cache. Anything a test needs to differ per
 * instance must come through the database, not the environment.
 */

export interface TestInstance {
  readonly name: string;
  readonly url: string;
  readonly app: NestFastifyApplication;
  readonly sqlite: Database.Database;
  readonly storage: StorageService;
  readonly dataDir: string;
  isClosed(): boolean;
  close(): Promise<void>;
}

export interface TwoInstances {
  home: TestInstance;
  host: TestInstance;
  /** Temp directory holding both data directories; `close()` removes it. */
  readonly rootDir: string;
  /** Registers `host` as a remote at `home` through the REST API. */
  registerRemote(name?: string): Promise<Remote>;
  /**
   * Marks a host project as bound to `remoteId` at home and reloads home's
   * write-admission map. Home gets a copy of the project row (bindings
   * reference a home project) unless it has one.
   */
  bindProject(projectId: string, remoteId: string, state?: RemoteBindingState): Promise<void>;
  /**
   * Closes `home` and boots a new app on the same data directory (a new port).
   * `home` refers to the new instance afterwards.
   */
  restartHome(): Promise<TestInstance>;
  /**
   * Closes `host` unless it is closed already and boots a new app on the same
   * data directory and port, so home's registered `baseUrl` stays valid.
   * `host` refers to the new instance afterwards.
   */
  restartHost(): Promise<TestInstance>;
  /** Replaces the host with a new, empty database on the same address and port. */
  replaceHost(): Promise<TestInstance>;
  /**
   * Present with `claimedHost`: the host's key file path and control over the
   * peer address its admission checks see on inbound connections. The default
   * reports a non-loopback peer; setting a loopback address exercises the
   * loopback exemption.
   */
  hostApiKey?: { keyPath: string; setSeenPeerAddress(address: string): void };
  close(): Promise<void>;
}

export interface TwoInstanceOptions {
  /** Exercise real mobile dispatch/authorization while keeping the cloud transport mocked. */
  realTunnelHandler?: boolean;
  /** Health poll interval at home; short so online/offline flips are fast. */
  healthIntervalMs?: number;
  /** Live-sync pull interval; the production default unless given. */
  syncIntervalMs?: number;
  /** Live-sync full reconcile interval; the production default unless given. */
  reconcileIntervalMs?: number;
  /** Bound on a handoff's wait for team batches; the production default unless given. */
  timeSettleTimeoutMs?: number;
  /**
   * Runs real Syncthing on each instance with these paths. Without it, file
   * sync is `FakeFileSyncService` and no Syncthing starts.
   */
  fileSyncPaths?: (instance: 'home' | 'host', dataDir: string) => FileSyncPaths;
  transcriptRoots?: (instance: 'home' | 'host', dataDir: string) => Record<string, string[]>;
  /** Give the host a stable VM-like address for lifecycle tests. */
  hostBind?: { address: string; port: number };
  /**
   * Turns the host instance into a claimed VM: `claim.json` and a key file are
   * written, and every non-loopback caller of the host needs this API key.
   */
  claimedHost?: { key: string };
}

/** The non-routable peer the claimed host reports for its inbound connections. */
const CLAIMED_HOST_PEER = '192.0.2.10';

const FIXTURE_ENV_KEYS = [
  'HOME',
  'REMOTES_HEALTH_INTERVAL_MS',
  'REMOTES_SYNC_INTERVAL_MS',
  'REMOTES_RECONCILE_INTERVAL_MS',
  'REMOTES_TIME_SETTLE_TIMEOUT_MS',
  'DEVCHAIN_CLOUD_UI_ENABLED',
  'DEVCHAIN_HOST_ETC_DIR',
  'DEVCHAIN_HOST_TLS_KEY_FILE',
  'DEVCHAIN_HOST_TLS_CERT_FILE',
  'LOG_LEVEL',
] as const;

async function startInstance(
  root: string,
  name: 'home' | 'host',
  port = 0,
  fileSyncPaths?: TwoInstanceOptions['fileSyncPaths'],
  address = '127.0.0.1',
  transcriptRoots?: TwoInstanceOptions['transcriptRoots'],
  realTunnelHandler = false,
  hostPeerAddress?: { current: () => string | null },
): Promise<TestInstance> {
  const dataDir = join(root, name);
  mkdirSync(dataDir, { recursive: true });
  const { sqlite, db } = createMigratedDatabase(join(dataDir, 'devchain.db'));

  let app: NestFastifyApplication | undefined;
  try {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DB_CONNECTION)
      .useValue(db)
      .overrideProvider(PROVIDER_CLI_INSTALL_ROOT)
      .useValue(join(dataDir, 'provider-clis'));
    if (fileSyncPaths) {
      builder = builder.overrideProvider(FILE_SYNC_PATHS).useValue(fileSyncPaths(name, dataDir));
    }
    if (transcriptRoots) {
      builder = builder
        .overrideProvider(TranscriptPathValidator)
        .useFactory({ factory: () => new TranscriptPathValidator(transcriptRoots(name, dataDir)) });
    }
    const moduleRef = await applyExternalBoundaryMocks(builder, {
      realFileSync: fileSyncPaths !== undefined,
      realTunnelHandler,
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      // The peer's health poll keeps reusing its keep-alive connections, so a
      // close that waits for them to end may not finish while the peer runs.
      // Both flags are needed: the socket.io adapter closes the shared server first.
      new FastifyAdapter({
        logger: false,
        frameworkErrors: normalizeFastifyFrameworkError,
        forceCloseConnections: true,
      }),
      { logger: false, forceCloseConnections: true },
    );
    // Mirrors main.ts so request validation behaves as in production.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    if (hostPeerAddress) {
      // The admission checks read the raw socket address, so overriding it
      // gives a physically local connection the exact view a LAN caller has,
      // without depending on a network interface in CI.
      app.getHttpServer().prependListener('connection', (socket) => {
        const peer = hostPeerAddress.current();
        if (peer) Object.defineProperty(socket, 'remoteAddress', { get: () => peer });
      });
    }
    registerHostApiKeyBoundary(app);
    // After the peer override above, so the TLS front sees the real peer and
    // the admission checks see the override.
    registerHostTls(app);
    await app.listen(port, address);
  } catch (error) {
    await app?.close().catch(() => undefined);
    sqlite.close();
    throw error;
  }

  const started = app;
  const { port: boundPort } = started.getHttpServer().address() as AddressInfo;
  let closed = false;

  return {
    name,
    url: `http://${address}:${boundPort}`,
    app: started,
    sqlite,
    storage: started.get<StorageService>(STORAGE_SERVICE),
    dataDir,
    isClosed: () => closed,
    close: async () => {
      if (closed) return;
      closed = true;
      await started.close();
      sqlite.close();
    },
  };
}

function copyProjectRow(from: Database.Database, to: Database.Database, projectId: string): void {
  if (to.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
    return;
  }
  const row = from.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | Record<string, unknown>
    | undefined;
  if (!row) {
    throw new Error(`Project ${projectId} does not exist on the host`);
  }
  // Workspace ids differ between instances; the home copy joins home's first workspace.
  const workspace = to
    .prepare('SELECT id FROM project_workspaces ORDER BY created_at LIMIT 1')
    .get() as { id: string } | undefined;
  if (!workspace) {
    throw new Error('Home has no project workspace to attach the project copy to');
  }
  const copy = { ...row, workspace_id: workspace.id };
  const columns = Object.keys(copy);
  to.prepare(
    `INSERT INTO projects (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
  ).run(copy);
}

export async function startTwoInstances(options: TwoInstanceOptions = {}): Promise<TwoInstances> {
  const root = mkdtempSync(join(tmpdir(), 'devchain-two-instance-'));
  const savedEnv = new Map(FIXTURE_ENV_KEYS.map((key) => [key, process.env[key]]));

  const restoreEnv = () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvConfig();
  };

  let seenHostPeer: string | null = options.claimedHost ? CLAIMED_HOST_PEER : null;
  const hostPeerAddress = { current: () => seenHostPeer };
  let keyPath: string | undefined;
  if (options.claimedHost) {
    // Shared process env: both instances read this claim record, so home also
    // stays keyless-exempt only for its own loopback callers.
    const etcDir = join(root, 'claim-etc');
    const claimHome = join(root, 'claim-home');
    mkdirSync(etcDir, { recursive: true });
    mkdirSync(join(claimHome, '.devchain'), { recursive: true });
    writeFileSync(
      join(etcDir, 'claim.json'),
      JSON.stringify({ userName: 'vmuser', homePath: claimHome }),
    );
    keyPath = join(claimHome, '.devchain', 'host-api-key');
    writeFileSync(
      keyPath,
      `${createHash('sha256').update(options.claimedHost.key).digest('hex')}\n`,
    );
    process.env.DEVCHAIN_HOST_ETC_DIR = etcDir;
  }
  // Both instances serve the fixture VM certificate (TLS from any peer,
  // plaintext from loopback); home reaches the host pinned to it.
  const tlsDir = join(root, 'tls');
  mkdirSync(tlsDir, { recursive: true });
  for (const file of ['key.pem', 'cert.pem']) {
    copyFileSync(join(FIXTURE_TLS_DIR, file), join(tlsDir, file));
  }
  process.env.DEVCHAIN_HOST_TLS_KEY_FILE = join(tlsDir, 'key.pem');
  process.env.DEVCHAIN_HOST_TLS_CERT_FILE = join(tlsDir, 'cert.pem');

  mkdirSync(join(root, 'shared-home'), { recursive: true });
  process.env.HOME = join(root, 'shared-home');
  process.env.REMOTES_HEALTH_INTERVAL_MS = String(options.healthIntervalMs ?? 200);
  if (options.syncIntervalMs !== undefined) {
    process.env.REMOTES_SYNC_INTERVAL_MS = String(options.syncIntervalMs);
  }
  if (options.reconcileIntervalMs !== undefined) {
    process.env.REMOTES_RECONCILE_INTERVAL_MS = String(options.reconcileIntervalMs);
  }
  if (options.timeSettleTimeoutMs !== undefined) {
    process.env.REMOTES_TIME_SETTLE_TIMEOUT_MS = String(options.timeSettleTimeoutMs);
  }
  process.env.DEVCHAIN_CLOUD_UI_ENABLED = 'false';
  process.env.LOG_LEVEL = 'error';
  resetEnvConfig();

  const started: TestInstance[] = [];
  const close = async () => {
    for (const instance of [...started].reverse()) {
      await instance.close();
    }
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  };

  try {
    started.push(
      await startInstance(
        root,
        'home',
        0,
        options.fileSyncPaths,
        undefined,
        options.transcriptRoots,
        options.realTunnelHandler,
      ),
    );
    started.push(
      await startInstance(
        root,
        'host',
        options.hostBind?.port ?? 0,
        options.fileSyncPaths,
        options.hostBind?.address,
        options.transcriptRoots,
        options.realTunnelHandler,
        hostPeerAddress,
      ),
    );
  } catch (error) {
    await close();
    throw error;
  }
  let home = started[0];
  let host = started[1];

  return {
    get home() {
      return home;
    },
    get host() {
      return host;
    },
    rootDir: root,
    close,
    ...(keyPath && {
      hostApiKey: {
        keyPath,
        setSeenPeerAddress: (address: string) => {
          seenHostPeer = address;
        },
      },
    }),
    restartHome: async () => {
      await home.close();
      started.splice(started.indexOf(home), 1);
      home = await startInstance(
        root,
        'home',
        0,
        options.fileSyncPaths,
        undefined,
        options.transcriptRoots,
        options.realTunnelHandler,
      );
      started.unshift(home);
      return home;
    },
    restartHost: async () => {
      const port = Number(new URL(host.url).port);
      await host.close();
      started.splice(started.indexOf(host), 1);
      host = await startInstance(
        root,
        'host',
        port,
        options.fileSyncPaths,
        options.hostBind?.address,
        options.transcriptRoots,
        options.realTunnelHandler,
        hostPeerAddress,
      );
      started.push(host);
      return host;
    },
    replaceHost: async () => {
      const port = Number(new URL(host.url).port);
      await host.close();
      started.splice(started.indexOf(host), 1);
      rmSync(join(root, 'host'), { recursive: true, force: true });
      host = await startInstance(
        root,
        'host',
        port,
        options.fileSyncPaths,
        options.hostBind?.address,
        options.transcriptRoots,
        options.realTunnelHandler,
        hostPeerAddress,
      );
      started.push(host);
      return host;
    },
    registerRemote: async (name = 'host') => {
      const response = await fetch(`${home.url}/api/remotes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          baseUrl: host.url.replace(/^http:/, 'https:'),
          certificateFingerprint: certificateFingerprint(fixtureTls.cert),
          kind: 'address',
          ...(options.claimedHost && { apiKey: options.claimedHost.key }),
        }),
      });
      if (!response.ok) {
        throw new Error(`Registering the host failed: ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as Remote;
    },
    bindProject: async (projectId, remoteId, state = 'remote') => {
      copyProjectRow(host.sqlite, home.sqlite, projectId);
      const now = new Date().toISOString();
      home.sqlite
        .prepare(
          `INSERT INTO remote_project_bindings
             (project_id, remote_id, state, host_cursor, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?)`,
        )
        .run(projectId, remoteId, state, now, now);
      await home.app.get(ProjectWriteAdmissionService).refreshBindings();
    },
  };
}

/** Polls `probe` until it returns a truthy value or `timeoutMs` passes. */
export async function waitForValue<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
