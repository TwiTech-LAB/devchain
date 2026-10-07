import { createTestDatabase } from '../../common/test/test-database.helper';
import { resetEnvConfig } from '../../common/config/env.config';
import { Test, type TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { FILE_SYNC_PATHS, createProductionFileSyncPaths } from './file-sync-paths';
import { FileSyncModule } from './file-sync.module';
import { SyncthingLauncher, SYNCTHING_INSTALL_GUIDANCE } from './syncthing-launcher';
import {
  DEFAULT_SYNCTHING_MANAGER_TIMINGS,
  SYNCTHING_MANAGER_TIMINGS,
  SyncthingManager,
} from './syncthing-manager.service';
import { FakeSyncthingLauncher } from './testing/fake-syncthing-launcher';

// Backend integration: the manager's contract is HTTP calls, loopback port
// probing and a settings row, so it runs against a fake Syncthing REST server,
// real sockets and a migrated in-memory SQLite. Real processes are covered by
// syncthing-manager.external.spec.ts.

// Real sockets under a loaded parallel test run need more than Jest's 5 s default.
jest.setTimeout(30_000);

const TIMINGS = {
  ...DEFAULT_SYNCTHING_MANAGER_TIMINGS,
  readyTimeoutMs: 10_000,
  pollIntervalMs: 10,
  monitorIntervalMs: 20,
  restartBaseDelayMs: 100,
  restartMaxDelayMs: 1_000,
  shutdownTimeoutMs: 300,
};

const SETTINGS_KEY = 'fileSync.syncthing';

interface Harness {
  moduleRef: TestingModule;
  manager: SyncthingManager;
}

describe('SyncthingManager', () => {
  const originalHost = process.env.HOST;
  let root: string;
  let launcher: FakeSyncthingLauncher;
  const databases: Database.Database[] = [];
  const harnesses: Harness[] = [];
  const servers: Server[] = [];

  function openDb(): Database.Database {
    const { sqlite } = createTestDatabase();
    databases.push(sqlite);
    return sqlite;
  }

  async function createHarness(sqlite: Database.Database, home: string): Promise<Harness> {
    const moduleRef = await Test.createTestingModule({ imports: [FileSyncModule] })
      .overrideProvider(DB_CONNECTION)
      .useValue(drizzle(sqlite))
      .overrideProvider(FILE_SYNC_PATHS)
      .useValue({ ...createProductionFileSyncPaths(root), syncthingHome: () => home })
      .overrideProvider(SyncthingLauncher)
      .useValue(launcher)
      .overrideProvider(SYNCTHING_MANAGER_TIMINGS)
      .useValue(TIMINGS)
      .compile();
    const harness = { moduleRef, manager: moduleRef.get(SyncthingManager) };
    harnesses.push(harness);
    return harness;
  }

  function storedSettings(sqlite: Database.Database): Record<string, unknown> {
    const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as {
      value: string;
    };
    return JSON.parse(row.value) as Record<string, unknown>;
  }

  beforeEach(() => {
    process.env.HOST = '0.0.0.0';
    resetEnvConfig();
    root = mkdtempSync(join(tmpdir(), 'devchain-syncthing-manager-'));
    launcher = new FakeSyncthingLauncher();
  });

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.moduleRef.close();
    for (const server of servers.splice(0)) server.close();
    for (const run of launcher.runs) if (run.childAlive) run.crashChild();
    for (const sqlite of databases.splice(0)) sqlite.close();
    rmSync(root, { recursive: true, force: true });
    if (originalHost === undefined) delete process.env.HOST;
    else process.env.HOST = originalHost;
    resetEnvConfig();
  });

  it('removes legacy transcript shares after API readiness while retaining their files', async () => {
    const folder = join(root, 'transcripts');
    mkdirSync(folder);
    writeFileSync(join(folder, 'session.jsonl'), 'kept');
    launcher.folders = [
      { id: 'tx:claude:p1', path: folder },
      { id: 'tx:other:p2', path: folder },
      { id: 'code:p1' },
    ];
    const { moduleRef, manager } = await createHarness(openDb(), join(root, 'st-home'));
    await moduleRef.init();
    await waitFor(() => manager.getState().running);
    expect(launcher.folders).toEqual([{ id: 'code:p1' }]);
    expect(readFileSync(join(folder, 'session.jsonl'), 'utf8')).toBe('kept');
    expect(launcher.last.requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([
      '/rest/config/folders/tx%3Aclaude%3Ap1',
      '/rest/config/folders/tx%3Aother%3Ap2',
    ]);
  });

  it('starts with loopback API and network sync options, writing only under its home', async () => {
    const home = join(root, 'st-home');
    const sqlite = openDb();
    const { moduleRef, manager } = await createHarness(sqlite, home);

    await moduleRef.init();
    await waitFor(() => manager.getState().running);

    const run = launcher.last;
    const { apiKey, listenPort } = storedSettings(sqlite);
    expect(manager.getState()).toEqual({
      available: true,
      version: 'v2.1.5',
      running: true,
      deviceId: expect.stringMatching(/^[0-9A-F]{16}$/),
      apiPort: run.apiPort,
      error: null,
    });
    expect(run.args).toEqual([
      'serve',
      `--home=${home}`,
      `--gui-address=http://127.0.0.1:${run.apiPort}`,
      '--no-browser',
      '--no-restart',
      '--no-upgrade',
      `--log-file=${join(home, 'syncthing.log')}`,
    ]);
    expect(run.env).toMatchObject({
      HOME: home,
      STGUIAPIKEY: apiKey,
      STNODEFAULTFOLDER: '1',
      STNOUPGRADE: '1',
    });

    const calls = run.requests.map((r) => `${r.method} ${r.path}`);
    const patchAt = calls.indexOf('PATCH /rest/config/options');
    expect(patchAt).toBeGreaterThan(calls.indexOf('GET /rest/system/ping'));
    expect(calls.indexOf('GET /rest/config/restart-required')).toBeGreaterThan(patchAt);
    expect(run.requests[patchAt].body).toEqual({
      listenAddresses: [`tcp://0.0.0.0:${listenPort}`],
      globalAnnounceEnabled: false,
      localAnnounceEnabled: false,
      relaysEnabled: false,
      natEnabled: false,
      urAccepted: -1,
      crashReportingEnabled: false,
      autoUpgradeIntervalH: 0,
    });
    expect(manager.getConnection()).toMatchObject({
      deviceId: manager.getState().deviceId,
      listenAddress: `tcp://0.0.0.0:${listenPort}`,
    });
    expect(readdirSync(root)).toEqual(['st-home']);
  });

  it('reuses the home, device id, API key and ports on the next app start', async () => {
    const home = join(root, 'st-home');
    const sqlite = openDb();
    const first = await createHarness(sqlite, home);
    const before = await first.manager.ensureRunning();
    const settingsBefore = storedSettings(sqlite);
    await first.moduleRef.close();
    harnesses.splice(harnesses.indexOf(first), 1);

    const second = await createHarness(sqlite, home);
    const after = await second.manager.ensureRunning();

    expect(after).toMatchObject({
      running: true,
      error: null,
      deviceId: before.deviceId,
      apiPort: before.apiPort,
    });
    expect(storedSettings(sqlite)).toEqual(settingsBefore);
    expect(launcher.runs.map((r) => r.home)).toEqual([home, home]);
    expect(launcher.last.env.STGUIAPIKEY).toBe(settingsBefore.apiKey);
  });

  it('boots without a binary and reports install guidance', async () => {
    launcher.lookup = {
      found: false,
      version: null,
      error: `Syncthing was not found on PATH or in ~/.devchain/bin. ${SYNCTHING_INSTALL_GUIDANCE}`,
    };
    const { moduleRef, manager } = await createHarness(openDb(), join(root, 'st-home'));

    await moduleRef.init();
    await waitFor(() => manager.getState().error !== null);

    expect(manager.getState()).toEqual({
      available: false,
      version: null,
      running: false,
      deviceId: null,
      apiPort: null,
      error: expect.stringContaining('https://syncthing.net/downloads/'),
    });
    expect(manager.getConnection()).toBeNull();
    expect(launcher.runs).toHaveLength(0);
  });

  it('restarts a crashed instance with a growing backoff', async () => {
    const { manager } = await createHarness(openDb(), join(root, 'st-home'));
    await manager.ensureRunning();

    const firstCrashAt = Date.now();
    launcher.last.crashChild();
    await waitFor(() => !manager.getState().running);
    expect(manager.getState().error).toBe('Syncthing exited unexpectedly');
    await waitFor(() => launcher.runs.length === 2 && manager.getState().running);
    const firstDelay = launcher.runs[1].spawnedAt - firstCrashAt;

    const secondCrashAt = Date.now();
    launcher.last.crashChild();
    await waitFor(() => launcher.runs.length === 3 && manager.getState().running);
    const secondDelay = launcher.runs[2].spawnedAt - secondCrashAt;

    expect(firstDelay).toBeGreaterThanOrEqual(TIMINGS.restartBaseDelayMs);
    expect(secondDelay).toBeGreaterThanOrEqual(TIMINGS.restartBaseDelayMs * 2);
    expect(manager.getState()).toMatchObject({ running: true, error: null });
  });

  it('watches the child process, not the monitor parent', async () => {
    const { manager } = await createHarness(openDb(), join(root, 'st-home'));
    await manager.ensureRunning();
    const first = launcher.last;

    first.loseChild();
    await waitFor(() => launcher.runs.length === 2 && manager.getState().running);

    expect(manager.getState().error).toBeNull();
    expect(launcher.kills).toContain(first.pid);
    expect(first.hasExited()).toBe(true);
  });

  it('shuts down through the REST API without killing a process that complies', async () => {
    const { moduleRef, manager } = await createHarness(openDb(), join(root, 'st-home'));
    await manager.ensureRunning();
    const run = launcher.last;

    await moduleRef.close();
    harnesses.length = 0;

    expect(run.requests.map((r) => `${r.method} ${r.path}`)).toContain(
      'POST /rest/system/shutdown',
    );
    expect(launcher.kills).toEqual([]);
    expect(run.parentAlive || run.childAlive).toBe(false);
    expect(manager.getState().running).toBe(false);
  });

  it('kills the parent and the child when shutdown is ignored', async () => {
    launcher.onShutdown = 'ignore';
    const { manager } = await createHarness(openDb(), join(root, 'st-home'));
    await manager.ensureRunning();
    const run = launcher.last;

    const startedAt = Date.now();
    await manager.stop();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(TIMINGS.shutdownTimeoutMs);
    expect(launcher.kills).toEqual(expect.arrayContaining([run.pid, run.childPid]));
    expect(run.parentAlive || run.childAlive).toBe(false);
  });

  it('shuts down an instance a crashed earlier run left on the stored port', async () => {
    const home = join(root, 'st-home');
    const sqlite = openDb();
    const first = await createHarness(sqlite, home);
    const before = await first.manager.ensureRunning();
    await first.moduleRef.close();
    harnesses.splice(harnesses.indexOf(first), 1);
    // What a DevChain crash leaves behind: Syncthing still serving on the stored port.
    const { apiKey, apiPort } = storedSettings(sqlite);
    const leftover = launcher.spawnRun(
      ['serve', `--home=${home}`, `--gui-address=http://127.0.0.1:${apiPort}`],
      { STGUIAPIKEY: apiKey as string },
    );
    await waitFor(() => leftover.server.listening);

    const second = await createHarness(sqlite, home);
    const state = await second.manager.ensureRunning();

    expect(leftover.requests.map((r) => `${r.method} ${r.path}`)).toContain(
      'POST /rest/system/shutdown',
    );
    expect(leftover.childAlive).toBe(false);
    expect(state).toMatchObject({ running: true, apiPort, deviceId: before.deviceId });
  });

  it('moves to a new port when another program holds the stored one', async () => {
    const sqlite = openDb();
    const first = await createHarness(sqlite, join(root, 'st-home'));
    await first.manager.ensureRunning();
    await first.moduleRef.close();
    harnesses.splice(harnesses.indexOf(first), 1);
    const before = storedSettings(sqlite);

    const squatter = createServer((_req, res) => res.writeHead(404).end());
    servers.push(squatter);
    await new Promise<void>((resolve) =>
      squatter.listen(before.apiPort as number, '127.0.0.1', resolve),
    );

    const second = await createHarness(sqlite, join(root, 'st-home'));
    const state = await second.manager.ensureRunning();

    expect(state.running).toBe(true);
    expect(state.apiPort).not.toBe(before.apiPort);
    expect(storedSettings(sqlite)).toEqual({ ...before, apiPort: state.apiPort });
  });

  it('restarts when Syncthing reports that its options need a restart', async () => {
    launcher.restartRequired = [true];
    const { manager } = await createHarness(openDb(), join(root, 'st-home'));

    const first = await manager.ensureRunning();
    expect(first).toMatchObject({
      running: false,
      error: 'Syncthing needs a restart to apply its options',
    });
    await waitFor(() => manager.getState().running);

    expect(launcher.runs).toHaveLength(2);
    expect(launcher.runs[0].parentAlive || launcher.runs[0].childAlive).toBe(false);
  });

  it('runs two managers side by side from their own FILE_SYNC_PATHS', async () => {
    const homeA = join(root, 'home-instance', 'syncthing');
    const homeB = join(root, 'host-instance', 'syncthing');
    const a = await createHarness(openDb(), homeA);
    const b = await createHarness(openDb(), homeB);

    const [stateA, stateB] = await Promise.all([
      a.manager.ensureRunning(),
      b.manager.ensureRunning(),
    ]);

    expect(stateA.running && stateB.running).toBe(true);
    expect(stateA.apiPort).not.toBe(stateB.apiPort);
    expect(stateA.deviceId).not.toBe(stateB.deviceId);
    expect(launcher.runs.map((r) => r.home).sort()).toEqual([homeA, homeB].sort());
    expect(readdirSync(root).sort()).toEqual(['home-instance', 'host-instance']);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
