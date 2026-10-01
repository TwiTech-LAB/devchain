import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { resetEnvConfig } from '../../common/config/env.config';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { RemoteHostClient } from '../remotes/operations/remote-host.client';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { FILE_SYNC_PATHS, type FileSyncPaths } from './file-sync-paths';
import { DEFAULT_FILE_SYNC_IGNORES } from './file-sync-ignores.store';
import { FileSyncModule } from './file-sync.module';
import { FileSyncService } from './file-sync.service';
import { SyncthingManager } from './syncthing-manager.service';

// External integration: pairing, ignore handling, completion and direction
// only prove themselves between two real Syncthing processes. Runs when
// SYNCTHING_BIN or PATH provides Syncthing v2.

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

jest.setTimeout(180_000);

describeWithBinary(
  `file sync between two real instances${binary ? '' : ' (skipped: set SYNCTHING_BIN or put syncthing v2 on PATH)'}`,
  () => {
    const savedBin = process.env.SYNCTHING_BIN;
    let root: string;
    let hostApp: NestFastifyApplication;
    let homeModule: TestingModule;
    const databases: Database.Database[] = [];

    function pathsFor(side: string): FileSyncPaths {
      return {
        syncthingHome: () => join(root, side, 'syncthing'),
        codeFolder: (project) => join(root, side, 'projects', project.id),
      };
    }

    async function compile(side: string): Promise<TestingModule> {
      const sqlite = new Database(':memory:');
      migrate(drizzle(sqlite), { migrationsFolder: join(__dirname, '../../../drizzle') });
      databases.push(sqlite);
      return Test.createTestingModule({ imports: [FileSyncModule] })
        .overrideProvider(DB_CONNECTION)
        .useValue(drizzle(sqlite))
        .overrideProvider(STORAGE_SERVICE)
        .useValue({ getProject: async (id: string) => ({ id, rootPath: `/srv/projects/${id}` }) })
        .overrideProvider(FILE_SYNC_PATHS)
        .useValue(pathsFor(side))
        .compile();
    }

    async function waitFor(
      what: string,
      condition: () => Promise<boolean> | boolean,
    ): Promise<void> {
      const deadline = Date.now() + 60_000;
      while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    function write(side: string, rel: string, content: string): void {
      const path = join(root, side, 'projects', 'p1', rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }

    function read(side: string, rel: string): string | null {
      const path = join(root, side, 'projects', 'p1', rel);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    }

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'devchain-file-sync-external-'));
      process.env.SYNCTHING_BIN = binary ?? '';
      resetEnvConfig();

      const hostModule = await compile('host');
      hostApp = hostModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      hostApp.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      hostApp.useGlobalFilters(new AllExceptionsFilter());
      await hostApp.listen(0, '127.0.0.1');
      homeModule = await compile('home');
      await homeModule.init();
      await Promise.all([
        hostApp.get(SyncthingManager).ensureRunning(),
        homeModule.get(SyncthingManager).ensureRunning(),
      ]);
    });

    afterAll(async () => {
      await homeModule?.close();
      await hostApp?.close();
      for (const sqlite of databases) sqlite.close();
      if (savedBin === undefined) delete process.env.SYNCTHING_BIN;
      else process.env.SYNCTHING_BIN = savedBin;
      resetEnvConfig();
      rmSync(root, { recursive: true, force: true });
    });

    it('pairs, syncs with ignores, reports and reverts receiver edits, and flips direction', async () => {
      const baseUrl = `http://127.0.0.1:${(hostApp.getHttpServer().address() as AddressInfo).port}`;
      const client = new RemoteHostClient(
        {
          getRemote: async () => ({ id: 'r1', name: 'host', baseUrl, kind: 'address' }),
        } as never,
        { get: async () => null, headers: async () => ({}) } as never,
      );
      const home = homeModule.get(FileSyncService);
      const host = hostApp.get(FileSyncService);

      // Pair through the host routes.
      const hostDevice = await client.syncDevice('r1');
      const homeDevice = home.device();
      await home.addPeer(hostDevice);
      await client.syncPeer('r1', homeDevice);
      await waitFor('the devices to connect', () => home.isConnected(hostDevice.deviceId));
      const connections = (await homeModule
        .get(SyncthingManager)
        .getConnection()!
        .client.request('GET', '/rest/system/connections')) as {
        connections: Record<string, { type: string }>;
      };
      expect(connections.connections[hostDevice.deviceId].type).toMatch(/^tcp-/);

      // Initial sync: home sends, host receives, with the default ignores.
      write('home', 'src/index.ts', 'export const x = 1;\n');
      write('home', '.env', 'SECRET=1\n');
      write('home', 'packages/inner/package.json', '{}\n');
      for (const ignored of [
        'node_modules/dep/index.js',
        'packages/inner/node_modules/dep/index.js',
        'dist/out.js',
        'build/out.js',
        'coverage/lcov.info',
      ]) {
        write('home', ignored, 'ignored\n');
      }
      const ignores = ['/.git', ...DEFAULT_FILE_SYNC_IGNORES];
      write('home', '.git/HEAD', 'ref: refs/heads/main\n');
      write('home', '.git/refs/heads/main', 'initial commit');
      write('home', '.git/index', 'initial index');
      write('home', '.git/hooks/pre-commit', 'initial hook');
      write('home', '.git/index.lock', 'ignored lock');
      await home.ensureFolder({
        projectId: 'p1',
        kind: 'code',
        type: 'sendonly',
        peerDeviceId: hostDevice.deviceId,
        ignores,
        paused: true,
      });
      await client.syncFolders('r1', {
        projectId: 'p1',
        kind: 'code',
        type: 'receiveonly',
        peerDeviceId: homeDevice.deviceId,
        ignores,
        paused: true,
      });
      await client.syncFolderType('r1', 'code:p1', { paused: false });
      await home.updateFolder('code:p1', { paused: false });

      await home.ensureFolder({
        projectId: 'p1',
        kind: 'git',
        type: 'sendonly',
        peerDeviceId: hostDevice.deviceId,
        ignores: ['*.lock'],
        paused: true,
      });
      await client.syncFolders('r1', {
        projectId: 'p1',
        kind: 'git',
        type: 'receiveonly',
        peerDeviceId: homeDevice.deviceId,
        ignores: ['*.lock'],
        paused: true,
      });
      await home.updateFolder('git:p1', { paused: false });
      await client.syncFolderType('r1', 'git:p1', { paused: false });
      await home.waitForComplete('git:p1', {
        sender: () => home.status('git:p1', hostDevice.deviceId),
        receiver: () => client.syncStatus('r1', 'git:p1'),
        timeoutMs: 60_000,
      });
      expect(read('host', '.git/index')).toBe('initial index');
      expect(read('host', '.git/hooks/pre-commit')).toBe('initial hook');
      expect(read('host', '.git/index.lock')).toBeNull();

      const progress: number[] = [];
      await home.waitForComplete('code:p1', {
        sender: () => home.status('code:p1', hostDevice.deviceId),
        receiver: () => client.syncStatus('r1', 'code:p1'),
        timeoutMs: 60_000,
        onProgress: (p) => progress.push(p.completion),
      });
      expect(progress.at(-1)).toBe(100);
      expect(read('host', 'src/index.ts')).toBe('export const x = 1;\n');
      expect(read('host', '.env')).toBe('SECRET=1\n');
      expect(read('host', 'packages/inner/package.json')).toBe('{}\n');
      for (const ignored of [
        'node_modules',
        'packages/inner/node_modules',
        'dist',
        'build',
        'coverage',
      ]) {
        expect(existsSync(join(root, 'host', 'projects', 'p1', ignored))).toBe(false);
      }

      // A receiver edit stays local, is reported, and reverts.
      write('host', 'src/index.ts', 'host edit\n');
      await host.rescan('code:p1');
      await waitFor(
        'the receive-only change',
        async () => (await client.syncStatus('r1', 'code:p1')).receiveOnlyChangedFiles > 0,
      );
      expect(read('home', 'src/index.ts')).toBe('export const x = 1;\n');
      await host.revertLocalChanges('code:p1');
      await waitFor('the revert', () => read('host', 'src/index.ts') === 'export const x = 1;\n');

      await home.setFolderType('code:p1', 'sendreceive');
      await client.syncFolderType('r1', 'code:p1', { type: 'sendreceive' });
      const gitIgnores = ['*.lock', '/hooks', '/index'];
      await home.updateFolder('git:p1', { type: 'receiveonly', ignores: gitIgnores });
      await client.syncFolderType('r1', 'git:p1', { type: 'sendonly', ignores: gitIgnores });
      write('host', '.git/refs/heads/main', 'host commit');
      write('host', '.git/index', 'host index');
      write('host', '.git/hooks/pre-commit', 'host hook');
      await host.rescan('git:p1');
      await waitFor(
        'the host Git ref',
        () => read('home', '.git/refs/heads/main') === 'host commit',
      );
      expect(read('home', '.git/index')).toBe('initial index');
      expect(read('home', '.git/hooks/pre-commit')).toBe('initial hook');
      const gitConfig = await hostApp
        .get(SyncthingManager)
        .getConnection()!
        .client.request('GET', '/rest/config/folders/git%3Ap1');
      expect(gitConfig).toMatchObject({
        maxConflicts: 0,
        path: join(root, 'host', 'projects', 'p1', '.git'),
      });
      write('host', 'src/after-flip.ts', 'from host\n');
      await waitFor(
        'the host change at home',
        () => read('home', 'src/after-flip.ts') === 'from host\n',
      );

      write('home', 'src/home-edit.ts', 'from home\n');
      await home.rescan('code:p1');
      await waitFor(
        'the home code edit at host',
        () => read('host', 'src/home-edit.ts') === 'from home\n',
      );
    });
  },
);
