import { Test, type TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resetEnvConfig } from '../../common/config/env.config';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { FILE_SYNC_PATHS, createProductionFileSyncPaths } from './file-sync-paths';
import { FileSyncModule } from './file-sync.module';
import { SyncthingLauncher } from './syncthing-launcher';
import {
  DEFAULT_SYNCTHING_MANAGER_TIMINGS,
  SYNCTHING_MANAGER_TIMINGS,
  SyncthingManager,
} from './syncthing-manager.service';

// External integration: process ancestry, the home-directory lock, what
// Syncthing writes to disk and its REST semantics only show with the real
// binary. Runs when SYNCTHING_BIN or PATH provides Syncthing v2.

function findBinary(): string | null {
  if (process.env.SYNCTHING_BIN) return process.env.SYNCTHING_BIN;
  try {
    return execFileSync('which', ['syncthing'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const binary = findBinary();
const describeWithBinary = binary ? describe : describe.skip;

describeWithBinary(
  `SyncthingManager with a real binary${binary ? '' : ' (skipped: set SYNCTHING_BIN or put syncthing v2 on PATH)'}`,
  () => {
    const savedHome = process.env.HOME;
    const savedBin = process.env.SYNCTHING_BIN;
    let root: string;
    let fakeHome: string;
    const modules: TestingModule[] = [];
    const databases: Database.Database[] = [];

    function openDb(): Database.Database {
      const sqlite = new Database(':memory:');
      migrate(drizzle(sqlite), { migrationsFolder: join(__dirname, '../../../drizzle') });
      databases.push(sqlite);
      return sqlite;
    }

    async function createManager(
      sqlite: Database.Database,
      home: string,
    ): Promise<{
      moduleRef: TestingModule;
      manager: SyncthingManager;
      launcher: SyncthingLauncher;
    }> {
      const moduleRef = await Test.createTestingModule({ imports: [FileSyncModule] })
        .overrideProvider(DB_CONNECTION)
        .useValue(drizzle(sqlite))
        .overrideProvider(FILE_SYNC_PATHS)
        .useValue({ ...createProductionFileSyncPaths(fakeHome), syncthingHome: () => home })
        .overrideProvider(SYNCTHING_MANAGER_TIMINGS)
        .useValue({
          ...DEFAULT_SYNCTHING_MANAGER_TIMINGS,
          monitorIntervalMs: 100,
          restartBaseDelayMs: 100,
        })
        .compile();
      modules.push(moduleRef);
      return {
        moduleRef,
        manager: moduleRef.get(SyncthingManager),
        launcher: moduleRef.get(SyncthingLauncher),
      };
    }

    async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'devchain-syncthing-external-'));
      fakeHome = join(root, 'fake-home');
      mkdirSync(fakeHome);
      process.env.HOME = fakeHome;
      process.env.SYNCTHING_BIN = binary ?? '';
      resetEnvConfig();
    });

    afterEach(async () => {
      for (const moduleRef of modules.splice(0)) await moduleRef.close();
      for (const sqlite of databases.splice(0)) sqlite.close();
      process.env.HOME = savedHome;
      if (savedBin === undefined) delete process.env.SYNCTHING_BIN;
      else process.env.SYNCTHING_BIN = savedBin;
      resetEnvConfig();
      rmSync(root, { recursive: true, force: true });
    });

    it('starts configured within 5 s, writes only its home, and keeps its identity across restarts', async () => {
      const home = join(root, 'st-home');
      const sqlite = openDb();
      const first = await createManager(sqlite, home);

      const startedAt = Date.now();
      const state = await first.manager.ensureRunning();
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(state).toMatchObject({ available: true, running: true, error: null });
      expect(state.version).toMatch(/^v2\./);

      const connection = first.manager.getConnection();
      expect(connection).not.toBeNull();
      expect(await connection!.client.restartRequired()).toBe(false);
      expect(await connection!.client.getOptions()).toMatchObject({
        listenAddresses: [connection!.listenAddress],
        globalAnnounceEnabled: false,
        localAnnounceEnabled: false,
        relaysEnabled: false,
        natEnabled: false,
        urAccepted: -1,
        autoUpgradeIntervalH: 0,
      });
      expect(connection!.listenAddress).toMatch(/^tcp:\/\/127\.0\.0\.1:\d+$/);

      await first.moduleRef.close();
      modules.splice(modules.indexOf(first.moduleRef), 1);

      const second = await createManager(sqlite, home);
      const again = await second.manager.ensureRunning();
      expect(again).toMatchObject({
        running: true,
        deviceId: state.deviceId,
        apiPort: state.apiPort,
      });
      expect(await second.manager.getConnection()!.client.restartRequired()).toBe(false);

      expect(readdirSync(root).sort()).toEqual(['fake-home', 'st-home']);
      expect(readdirSync(fakeHome)).toEqual([]);
      expect(existsSync(join(fakeHome, '.config', 'syncthing'))).toBe(false);
      expect(existsSync(join(fakeHome, '.local', 'state', 'syncthing'))).toBe(false);
    });

    it('restarts after the child is killed and stops both processes on shutdown', async () => {
      const { moduleRef, manager, launcher } = await createManager(openDb(), join(root, 'st-home'));
      const state = await manager.ensureRunning();
      const instance = (
        manager as unknown as { instance: { proc: { pid: number }; childPid: number } }
      ).instance;
      const { childPid } = instance;
      const parentPid = instance.proc.pid;
      expect(childPid).not.toBe(parentPid);

      process.kill(childPid, 'SIGKILL');
      await waitFor(() => !manager.getState().running, 5_000);
      await waitFor(() => manager.getState().running, 15_000);
      expect(manager.getState().deviceId).toBe(state.deviceId);
      expect(launcher.isAlive(childPid)).toBe(false);
      expect(launcher.isAlive(parentPid)).toBe(false);

      const restarted = (
        manager as unknown as { instance: { proc: { pid: number }; childPid: number } }
      ).instance;
      const stoppedAt = Date.now();
      await moduleRef.close();
      modules.splice(modules.indexOf(moduleRef), 1);
      expect(Date.now() - stoppedAt).toBeLessThan(5_000);
      expect(launcher.isAlive(restarted.childPid)).toBe(false);
      expect(launcher.isAlive(restarted.proc.pid)).toBe(false);
    });

    it('runs two instances side by side on two homes', async () => {
      const a = await createManager(openDb(), join(root, 'home-instance'));
      const b = await createManager(openDb(), join(root, 'host-instance'));

      const [stateA, stateB] = await Promise.all([
        a.manager.ensureRunning(),
        b.manager.ensureRunning(),
      ]);

      expect(stateA.running && stateB.running).toBe(true);
      expect(stateA.deviceId).not.toBe(stateB.deviceId);
      expect(stateA.apiPort).not.toBe(stateB.apiPort);
    });
  },
);
