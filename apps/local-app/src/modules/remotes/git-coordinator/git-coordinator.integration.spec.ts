import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { FILE_SYNC_PATHS, createProductionFileSyncPaths } from '../../file-sync/file-sync-paths';
import { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import { HostSyncController } from '../../file-sync/host-sync.controller';
import { HostGitGuardController } from '../../file-sync/host-git-guard.controller';
import { GitService } from '../../git/services/git.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import {
  GitCoordinatorService,
  GIT_COORDINATOR_TIMINGS,
  DEFAULT_GIT_COORDINATOR_TIMINGS,
} from './git-coordinator.service';
import { GitCoordinatorIndexService } from './git-coordinator-index.service';
import { GitCoordinatorStore } from './git-coordinator.store';
import { GitProcessIdentity } from './git-process-identity';
import { HostGitCoordinatorController } from './host-git-coordinator.controller';
import { VmGitCoordinatorController } from './vm-git-coordinator.controller';
import type { GitCoordinatorRecord } from './git-coordinator.dto';
import { exportIndexSnapshot, refsDigest } from './git-checkpoint';

// Integration is required for SQLite reopen, real staged indexes, process identity,
// and HTTP fencing. Syncthing is the only external system replaced here.
describe('VM Git coordinator persistence and host API', () => {
  let directory: string;
  let root: string;
  let sqlite: Database.Database;
  let app: NestFastifyApplication;
  let coordinator: GitCoordinatorService;
  let store: GitCoordinatorStore;
  let indexes: GitCoordinatorIndexService;
  let direction: string;
  const files = {
    folderPath: jest.fn(),
    updateFolder: jest.fn(),
    ensureFolder: jest.fn(),
    removeFolder: jest.fn(),
    rescan: jest.fn(),
    revertLocalChanges: jest.fn(),
    override: jest.fn(),
    projectFolders: jest.fn(),
    status: jest.fn(),
  };
  const guard = { install: jest.fn(), remove: jest.fn() };
  const git = { mirroredHead: jest.fn(), refreshIndexFromHead: jest.fn() };
  const initialFence = { expectedGeneration: 0, transitionId: null };

  async function openApp(): Promise<void> {
    const module = await Test.createTestingModule({
      controllers: [
        HostSyncController,
        HostGitGuardController,
        HostGitCoordinatorController,
        VmGitCoordinatorController,
      ],
      providers: [
        GitCoordinatorService,
        GitCoordinatorStore,
        GitCoordinatorIndexService,
        GitProcessIdentity,
        { provide: DB_CONNECTION, useValue: drizzle(sqlite) },
        { provide: FileSyncService, useValue: files },
        { provide: HomeGitGuardService, useValue: guard },
        { provide: GitService, useValue: git },
        { provide: SyncPathInspector, useValue: {} },
        { provide: ProcessExecutor, useClass: ChildProcessExecutor },
        {
          provide: FILE_SYNC_PATHS,
          useValue: createProductionFileSyncPaths(join(directory, 'home')),
        },
        {
          provide: GIT_COORDINATOR_TIMINGS,
          useValue: {
            ...DEFAULT_GIT_COORDINATOR_TIMINGS,
            acquireMs: 0,
            pollMs: 1_000_000,
            gcMs: Infinity,
          },
        },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    coordinator = app.get(GitCoordinatorService);
    store = app.get(GitCoordinatorStore);
    indexes = app.get(GitCoordinatorIndexService);
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'git-coordinator-'));
    root = join(directory, 'checkout');
    execFileSync('git', ['init', '-q', root]);
    const template = createTestDatabase();
    await writeFile(join(directory, 'db.sqlite'), template.sqlite.serialize());
    template.sqlite.close();
    sqlite = new Database(join(directory, 'db.sqlite'));
    direction = 'receiveonly';
    files.folderPath.mockImplementation(async (_id: string, kind?: string) =>
      kind === 'git' ? join(root, '.git') : root,
    );
    files.updateFolder.mockImplementation(async (_id: string, patch: { type?: string }) => {
      if (patch.type) direction = patch.type;
    });
    guard.remove.mockResolvedValue({ removed: true, warning: null });
    guard.install.mockResolvedValue(null);
    git.mirroredHead.mockResolvedValue(null);
    await openApp();
  });
  afterEach(async () => {
    await app.close();
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function restart(): Promise<void> {
    await app.close();
    sqlite.close();
    sqlite = new Database(join(directory, 'db.sqlite'));
    await openApp();
  }

  async function homeRecord(): Promise<GitCoordinatorRecord> {
    await writeFile(join(root, 'staged.txt'), 'staged home contents\n');
    execFileSync('git', ['-C', root, 'add', 'staged.txt']);
    await indexes.save('p', await readFile(join(root, '.git/index')));
    const record: GitCoordinatorRecord = {
      ...store.read('p'),
      owner: 'home',
      generation: 7,
      homeName: 'offline-PC',
      checkpoint: { writeId: 'write', generation: 7, refsDigest: 'refs', at: 1 },
    };
    store.write('p', record);
    execFileSync('git', ['-C', root, 'read-tree', '--empty']);
    return record;
  }

  it.each(['sending', 'unguarding', 'index', 'publishing'] as const)(
    'resumes after a crash during reclaim phase %s with the staged index intact',
    async (phase) => {
      await homeRecord();
      if (phase === 'sending')
        files.updateFolder.mockImplementationOnce(async () => {
          direction = 'sendonly';
          throw new Error('crash');
        });
      if (phase === 'unguarding') guard.remove.mockRejectedValueOnce(new Error('crash'));
      if (phase === 'index') {
        const install = indexes.install.bind(indexes);
        jest.spyOn(indexes, 'install').mockImplementationOnce(async (...args) => {
          await install(...args);
          throw new Error('crash');
        });
      }
      if (phase === 'publishing') {
        const write = store.write.bind(store);
        jest.spyOn(store, 'write').mockImplementation((id, record) => {
          if (record.owner === 'vm') throw new Error('crash');
          write(id, record);
        });
      }
      await expect(coordinator.withVmPermit('p', async () => 'unsafe')).rejects.toThrow('crash');
      expect(store.read('p')).toMatchObject({
        owner: 'home',
        transition: { kind: 'reclaim', phase },
      });
      await restart();
      await coordinator.poll();
      expect(store.read('p')).toMatchObject({
        owner: 'vm',
        generation: 8,
        homeWrites: {},
        transition: null,
      });
      expect(direction).toBe('sendonly');
      expect(
        execFileSync('git', ['-C', root, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }),
      ).toBe('staged.txt\n');
      expect(await coordinator.withVmPermit('p', async () => 'usable')).toBe('usable');
    },
  );

  (process.platform === 'linux' ? it : it.skip)(
    're-adopts a live real Git child across VM DevChain restart and drains only after exit',
    async () => {
      const child = spawn('git', ['hash-object', '--stdin'], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      await once(child, 'spawn');
      try {
        const identity = await app.get(GitProcessIdentity).read(child.pid!);
        expect(typeof identity).toBe('string');
        const request = { holdId: 'child', pid: child.pid!, processStartTime: identity as string };
        await coordinator.acquireVmHold('p', request);
        await restart();
        expect((await coordinator.status('p')).vmHolds.child.pid).toBe(child.pid);
        await coordinator.beginHandover('p', { ...initialFence, id: 'handover', homeName: 'PC' });
        await expect(
          coordinator.handoverStep(
            'p',
            { expectedGeneration: 0, transitionId: 'handover' },
            async () => 'unsafe',
          ),
        ).rejects.toThrow('still hold');
        expect((await coordinator.status('p')).transition?.phase).toBe('draining');
        const exited = once(child, 'exit');
        child.stdin.end('contents');
        await exited;
        await coordinator.poll();
        expect((await coordinator.status('p')).vmHolds).toEqual({});
        expect(
          await coordinator.handoverStep(
            'p',
            { expectedGeneration: 0, transitionId: 'handover' },
            async () => 'drained',
          ),
        ).toBe('drained');
      } finally {
        if (child.exitCode === null) child.kill();
      }
    },
  );

  it('keeps an unborn repository usable with an empty saved index', async () => {
    const record = await homeRecord();
    await indexes.save('p', Buffer.alloc(0));
    store.write('p', record);
    await coordinator.withVmPermit('p', async () => undefined);
    expect(execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })).toBe('');
    expect(
      execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }),
    ).toContain('?? staged.txt');
  });

  it.each([
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
    ['sequencer', 'a cherry-pick or revert sequence'],
  ])('refuses reclaim while the root contains %s', async (marker, operation) => {
    await homeRecord();
    const path = join(root, '.git', marker);
    if (marker.startsWith('rebase-') || marker === 'sequencer') await mkdir(path);
    else await writeFile(path, 'unfinished');
    await expect(coordinator.withVmPermit('p', async () => 'unsafe')).rejects.toThrow(
      `offline-PC': Git there is in the middle of ${operation}.`,
    );
    expect(store.read('p').owner).toBe('home');
    expect(direction).toBe('receiveonly');
  });

  it('resumes its own index.lock but preserves an unrelated writer lock', async () => {
    await homeRecord();
    const ours = join(root, '.git/index.devchain-reclaim.lock');
    await writeFile(ours, await indexes.read('p'));
    await link(ours, join(root, '.git/index.lock'));
    await indexes.install('p', 'reclaim');
    expect(execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' })).toBe(
      'staged.txt\n',
    );
    await writeFile(join(root, '.git/index.lock'), 'foreign lock');
    await expect(indexes.install('p', 'reclaim')).rejects.toThrow('another writer');
    expect(await readFile(join(root, '.git/index.lock'), 'utf8')).toBe('foreign lock');
  });

  it('refuses stale generations on every Git-mutating host route before effects', async () => {
    store.write('p', { ...store.read('p'), generation: 1 });
    const query = '?expectedGeneration=0&transitionId=none';
    const stale = { expectedGeneration: 0, transitionId: null };
    const folder = {
      projectId: 'p',
      kind: 'git',
      type: 'receiveonly',
      peerDeviceId: Array(8).fill('HOMEAAA').join('-'),
      ignores: [],
    };
    const cases = [
      { method: 'POST', url: `/api/host/sync/folders${query}`, payload: folder },
      {
        method: 'PATCH',
        url: `/api/host/sync/folders/git:p${query}`,
        payload: { type: 'receiveonly' },
      },
      { method: 'DELETE', url: `/api/host/sync/folders/git:p${query}` },
      ...['scan', 'revert', 'override'].map((action) => ({
        method: 'POST',
        url: `/api/host/sync/folders/git:p/${action}${query}`,
      })),
      {
        method: 'POST',
        url: '/api/host/projects/p/git-guard',
        payload: { ...stale, homeName: 'PC', reason: 'pc-git' },
      },
      { method: 'DELETE', url: '/api/host/projects/p/git-guard', payload: stale },
      {
        method: 'POST',
        url: '/api/host/projects/p/git-coordinator/home-write-begin',
        payload: { ...stale, writeId: 'write', homeName: 'PC' },
      },
      {
        method: 'POST',
        url: '/api/host/projects/p/git-coordinator/home-write-end',
        payload: { ...stale, writeId: 'write', refsDigest: 'refs', indexBase64: '' },
      },
      {
        method: 'POST',
        url: '/api/host/projects/p/git-coordinator/handover-begin',
        payload: { ...stale, id: 'h', homeName: 'PC' },
      },
      ...['renew', 'abort', 'phase', 'complete'].map((action) => ({
        method: 'POST',
        url: `/api/host/projects/p/git-coordinator/handover-${action}`,
        payload: { ...stale, ...(action === 'phase' ? { phase: 'draining' } : {}) },
      })),
    ];
    for (const request of cases) {
      const response = await app.inject({
        ...request,
        method: request.method as 'POST' | 'PATCH' | 'DELETE',
      });
      expect({
        route: request.url,
        status: response.statusCode,
        code: response.json().code,
      }).toEqual({ route: request.url, status: 409, code: 'GIT_GENERATION_MISMATCH' });
    }
    expect(files.ensureFolder).not.toHaveBeenCalled();
    expect(files.updateFolder).not.toHaveBeenCalled();
    expect(guard.install).not.toHaveBeenCalled();
    expect(guard.remove).not.toHaveBeenCalled();
    expect(git.refreshIndexFromHead).not.toHaveBeenCalled();
  });

  it('requires a fence for Git routes, leaves code sync usable, and enforces loopback holds', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/host/sync/folders/git:p/revert' })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/host/sync/folders/code:p/revert' }))
        .statusCode,
    ).toBe(204);
    expect(files.revertLocalChanges).toHaveBeenCalledWith('code:p');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/git-coordinator/projects/p/acquire',
          remoteAddress: '192.0.2.1',
          payload: { holdId: 'h', pid: 1, processStartTime: 'fake' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/git-coordinator/projects/p/acquire',
          payload: { holdId: 'h', pid: process.pid, processStartTime: 'fake' },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('journals each handover phase before its effect and publishes home ownership with the write', async () => {
    await writeFile(join(root, 'staged.txt'), 'staged on the VM\n');
    execFileSync('git', ['-C', root, 'add', 'staged.txt']);
    files.projectFolders.mockResolvedValue([
      { id: 'code:p', kind: 'code' },
      { id: 'git:p', kind: 'git' },
    ]);
    files.status.mockImplementation(async (id: string) => ({ sequence: id === 'git:p' ? 9 : 4 }));
    const phases: (string | undefined)[] = [];
    files.updateFolder.mockImplementation(async () => {
      const transition = store.read('p').transition;
      phases.push(transition?.kind === 'handover' ? transition.phase : undefined);
    });
    const phase = (body: object) =>
      app.inject({
        method: 'POST',
        url: '/api/host/projects/p/git-coordinator/handover-phase',
        payload: body,
      });
    const fence = { expectedGeneration: 0, transitionId: 'handover' };
    await coordinator.beginHandover('p', { ...initialFence, id: 'handover', homeName: 'PC' });
    store.write('p', {
      ...store.read('p'),
      vmHolds: { agent: { pid: process.pid, processStartTime: 'unused', startedAt: 1 } },
    });
    jest.spyOn(app.get(GitProcessIdentity), 'read').mockResolvedValue('unused');
    const held = await phase({ ...fence, phase: 'draining' });
    expect([held.statusCode, held.json().code]).toEqual([409, 'GIT_VM_HELD']);
    expect(guard.install).not.toHaveBeenCalled();
    store.write('p', { ...store.read('p'), vmHolds: {} });

    const drained = await phase({ ...fence, phase: 'draining' });
    expect(drained.json().transition).toMatchObject({
      phase: 'draining',
      sequences: { 'code:p': 4, 'git:p': 9 },
    });
    expect(guard.install).toHaveBeenCalledWith('p', { homeName: 'PC', reason: 'pc-git' });
    expect((await phase({ ...fence, phase: 'home-sending' })).statusCode).toBe(409);
    expect((await phase({ ...fence, phase: 'vm-receiving' })).statusCode).toBe(200);
    expect(files.updateFolder).toHaveBeenCalledWith(
      'git:p',
      expect.objectContaining({ type: 'receiveonly' }),
    );
    expect(phases).toEqual(['vm-receiving']);
    expect((await phase({ ...fence, phase: 'home-sending' })).statusCode).toBe(200);
    expect((await phase({ ...fence, phase: 'published' })).statusCode).toBe(400);
    const published = await phase({ ...fence, phase: 'published', writeId: 'write' });
    expect(published.json()).toMatchObject({
      owner: 'home',
      generation: 1,
      homeWrites: { write: expect.any(Number) },
      transition: { id: 'handover', phase: 'published' },
    });
    // No reclaim and no new VM hold while the PC finishes.
    await expect(coordinator.withVmPermit('p', async () => 'unsafe')).rejects.toThrow(
      'handover is pending',
    );
    const index = await app.inject({
      method: 'GET',
      url: '/api/host/projects/p/git-coordinator/index',
    });
    const snapshot = join(directory, 'snapshot');
    await writeFile(snapshot, Buffer.from(index.json().indexBase64, 'base64'));
    expect(
      execFileSync('git', ['-C', root, 'ls-files'], {
        encoding: 'utf8',
        env: { ...process.env, GIT_INDEX_FILE: snapshot },
      }),
    ).toBe('staged.txt\n');
    const complete = await app.inject({
      method: 'POST',
      url: '/api/host/projects/p/git-coordinator/handover-complete',
      payload: { expectedGeneration: 1, transitionId: 'handover' },
    });
    expect(complete.json()).toMatchObject({ owner: 'home', generation: 1, transition: null });
  });

  // Real Git on both sides: the refs digest, object checks and index stages are Git's own formats.
  it('confirms a home write only once the VM has its refs and objects, then installs its index', async () => {
    const pc = join(directory, 'pc');
    const pcGit = (...args: string[]) =>
      execFileSync(
        'git',
        ['-C', pc, '-c', 'user.name=PC', '-c', 'user.email=pc@example.com', ...args],
        {
          encoding: 'utf8',
        },
      );
    execFileSync('git', ['init', '-q', '-b', 'main', pc]);
    await writeFile(join(pc, 'merge.txt'), 'base\n');
    await writeFile(join(pc, 'partial.txt'), 'one\n');
    pcGit('add', '.');
    pcGit('commit', '-qm', 'base');
    pcGit('switch', '-qc', 'other');
    await writeFile(join(pc, 'merge.txt'), 'other\n');
    pcGit('commit', '-qam', 'other');
    pcGit('switch', '-q', 'main');
    await writeFile(join(pc, 'merge.txt'), 'main\n');
    pcGit('commit', '-qam', 'main');
    expect(() => pcGit('merge', '-q', 'other')).toThrow();
    pcGit('update-index', '--split-index');
    await writeFile(join(pc, 'partial.txt'), 'staged\n');
    pcGit('add', 'partial.txt');
    await writeFile(join(pc, 'partial.txt'), 'unstaged\n');
    const executor = new ChildProcessExecutor();
    const capture = async (writeId: string) => ({
      ...initialFence,
      writeId,
      refsDigest: await refsDigest(executor, pc),
      indexBase64: (await exportIndexSnapshot(executor, pc)).toString('base64'),
    });
    // Syncthing's git folder ignores the index; split-index files are left out to prove the
    // snapshot does not need them.
    const sync = () =>
      cp(join(pc, '.git'), join(root, '.git'), {
        recursive: true,
        filter: (path) => !/\/(index|sharedindex\.[0-9a-f]+)$/.test(path),
      });
    const end = async (payload: object) =>
      app.inject({
        method: 'POST',
        url: '/api/host/projects/p/git-coordinator/home-write-end',
        payload,
      });
    store.write('p', { ...store.read('p'), owner: 'home' });
    await coordinator.homeWriteBegin('p', { ...initialFence, writeId: 'write', homeName: 'PC' });
    const write = await capture('write');

    const noRefs = await end(write);
    expect([noRefs.statusCode, noRefs.json().code]).toEqual([409, 'GIT_CHECKPOINT_INCOMPLETE']);
    await sync();
    const staged = pcGit('rev-parse', ':partial.txt').trim();
    await rm(join(root, '.git', 'objects', staged.slice(0, 2), staged.slice(2)));
    const noObject = await end(write);
    expect([noObject.statusCode, noObject.json().code]).toEqual([409, 'GIT_CHECKPOINT_INCOMPLETE']);
    expect(store.read('p').homeWrites.write).toEqual(expect.any(Number));

    await sync();
    expect((await end(write)).statusCode).toBe(200);
    const vmIndex = execFileSync('git', ['-C', root, 'ls-files', '--stage'], { encoding: 'utf8' });
    expect(vmIndex).toBe(pcGit('ls-files', '--stage'));
    expect(vmIndex).toMatch(/ 1\tmerge\.txt\n.* 2\tmerge\.txt\n.* 3\tmerge\.txt\n/);

    await coordinator.homeWriteBegin('p', { ...initialFence, writeId: 'newer', homeName: 'PC' });
    expect((await end(await capture('newer'))).statusCode).toBe(200);
    const retried = await end({ ...write, refsDigest: 'stale' });
    expect(retried.statusCode).toBe(200);
    await restart();
    const status = await app.inject({ method: 'GET', url: '/api/host/projects/p/git-coordinator' });
    expect(status.json()).toMatchObject({
      owner: 'home',
      homeWrites: {},
      checkpoint: { writeId: 'newer', generation: 0 },
      confirmedWrites: { write: expect.any(Object), newer: expect.any(Object) },
    });
    expect((await indexes.read('p')).subarray(0, 4).toString()).toBe('DIRC');
  });
});
