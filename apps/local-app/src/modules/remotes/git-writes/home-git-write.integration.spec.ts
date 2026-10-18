import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { waitForValue } from '../../../common/test/two-instance.fixture';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { GitProcessIdentity } from '../git-coordinator/git-process-identity';
import { RemoteHostClient } from '../operations/remote-host.client';
import { RemoteBindingsService } from '../services/remote-bindings.service';
import { GitOwnerStore } from '../git-owner.store';
import { HomeGitTransitions } from './home-git-transitions';
import { HomeGitWriteController } from './home-git-write.controller';
import {
  DEFAULT_HOME_GIT_WRITE_TIMINGS,
  HOME_GIT_WRITE_TIMINGS,
  HomeGitWriteService,
} from './home-git-write.service';
import { HomeGitWriteStore } from './home-git-write.store';

// Integration is required for the loopback HTTP protocol, SQLite persistence across a restart
// and a real git child's start identity. The VM and Syncthing are replaced.
(process.platform === 'linux' ? describe : describe.skip)('Home Git write protocol', () => {
  let directory: string;
  let root: string;
  let sqlite: Database.Database;
  let app: NestFastifyApplication;
  const host = {
    gitCoordinatorStatus: jest.fn(),
    homeWriteBegin: jest.fn(),
    homeWriteEnd: jest.fn(),
    syncStatus: jest.fn(),
  };
  const files = {
    folderPath: jest.fn(),
    projectFolders: jest.fn(),
    device: jest.fn(),
    folderConfiguration: jest.fn(),
    rescan: jest.fn(),
    status: jest.fn(),
    remoteNeedThrough: jest.fn(),
  };
  const bindings = { get: jest.fn(), list: jest.fn() };
  const vm = {
    owner: 'home',
    generation: 2,
    homeName: 'PC',
    homeWrites: {},
    checkpoint: null,
    vmHolds: {},
    transition: null,
  };

  async function openApp(): Promise<void> {
    const module = await Test.createTestingModule({
      controllers: [HomeGitWriteController],
      providers: [
        HomeGitWriteService,
        HomeGitWriteStore,
        GitProcessIdentity,
        { provide: DB_CONNECTION, useValue: drizzle(sqlite) },
        {
          provide: STORAGE_SERVICE,
          useValue: {
            findProjectByPath: async (path: string) =>
              ({ [root]: { id: 'connected' }, [join(directory, 'plain')]: { id: 'plain' } })[
                path
              ] ?? null,
            getRemote: async () => ({ name: 'vm-01' }),
          },
        },
        { provide: RemoteBindingsService, useValue: bindings },
        { provide: RemoteHostClient, useValue: host },
        { provide: FileSyncService, useValue: files },
        { provide: ProcessExecutor, useClass: ChildProcessExecutor },
        GitOwnerStore,
        { provide: HomeGitTransitions, useValue: { handover: jest.fn(), stepDown: jest.fn() } },
        { provide: HOME_GIT_WRITE_TIMINGS, useValue: DEFAULT_HOME_GIT_WRITE_TIMINGS },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'home-git-writes-'));
    root = join(directory, 'checkout');
    execFileSync('git', ['init', '-q', root]);
    await mkdir(join(root, 'src'));
    await mkdir(join(directory, 'plain'));
    const template = createTestDatabase();
    await writeFile(join(directory, 'db.sqlite'), template.sqlite.serialize());
    template.sqlite.close();
    sqlite = new Database(join(directory, 'db.sqlite'));
    bindings.get.mockImplementation(async (id: string) =>
      id === 'connected' ? { projectId: id, remoteId: 'r', state: 'remote' } : null,
    );
    host.gitCoordinatorStatus.mockResolvedValue(vm);
    bindings.list.mockResolvedValue([]);
    host.homeWriteBegin.mockResolvedValue(vm);
    host.homeWriteEnd.mockResolvedValue(vm);
    files.folderPath.mockResolvedValue(root);
    files.projectFolders.mockResolvedValue([{ id: 'code:connected', kind: 'code' }]);
    files.device.mockReturnValue({ deviceId: 'HOME' });
    files.folderConfiguration.mockResolvedValue({
      devices: [{ deviceID: 'HOME' }, { deviceID: 'VM' }],
    });
    files.status.mockResolvedValue({ sequence: 1 });
    files.remoteNeedThrough.mockResolvedValue([]);
    await openApp();
    app.get(GitOwnerStore).remember('connected', { owner: 'home', generation: 2 });
  });
  afterEach(async () => {
    await app.close();
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('finds the project containing a folder over loopback only', async () => {
    const lookup = (path: string, remoteAddress = '127.0.0.1') =>
      app.inject({
        method: 'GET',
        url: `/api/git-writes/project?path=${encodeURIComponent(path)}`,
        remoteAddress,
      });
    expect((await lookup(join(root, 'src'))).json()).toEqual({
      projectId: 'connected',
      remoteName: 'vm-01',
    });
    expect((await lookup(join(directory, 'plain'))).json()).toEqual({
      projectId: 'plain',
      remoteName: null,
    });
    expect((await lookup(tmpdir())).statusCode).toBe(404);
    expect((await lookup(root, '192.168.1.5')).statusCode).toBe(403);
  });

  it('keeps an acquired write across a restart and confirms it after its git exits', async () => {
    const child = spawn('sleep', ['30']);
    await once(child, 'spawn');
    try {
      const acquired = await app.inject({
        method: 'POST',
        url: '/api/git-writes/acquire',
        payload: { projectId: 'connected', pid: child.pid },
      });
      expect(acquired.statusCode).toBe(200);
      const { writeId } = acquired.json();
      await app.close();
      sqlite.close();
      sqlite = new Database(join(directory, 'db.sqlite'));
      await openApp();
      expect(host.homeWriteEnd).not.toHaveBeenCalled();
      child.kill('SIGKILL');
      await once(child, 'exit');
      await waitForValue(async () => app.get(HomeGitWriteStore).list().length === 0, 10_000);
      expect(host.homeWriteEnd).toHaveBeenCalledWith(
        'r',
        'connected',
        expect.objectContaining({ writeId, expectedGeneration: 2, transitionId: null }),
      );
    } finally {
      child.kill('SIGKILL');
    }
  });
});
