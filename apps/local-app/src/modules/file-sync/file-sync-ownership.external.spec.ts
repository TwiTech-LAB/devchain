import { Test, type TestingModule } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { GitOwnerStore } from '../remotes/git-owner.store';
import { FileSyncHandoff } from '../remotes/operations/file-sync-handoff';
import { RemoteHostClient } from '../remotes/operations/remote-host.client';
import type { RemoteOperationStepRun } from '../remotes/operations/remote-operation.types';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { ChildProcessExecutor } from '../terminal/services/process-executor/child-process-executor';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import type { SyncFolderPatch } from './file-sync.dto';
import { FILE_SYNC_PATHS } from './file-sync-paths';
import { FileSyncManagedExclusionsStore } from './file-sync-managed-exclusions.store';
import { FileSyncModule } from './file-sync.module';
import { FileSyncService } from './file-sync.service';
import { HomeGitGuardService } from './home-git-guard.service';
import {
  findSyncthingBinary,
  NodeSyncthingLauncher,
  SyncthingLauncher,
  type SyncthingBinaryLookup,
} from './syncthing-launcher';
import {
  DEFAULT_SYNCTHING_MANAGER_TIMINGS,
  SYNCTHING_MANAGER_TIMINGS,
  SyncthingManager,
} from './syncthing-manager.service';

// External: only real exec capabilities, foreign uid files and Syncthing transfers
// can prove ownership. Opt in with SYNCTHING_PRIVILEGED_BIN pointing to a root-owned
// v2 copy with cap_chown,cap_fowner,cap_dac_override+ep; run as a normal Linux user
// with passwordless sudo for fixture ownership and cleanup. Home uses a plain copy.
const privilegedBinary = process.env.SYNCTHING_PRIVILEGED_BIN;
const describeOwnership = privilegedBinary ? describe : describe.skip;
const FOREIGN_ID = 4321;

class FixtureLauncher extends NodeSyncthingLauncher {
  readonly capabilityChecks: Array<{ pid: number; effective: string | null }> = [];
  constructor(
    private readonly binaryExecutor: ProcessExecutor,
    public binary: string,
  ) {
    super(binaryExecutor);
  }

  findBinary(): Promise<SyncthingBinaryLookup> {
    return findSyncthingBinary({
      explicitPath: this.binary,
      pathEnv: undefined,
      homeDir: tmpdir(),
      platform: process.platform,
      isExecutable: async (path) => {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
      readVersionOutput: async (path) => {
        const result = await this.binaryExecutor.run({ argv: [path, '--version'], mode: 'pipe' });
        if (!result.success) throw new Error('Fixture binary did not report its version');
        return result.stdout;
      },
    });
  }

  async hasOwnershipCapabilities(pid: number): Promise<boolean> {
    const effective =
      /^CapEff:\s*(\S+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? null;
    this.capabilityChecks.push({ pid, effective });
    return super.hasOwnershipCapabilities(pid);
  }
}

interface Side {
  moduleRef: TestingModule;
  sqlite: Database.Database;
  sync: FileSyncService;
  manager: SyncthingManager;
  launcher: FixtureLauncher;
}

jest.setTimeout(240_000);

describeOwnership('foreign VM owners with real privileged Syncthing', () => {
  let root: string;
  let plainBinary: string;
  let home: Side;
  let vm: Side;
  let handoffModule: TestingModule;
  let completed = false;
  const modules: TestingModule[] = [];
  const databases: Database.Database[] = [];
  const userId = process.getuid?.();
  const groupId = process.getgid?.();

  function path(side: 'home' | 'vm', rel: string): string {
    return join(root, side, 'project', rel);
  }

  function write(side: 'home' | 'vm', rel: string, content: string, mode = 0o644): void {
    const target = path(side, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode });
  }

  function read(side: 'home' | 'vm', rel: string): string | null {
    const target = path(side, rel);
    return existsSync(target) ? readFileSync(target, 'utf8') : null;
  }

  function foreign(rel: string): void {
    execFileSync('sudo', ['-n', 'chown', '-R', `${FOREIGN_ID}:${FOREIGN_ID}`, path('vm', rel)]);
  }

  function owner(side: 'home' | 'vm', rel: string, uid: number, gid: number): void {
    expect(statSync(path(side, rel))).toMatchObject({ uid, gid });
  }

  async function waitFor(what: string, condition: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (!(await condition())) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function compile(side: 'home' | 'vm', binary: string): Promise<Side> {
    const { sqlite } = createTestDatabase();
    databases.push(sqlite);
    const launcher = new FixtureLauncher(new ChildProcessExecutor(), binary);
    const moduleRef = await Test.createTestingModule({ imports: [FileSyncModule] })
      .overrideProvider(DB_CONNECTION)
      .useValue(drizzle(sqlite))
      .overrideProvider(STORAGE_SERVICE)
      .useValue({
        getProject: async (id: string) => ({ id, rootPath: path(side, '') }),
      })
      .overrideProvider(FILE_SYNC_PATHS)
      .useValue({
        syncthingHome: () => join(root, side, 'syncthing'),
        codeFolder: () => path(side, ''),
      })
      .overrideProvider(SyncthingLauncher)
      .useValue(launcher)
      .overrideProvider(SYNCTHING_MANAGER_TIMINGS)
      .useValue({
        ...DEFAULT_SYNCTHING_MANAGER_TIMINGS,
        monitorIntervalMs: 50,
        restartBaseDelayMs: 100,
      })
      .compile();
    modules.push(moduleRef);
    const manager = moduleRef.get(SyncthingManager);
    const state = await manager.ensureRunning();
    expect(state).toMatchObject({ running: true, error: null, privileged: side === 'vm' });
    return { moduleRef, sqlite, launcher, manager, sync: moduleRef.get(FileSyncService) };
  }

  async function config(side: Side, kind: 'code' | 'git') {
    return side.manager.getConnection()!.client.request('GET', `/rest/config/folders/${kind}%3Ap1`);
  }

  async function settle(kind: 'code' | 'git', sender: Side, receiver: Side): Promise<void> {
    await sender.sync.rescan(`${kind}:p1`);
    await sender.sync.waitForComplete(`${kind}:p1`, {
      sender: () => sender.sync.status(`${kind}:p1`, receiver.sync.device().deviceId),
      receiver: () => receiver.sync.status(`${kind}:p1`),
      timeoutMs: 60_000,
      pollIntervalMs: 100,
    });
    for (const side of [sender, receiver]) {
      const status = await side.sync.status(`${kind}:p1`, undefined, { allErrors: true });
      expect(status.error ?? '').toBe('');
      expect(status.fileErrors ?? []).toEqual([]);
    }
  }

  beforeAll(async () => {
    if (
      process.platform !== 'linux' ||
      userId === undefined ||
      userId === 0 ||
      userId === FOREIGN_ID
    ) {
      throw new Error('Ownership proof requires a non-root Linux user distinct from uid 4321');
    }
    execFileSync('sudo', ['-n', 'true']);
    root = mkdtempSync(join(tmpdir(), 'devchain-sync-ownership-'));
    plainBinary = join(root, 'syncthing-plain');
    copyFileSync(privilegedBinary!, plainBinary);
    write('vm', 'data/secret.txt', 'foreign secret', 0o600);
    write('vm', 'data/log.txt', 'foreign log');
    write('vm', 'app.txt', 'foreign file in user folder');
    write('vm', 'writable/initial.txt', 'initial writable file');
    write('vm', '.git/refs/heads/main', 'initial VM ref');
    foreign('data');
    foreign('app.txt');
    foreign('.git/refs/heads');
    foreign('writable');
    execFileSync('sudo', ['-n', 'chmod', '0777', path('vm', 'writable')]);
    home = await compile('home', plainBinary);
    vm = await compile('vm', privilegedBinary!);
    handoffModule = await Test.createTestingModule({
      providers: [
        FileSyncHandoff,
        GitOwnerStore,
        { provide: DB_CONNECTION, useValue: drizzle(home.sqlite) },
        { provide: FileSyncService, useValue: home.sync },
        {
          provide: RemoteHostClient,
          useValue: {
            syncFolderType: async (_remote: string, id: string, patch: SyncFolderPatch) =>
              vm.sync.updateFolder(id, patch),
          },
        },
        {
          provide: FileSyncManagedExclusionsStore,
          useValue: home.moduleRef.get(FileSyncManagedExclusionsStore),
        },
        { provide: HomeGitGuardService, useValue: home.moduleRef.get(HomeGitGuardService) },
        { provide: ProcessExecutor, useValue: new ChildProcessExecutor() },
      ],
    }).compile();
    modules.push(handoffModule);
  });

  afterAll(async () => {
    if (root) {
      console.info('Ownership proof capabilities', {
        home: home?.launcher.capabilityChecks,
        vm: vm?.launcher.capabilityChecks,
      });
      if (!completed)
        for (const side of ['home', 'vm']) {
          const log = join(root, side, 'syncthing', 'syncthing.log');
          if (existsSync(log))
            console.error(
              `${side} Syncthing log`,
              readFileSync(log, 'utf8').split('\n').slice(-30).join('\n'),
            );
        }
    }
    for (const moduleRef of modules.reverse()) await moduleRef.close();
    for (const sqlite of databases) sqlite.close();
    if (root) {
      execFileSync('sudo', ['-n', 'chown', '-R', `${userId}:${groupId}`, root]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('syncs foreign owners, moves Git to the PC and back, and disables copying after privilege loss', async () => {
    const vmDevice = vm.sync.device();
    const homeDevice = home.sync.device();
    await home.sync.addPeer(vmDevice);
    await vm.sync.addPeer(homeDevice);
    await waitFor('peer connection', () => home.sync.isConnected(vmDevice.deviceId));
    for (const kind of ['code', 'git'] as const) {
      const ignores = kind === 'code' ? ['/.git'] : ['*.lock', '/hooks', '/index'];
      await home.sync.ensureFolder({
        projectId: 'p1',
        kind,
        type: 'receiveonly',
        peerDeviceId: vmDevice.deviceId,
        ignores,
      });
      await vm.sync.ensureFolder({
        projectId: 'p1',
        kind,
        type: kind === 'code' ? 'sendreceive' : 'sendonly',
        peerDeviceId: homeDevice.deviceId,
        ignores,
      });
      await settle(kind, vm, home);
    }
    expect(read('home', 'data/secret.txt')).toBe('foreign secret');
    expect(statSync(path('home', 'data/secret.txt')).mode & 0o777).toBe(0o600);
    owner('home', 'data/secret.txt', userId!, groupId!);
    expect(read('home', '.git/refs/heads/main')).toBe('initial VM ref');
    owner('home', '.git/refs/heads/main', userId!, groupId!);
    await home.sync.setFolderType('code:p1', 'sendreceive');
    write('home', 'data/log.txt', 'home edit');
    write('home', 'data/new.txt', 'home new file');
    write('home', 'app.txt', 'home replacement');
    await settle('code', home, vm);
    expect(read('vm', 'data/log.txt')).toBe('home edit');
    expect(read('vm', 'data/new.txt')).toBe('home new file');
    expect(read('vm', 'app.txt')).toBe('home replacement');
    owner('vm', 'data/log.txt', FOREIGN_ID, FOREIGN_ID);
    owner('vm', 'data/new.txt', FOREIGN_ID, FOREIGN_ID);
    owner('vm', 'app.txt', userId!, groupId!);

    const handoff = handoffModule.get(FileSyncHandoff);
    const run = { operation: { remoteId: 'vm' } } as RemoteOperationStepRun;
    await handoff.flipGit(run, 'p1', 'home');
    expect(handoffModule.get(GitOwnerStore).get('p1')).toBe('home');
    await expect(config(vm, 'git')).resolves.toMatchObject({
      type: 'receiveonly',
      copyOwnershipFromParent: true,
    });
    write('home', '.git/refs/heads/main', 'PC owns Git');
    write('home', '.git/refs/heads/new', 'new PC ref');
    await settle('git', home, vm);
    expect(read('vm', '.git/refs/heads/main')).toBe('PC owns Git');
    expect(read('vm', '.git/refs/heads/new')).toBe('new PC ref');
    owner('vm', '.git/refs/heads/main', FOREIGN_ID, FOREIGN_ID);
    owner('vm', '.git/refs/heads/new', FOREIGN_ID, FOREIGN_ID);
    await handoff.flipGit(run, 'p1', 'vm');
    expect(handoffModule.get(GitOwnerStore).get('p1')).toBe('vm');
    execFileSync('sudo', ['-n', 'tee', path('vm', '.git/refs/heads/main')], {
      input: 'VM owns Git again',
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    await settle('git', vm, home);
    expect(read('home', '.git/refs/heads/main')).toBe('VM owns Git again');
    owner('home', '.git/refs/heads/main', userId!, groupId!);

    // Isolate the downgrade proof from the intentionally unreadable foreign fixtures.
    await home.sync.updateFolder('code:p1', { ignores: ['/.git', '/data'] });
    await vm.sync.updateFolder('code:p1', { ignores: ['/.git', '/data'] });
    await vm.sync.updateFolder('git:p1', { paused: true });
    await home.sync.updateFolder('git:p1', { paused: true });
    const before = vm.manager.getState();
    vm.launcher.binary = plainBinary;
    const connection = vm.manager.getConnection()!;
    await connection.client.shutdown();
    await waitFor('the unprivileged relaunch', () => {
      const state = vm.manager.getState();
      return state.running && !state.privileged;
    });
    expect(vm.manager.getState().deviceId).toBe(before.deviceId);
    for (const kind of ['code', 'git'] as const) {
      await expect(config(vm, kind)).resolves.toMatchObject({ copyOwnershipFromParent: false });
    }
    write('home', 'writable/after-restart.txt', 'plain receiver still writes');
    await settle('code', home, vm);
    expect(read('vm', 'writable/after-restart.txt')).toBe('plain receiver still writes');
    owner('vm', 'writable', FOREIGN_ID, FOREIGN_ID);
    owner('vm', 'writable/after-restart.txt', userId!, groupId!);
    completed = true;
  });
});
