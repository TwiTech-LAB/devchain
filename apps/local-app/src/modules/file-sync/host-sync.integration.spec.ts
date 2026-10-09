import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'fs';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { NotFoundError } from '../../common/errors/error-types';
import { GitService } from '../git/services/git.service';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { RemoteHostClient, RemoteHostRequestError } from '../remotes/operations/remote-host.client';
import { fixtureTls, installFixtureTlsFront } from '../../common/test/tls-fixture';
import { FILE_SYNC_PATHS, createProductionFileSyncPaths } from './file-sync-paths';
import { DEFAULT_FILE_SYNC_IGNORES } from './file-sync-ignores.store';
import { FileSyncService } from './file-sync.service';
import { FileSyncModule } from './file-sync.module';
import { SyncthingManager, type SyncthingConnection } from './syncthing-manager.service';
import { SyncthingRestClient } from './syncthing-rest.client';
import { SyncPathInspector } from './sync-path-inspector';
import { ChildProcessExecutor } from '../terminal/services/process-executor/child-process-executor';

// Backend integration: the host routes' contract is HTTP validation, the REST
// calls they make and their order, so a real Nest app drives a fake Syncthing
// REST server through the real RemoteHostClient. Real transfer is covered by
// file-sync.external.spec.ts.

const HOST_ID = Array(8).fill('HOSTAAA').join('-');
const HOME_ID = Array(8).fill('HOMEAAA').join('-');

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

describe('host sync routes', () => {
  let root: string;
  let sqlite: Database.Database;
  let fake: Server;
  let recorded: Recorded[];
  let app: NestFastifyApplication;
  let client: RemoteHostClient;
  let connection: SyncthingConnection | null;
  const foreignPaths = new Set<string>();
  let remoteNeedFiles: Array<{ name: string; deleted: boolean; type: string }> = [];
  let fileErrors: Array<{ path: string; error: string }> = [];
  const projects: Record<string, { id: string; rootPath: string }> = {};
  const git = {
    mirroredHead: jest.fn().mockResolvedValue('head1'),
    getConfigValue: jest.fn().mockResolvedValue(null),
    getVersion: jest.fn().mockResolvedValue({ major: 2, minor: 43, patch: 0 }),
    refreshIndexFromHead: jest.fn(),
  };

  it('inspects only VM-home folders, reports missing roots and refuses link escapes and traversal', async () => {
    const folder = mkdtempSync(join(homedir(), '.devchain-inspect-test-'));
    try {
      const inspect = (path: string, paths: string[] = [], patterns?: string[]) =>
        app.inject({
          method: 'POST',
          url: '/api/host/sync/inspect',
          payload: { path, scan: true, paths, patterns },
        });
      expect((await inspect(root)).statusCode).toBe(403);
      expect((await inspect(homedir())).statusCode).toBe(403);
      expect((await inspect(join(folder, 'missing'))).json()).toMatchObject({
        exists: false,
        repository: false,
        entries: [],
        candidates: [],
      });
      symlinkSync(root, join(folder, 'escape'));
      symlinkSync(folder, join(folder, 'alias'));
      symlinkSync(join(folder, 'missing'), join(folder, 'dangling'));
      for (const path of [
        join(folder, 'escape'),
        join(folder, 'escape/child'),
        join(folder, 'alias'),
        join(folder, 'alias/missing'),
        join(folder, 'dangling'),
      ])
        expect((await inspect(path)).statusCode).toBe(403);
      expect((await inspect(folder, ['../outside'])).statusCode).toBe(400);
      for (const [count, statusCode] of [
        [200, 200],
        [201, 400],
      ])
        expect((await inspect(folder, [], Array(count).fill('cache'))).statusCode).toBe(statusCode);
      mkdirSync(join(folder, '.git'));
      expect((await inspect(folder)).json()).toMatchObject({
        repository: false,
        gitState: 'error',
      });
      writeFileSync(join(folder, '.git/HEAD'), 'ref: refs/heads/main\n');
      expect((await inspect(folder)).json()).toMatchObject({
        repository: false,
        gitState: 'error',
      });
      execFileSync('git', ['init', '-q', folder]);
      writeFileSync(join(folder, '.gitignore'), 'logs/\n');
      mkdirSync(join(folder, 'logs'));
      writeFileSync(join(folder, 'logs/file'), 'runtime');
      foreignPaths.add(join(folder, 'logs/file'));
      const result = await client.syncInspect('r1', {
        path: folder,
        scan: true,
        paths: [],
        patterns: ['/.gitignore'],
      });
      expect(result).toMatchObject({
        exists: true,
        repository: true,
        gitState: 'repo',
        candidates: ['logs'],
        entries: [expect.objectContaining({ path: 'logs', kind: 'folder', ignored: true })],
        patternChecks: {
          state: 'checked',
          results: [
            {
              pattern: '/.gitignore',
              tracked: { count: 0, files: [], complete: true },
              kept: { count: 1, sample: ['.gitignore'] },
            },
          ],
        },
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-host-sync-'));
    projects.p1 = { id: 'p1', rootPath: join(root, 'repos', 'demo') };
    projects.home = { id: 'home', rootPath: homedir() };
    projects.repo = { id: 'repo', rootPath: join(root, 'repos', 'checkout') };
    projects.gone = { id: 'gone', rootPath: join(root, 'repos', 'gone') };

    fake = createServer((req, res) => {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      req.on('end', () => {
        const url = req.url ?? '';
        recorded.push({ method: req.method ?? '', url, body: text ? JSON.parse(text) : undefined });
        const json = (value: unknown) =>
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        if (url.includes('gone')) {
          return res.writeHead(404, { 'content-type': 'text/plain' }).end('no such folder');
        }
        if (url.includes('broken')) return res.writeHead(500).end('database unavailable');
        if (url.startsWith('/rest/db/remoteneed')) {
          const query = new URL(url, 'http://localhost').searchParams;
          const page = Number(query.get('page'));
          const perpage = Number(query.get('perpage'));
          return json({
            files: remoteNeedFiles.slice((page - 1) * perpage, page * perpage),
            page,
            perpage,
          });
        }
        if (url.startsWith('/rest/db/localchanged'))
          return json({ files: [{ name: 'edited.txt' }] });
        if (url === '/rest/config/folders') return json([{ id: 'code:p1' }]);
        if (url.startsWith('/rest/config/folders/'))
          return json({ type: 'receiveonly', paused: false, devices: [{ deviceID: HOME_ID }] });
        if (url.startsWith('/rest/system/connections')) {
          return json({ connections: { [HOME_ID]: { connected: true } } });
        }
        if (url.startsWith('/rest/db/status')) {
          return json({
            state: 'idle',
            localFiles: 4,
            localDirectories: 2,
            globalFiles: 4,
            globalDirectories: 2,
            needTotalItems: 0,
            needBytes: 0,
            receiveOnlyChangedFiles: 1,
            sequence: 7,
            ...(fileErrors.length && { errors: fileErrors.length }),
          });
        }
        if (url.startsWith('/rest/folder/errors')) return json({ errors: fileErrors });
        if (url.startsWith('/rest/db/completion')) {
          return json({ completion: 100, needItems: 0, needBytes: 0, remoteState: 'valid' });
        }
        json({});
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: join(__dirname, '../../../drizzle') });
    const moduleRef = await Test.createTestingModule({ imports: [FileSyncModule] })
      .overrideProvider(SyncPathInspector)
      .useValue(
        new SyncPathInspector(new ChildProcessExecutor(), {
          ...fs,
          lstat: async (path: string) =>
            Object.assign(await fs.lstat(path), { uid: foreignPaths.has(path) ? 0 : 1000 }),
        } as typeof fs),
      )
      .overrideProvider(DB_CONNECTION)
      .useValue(drizzle(sqlite))
      .overrideProvider(STORAGE_SERVICE)
      .useValue({
        listRemoteProjectBindings: async () => [],
        listFrozenProjects: async () => [],
        getProject: async (id: string) => {
          if (!projects[id]) throw new NotFoundError('Project', id);
          return projects[id];
        },
      })
      .overrideProvider(GitService)
      .useValue(git)
      .overrideProvider(FILE_SYNC_PATHS)
      .useValue(createProductionFileSyncPaths(join(root, 'home')))
      .overrideProvider(SyncthingManager)
      .useValue({
        getConnection: () => connection,
        getState: () => ({ error: 'Syncthing was not found on PATH or in ~/.devchain/bin.' }),
      })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    installFixtureTlsFront(app);
    await app.listen(0, '127.0.0.1');
    const baseUrl = `https://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    client = new RemoteHostClient(
      {
        getRemote: async () => ({
          id: 'r1',
          name: 'vm-1',
          baseUrl,
          kind: 'address',
          tlsCertificate: fixtureTls.cert,
        }),
      } as never,
      { get: async () => null, headers: async () => ({}) } as never,
    );
    connection = {
      client: new SyncthingRestClient(fakeUrl, 'test-key'),
      deviceId: HOST_ID,
      listenAddress: 'tcp://0.0.0.0:22001',
    };
  });

  beforeEach(() => {
    recorded = [];
    remoteNeedFiles = [];
    fileErrors = [];
    git.refreshIndexFromHead.mockReset();
    git.mirroredHead.mockReset().mockResolvedValue('head1');
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => fake.close(resolve));
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  const calls = () => recorded.map((r) => `${r.method} ${r.url}`);

  // HTTP plus the real service proves path ownership, request validation and REST configuration.
  it.each(['code', 'git'] as const)(
    'prepares the host %s backup without changing records, then clears force settings on restore',
    async (kind) => {
      const request = { projectId: 'p1', kind, forceCopy: { operationId: 'force-1' } };
      const path = join(root, 'home', '.devchain', 'sync-backups', 'p1', 'force-1', kind);
      const prepared = await app.inject({
        method: 'POST',
        url: '/api/host/sync/force-copy-backup',
        payload: request,
      });
      expect(prepared.statusCode).toBe(200);
      expect(prepared.json()).toEqual({ path });
      expect(existsSync(path)).toBe(true);
      expect(recorded).toEqual([]);
      expect(await client.syncForceCopyBackup('r1', request)).toEqual({ path });
      const folder = {
        ...request,
        type: 'receiveonly' as const,
        peerDeviceId: HOME_ID,
        ignores: [],
        paused: true,
      };
      expect(await client.syncFolders('r1', folder)).toMatchObject({ backupPath: path });
      expect(recorded[0].body).toMatchObject({
        maxConflicts: -1,
        versioning: {
          type: 'trashcan',
          fsPath: path,
          fsType: 'basic',
          params: { cleanoutDays: '0' },
        },
      });
      recorded = [];
      const { forceCopy: _forceCopy, ...connected } = folder;
      await client.syncFolders('r1', connected);
      expect(recorded[0].body).toMatchObject({
        maxConflicts: kind === 'git' ? 0 : 10,
        versioning: { type: '' },
      });
      expect(existsSync(path)).toBe(true);
    },
  );

  it('refuses force-copy path traversal and source-side versioning before any REST mutation', async () => {
    const pathOnly = { projectId: 'p1', kind: 'code', forceCopy: { operationId: '../escape' } };
    const invalidPath = await app.inject({
      method: 'POST',
      url: '/api/host/sync/force-copy-backup',
      payload: pathOnly,
    });
    expect(invalidPath.statusCode).toBe(400);
    const invalidSide = await app.inject({
      method: 'POST',
      url: '/api/host/sync/folders',
      payload: {
        ...pathOnly,
        forceCopy: { operationId: 'force-1' },
        type: 'sendonly',
        peerDeviceId: HOME_ID,
        ignores: [],
      },
    });
    expect(invalidSide.statusCode).toBe(400);
    expect(recorded).toEqual([]);
  });

  // app.inject verifies route wiring and real hook files; git-version probing is
  // the only external boundary stubbed, with actual git behavior covered by the guard spec.
  it('installs and removes the VM git guard using only the host project row, with idempotent removal', async () => {
    const projectId = 'guard-project';
    const checkout = join(root, 'guard-checkout');
    projects[projectId] = { id: projectId, rootPath: checkout };
    const hooks = join(checkout, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const name of ['reference-transaction', 'post-checkout']) {
      writeFileSync(join(hooks, name), '#!/bin/sh\necho user-hook\n');
    }
    const index = join(checkout, '.git', 'index');
    writeFileSync(index, 'staged-index');
    const url = `/api/host/projects/${projectId}/git-guard`;

    const installed = await app.inject({
      method: 'POST',
      url,
      payload: { homeName: 'home-pc', reason: 'disconnect' },
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toEqual({ warning: null });
    expect(readFileSync(join(hooks, 'reference-transaction'), 'utf8')).toContain(
      'This project is now on the PC',
    );
    expect(readFileSync(join(hooks, 'reference-transaction.devchain-saved'), 'utf8')).toContain(
      'user-hook',
    );

    const pcGit = await app.inject({
      method: 'POST',
      url,
      payload: { homeName: 'home-pc', reason: 'pc-git' },
    });
    expect(pcGit.statusCode).toBe(200);
    expect(pcGit.json()).toEqual({ warning: null });
    expect(readFileSync(join(hooks, 'reference-transaction'), 'utf8')).toContain(
      'Git for this project is on the PC',
    );

    const removed = await app.inject({ method: 'DELETE', url });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ removed: true, indexRefreshed: null, warning: null });
    for (const name of ['reference-transaction', 'post-checkout']) {
      expect(readFileSync(join(hooks, name), 'utf8')).toContain('user-hook');
    }
    const absent = await app.inject({ method: 'DELETE', url });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual({ removed: false, indexRefreshed: null, warning: null });
    expect(readFileSync(index, 'utf8')).toBe('staged-index');
    expect(git.refreshIndexFromHead).not.toHaveBeenCalled();
    expect(await client.removeGitGuard('r1', projectId, { refreshIndex: true })).toEqual({
      removed: false,
      indexRefreshed: true,
      warning: null,
    });
    git.refreshIndexFromHead.mockRejectedValueOnce(new Error('index locked'));
    expect(await client.removeGitGuard('r1', projectId, { refreshIndex: true })).toEqual({
      removed: false,
      indexRefreshed: false,
      warning: 'Git index rebuild failed: index locked',
    });
    expect(git.refreshIndexFromHead).toHaveBeenCalledWith(projectId, checkout);

    const invalid = await app.inject({
      method: 'POST',
      url,
      payload: { homeName: 'home-pc', reason: 'disconnect', rootPath: join(root, 'other') },
    });
    expect(invalid.statusCode).toBe(400);
    expect(readFileSync(join(hooks, 'reference-transaction'), 'utf8')).toContain('user-hook');

    rmSync(join(hooks, 'reference-transaction'));
    mkdirSync(join(hooks, 'reference-transaction'));
    const unreadable = await app.inject({ method: 'DELETE', url });
    expect(unreadable.statusCode).toBe(500);
    rmSync(join(hooks, 'reference-transaction'), { recursive: true });
    writeFileSync(join(hooks, 'reference-transaction'), '#!/bin/sh\necho user-hook\n');

    git.getConfigValue.mockResolvedValueOnce('/custom/hooks');
    const skipped = await app.inject({
      method: 'POST',
      url,
      payload: { homeName: 'home-pc', reason: 'cancelled-connect' },
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json().warning).toContain('core.hooksPath');
    expect(readFileSync(join(hooks, 'reference-transaction'), 'utf8')).toContain('user-hook');

    delete projects[projectId];
    for (const method of ['POST', 'DELETE'] as const) {
      const missing = await app.inject({
        method,
        url,
        ...(method === 'POST' ? { payload: { homeName: 'home-pc', reason: 'disconnect' } } : {}),
      });
      expect(missing.statusCode).toBe(404);
    }
    expect(recorded).toEqual([]);
  });

  // HTTP exercises the real controller and typed client; Git execution is the external boundary.
  it('rebuilds the VM index only after HEAD moved and reports retryable rebuild failures', async () => {
    const url = '/api/host/projects/p1/git-index';
    expect(await client.refreshGitIndex('r1', 'p1', 'head1')).toEqual({
      head: 'head1',
      refreshed: false,
      warning: null,
    });
    expect(git.refreshIndexFromHead).not.toHaveBeenCalled();
    git.mirroredHead.mockResolvedValue('head2');
    expect(await client.refreshGitIndex('r1', 'p1', 'head1')).toEqual({
      head: 'head2',
      refreshed: true,
      warning: null,
    });
    expect(git.refreshIndexFromHead).toHaveBeenCalledTimes(1);
    expect(git.refreshIndexFromHead).toHaveBeenCalledWith('p1', projects.p1.rootPath);
    git.refreshIndexFromHead.mockRejectedValueOnce(new Error('index locked'));
    expect(await client.refreshGitIndex('r1', 'p1', 'head1')).toEqual({
      head: 'head2',
      refreshed: false,
      warning: 'VM Git index rebuild failed: index locked',
    });
    expect(await client.refreshGitIndex('r1', 'p1', 'head1')).toEqual({
      head: 'head2',
      refreshed: true,
      warning: null,
    });
    git.mirroredHead.mockResolvedValue(null);
    expect(await client.refreshGitIndex('r1', 'p1', 'head2')).toEqual({
      head: null,
      refreshed: false,
      warning: null,
    });
    expect(git.refreshIndexFromHead).toHaveBeenCalledTimes(3);
    expect((await app.inject({ method: 'POST', url, payload: { since: 7 } })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/host/projects/missing/git-index',
          payload: { since: null },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('reads the VM folder configuration without changing its direction or pause state', async () => {
    expect(await client.syncFolderConfiguration('r1', 'git:p1')).toEqual({
      type: 'receiveonly',
      paused: false,
      devices: [{ deviceID: HOME_ID }],
    });
    expect(calls()).toEqual(['GET /rest/config/folders/git%3Ap1']);
    expect(
      (await app.inject({ method: 'GET', url: '/api/host/sync/folders/git:gone/configuration' }))
        .statusCode,
    ).toBe(404);
  });

  it('discovers only real Git directories for initial sync and reads the installed layout thereafter', async () => {
    const sync = app.get(FileSyncService);
    mkdirSync(projects.gone.rootPath, { recursive: true });
    expect(await sync.initialFolders('gone')).toEqual([{ id: 'code:gone', kind: 'code' }]);
    writeFileSync(join(projects.gone.rootPath, '.git'), 'gitdir: /other/worktree');
    expect(await sync.initialFolders('gone')).toEqual([{ id: 'code:gone', kind: 'code' }]);
    mkdirSync(join(projects.repo.rootPath, '.git'), { recursive: true });
    expect(await sync.initialFolders('repo')).toEqual([{ id: 'code:repo', kind: 'code' }]);
    writeFileSync(join(projects.repo.rootPath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    for (const folder of ['objects', 'refs'])
      mkdirSync(join(projects.repo.rootPath, '.git', folder), { recursive: true });
    expect(await sync.initialFolders('repo')).toEqual([
      { id: 'code:repo', kind: 'code' },
      { id: 'git:repo', kind: 'git' },
    ]);
    expect(await sync.projectFolders('repo')).toEqual([]);
    expect(await sync.projectFolders('p1')).toEqual([{ id: 'code:p1', kind: 'code' }]);
  });

  it('returns the device with the address pointed at the host name home dials', async () => {
    await expect(client.syncDevice('r1')).resolves.toEqual({
      deviceId: HOST_ID,
      address: 'tcp://127.0.0.1:22001',
    });
  });

  it('adds the peer as a trusted device that cannot push folders', async () => {
    await client.syncPeer('r1', { deviceId: HOME_ID, address: 'tcp://192.168.1.5:22000' });

    expect(recorded).toEqual([
      {
        method: 'PUT',
        url: `/rest/config/devices/${HOME_ID}`,
        body: {
          deviceID: HOME_ID,
          name: 'devchain-peer',
          addresses: ['tcp://192.168.1.5:22000'],
          autoAcceptFolders: false,
        },
      },
    ]);
  });

  it('creates a code folder paused, installs ignores, then unpauses it', async () => {
    const folder = await client.syncFolders('r1', {
      projectId: 'p1',
      kind: 'code',
      type: 'receiveonly',
      peerDeviceId: HOME_ID,
      ignores: [...DEFAULT_FILE_SYNC_IGNORES],
    });

    expect(folder).toEqual({
      id: 'code:p1',
      path: projects.p1.rootPath,
      type: 'receiveonly',
      paused: false,
    });
    expect(existsSync(projects.p1.rootPath)).toBe(true);
    expect(calls()).toEqual([
      'PUT /rest/config/folders/code%3Ap1',
      'POST /rest/db/ignores?folder=code%3Ap1',
      'PATCH /rest/config/folders/code%3Ap1',
    ]);
    expect(recorded[0].body).toMatchObject({
      id: 'code:p1',
      path: projects.p1.rootPath,
      type: 'receiveonly',
      devices: [{ deviceID: HOME_ID }],
      paused: true,
      fsWatcherDelayS: 1,
    });
    expect(recorded[1].body).toEqual({ ignore: [...DEFAULT_FILE_SYNC_IGNORES] });
    expect(recorded[2].body).toEqual({ paused: false, fsWatcherDelayS: 1 });
  });

  it('accepts 200 user plus 200 managed ignore patterns and refuses more', async () => {
    const request = (ignores: string[]) => ({
      projectId: 'p1',
      kind: 'code' as const,
      type: 'receiveonly' as const,
      peerDeviceId: HOME_ID,
      ignores,
      paused: true,
    });
    const ignores = Array.from({ length: 400 }, (_, i) => `/pattern-${i}`);
    await expect(client.syncFolders('r1', request(ignores))).resolves.toMatchObject({
      id: 'code:p1',
    });
    await expect(
      client.syncFolders('r1', request([...ignores, '/one-more'])),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('accepts the system git ignore outside the 200+200 cap and configures nested git independently', async () => {
    const ignores = ['/.git', ...Array.from({ length: 400 }, (_, i) => `/pattern-${i}`)];
    await expect(
      client.syncFolders('r1', {
        projectId: 'p1',
        kind: 'code',
        type: 'sendreceive',
        peerDeviceId: HOME_ID,
        ignores,
        paused: true,
      }),
    ).resolves.toMatchObject({ id: 'code:p1' });
    recorded = [];
    const result = await client.syncFolders('r1', {
      projectId: 'p1',
      kind: 'git',
      type: 'receiveonly',
      peerDeviceId: HOME_ID,
      ignores: ['*.lock'],
      paused: true,
    });
    expect(result).toMatchObject({ id: 'git:p1', path: join(projects.p1.rootPath, '.git') });
    expect(recorded[0].body).toMatchObject({
      maxConflicts: 0,
      path: join(projects.p1.rootPath, '.git'),
    });
    expect(existsSync(join(projects.p1.rootPath, '.git', '.git'))).toBe(false);
    recorded = [];
    await client.syncFolderType('r1', 'git:p1', {
      type: 'sendonly',
      ignores: ['*.lock', '/hooks', '/index'],
    });
    expect(recorded[0]).toMatchObject({
      method: 'POST',
      url: '/rest/db/ignores?folder=git%3Ap1',
      body: { ignore: ['*.lock', '/hooks', '/index'] },
    });
    expect(recorded[1]).toMatchObject({
      method: 'PATCH',
      body: { type: 'sendonly', fsWatcherDelayS: 1 },
    });
    await expect(
      client.syncFolderType('r1', 'git:gone', { type: 'receiveonly' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('leaves a folder paused when asked, for an ordered unpause', async () => {
    await client.syncFolders('r1', {
      projectId: 'p1',
      kind: 'code',
      type: 'receiveonly',
      peerDeviceId: HOME_ID,
      ignores: [],
      paused: true,
    });

    expect(calls()).toEqual([
      'PUT /rest/config/folders/code%3Ap1',
      'POST /rest/db/ignores?folder=code%3Ap1',
    ]);
  });

  it('sends fsWatcherDelayS with every folder PATCH', async () => {
    await client.syncFolderType('r1', 'code:p1', { type: 'sendonly' });
    await client.syncFolderType('r1', 'code:p1', { paused: true });

    expect(recorded.map((r) => [r.method, r.url, r.body])).toEqual([
      ['PATCH', '/rest/config/folders/code%3Ap1', { type: 'sendonly', fsWatcherDelayS: 1 }],
      ['PATCH', '/rest/config/folders/code%3Ap1', { paused: true, fsWatcherDelayS: 1 }],
    ]);
  });

  it('reports folder status with the host view of a device', async () => {
    await expect(client.syncStatus('r1', 'code:p1', HOME_ID)).resolves.toEqual({
      folderId: 'code:p1',
      state: 'idle',
      localFiles: 4,
      localDirectories: 2,
      globalFiles: 4,
      globalDirectories: 2,
      needTotalItems: 0,
      needBytes: 0,
      receiveOnlyChangedFiles: 1,
      peer: {
        deviceId: HOME_ID,
        completion: 100,
        needItems: 0,
        needBytes: 0,
        remoteState: 'valid',
      },
    });
    expect(calls()).toEqual([
      'GET /rest/db/status?folder=code%3Ap1',
      `GET /rest/db/completion?folder=code%3Ap1&device=${HOME_ID}`,
    ]);
    const paused = await app.inject({
      method: 'GET',
      url: '/api/host/sync/status?folder=code%3Ap1',
    });
    expect(paused.statusCode).toBe(200);
    expect(await client.syncFolderExists('r1', 'code:p1')).toBe(true);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/host/sync/status?folder=code%3Agone',
    });
    expect(missing.statusCode).toBe(404);
    expect(await client.syncFolderExists('r1', 'code:gone')).toBe(false);
    const broken = await app.inject({
      method: 'GET',
      url: '/api/host/sync/status?folder=code%3Abroken',
    });
    expect(broken.statusCode).toBe(502);
    await expect(client.syncFolderExists('r1', 'code:broken')).rejects.toMatchObject({
      status: 502,
    });
  });

  it('returns every error through errors=all while ordinary status retains its sample', async () => {
    fileErrors = Array.from({ length: 5 }, (_, index) => ({
      path: `logs/${index}`,
      error: 'permission denied',
    }));
    const sample = await app.inject({
      method: 'GET',
      url: '/api/host/sync/status?folder=code%3Ap1',
    });
    expect(sample.statusCode).toBe(200);
    expect(sample.json().fileErrors).toEqual(fileErrors.slice(0, 3));
    const full = await app.inject({
      method: 'GET',
      url: '/api/host/sync/status?folder=code%3Ap1&errors=all',
    });
    expect(full.statusCode).toBe(200);
    expect(full.json().fileErrors).toEqual(fileErrors);
    expect(
      (await client.syncStatus('r1', 'code:p1', undefined, { allErrors: true })).fileErrors,
    ).toEqual(fileErrors);
    expect(calls()).toContain('GET /rest/folder/errors?folder=code%3Ap1');
  });

  it('reports every remote-needed file/deletion across pages, with a capped sample and strict route query', async () => {
    remoteNeedFiles = [
      { name: 'directory', deleted: false, type: 'FILE_INFO_TYPE_DIRECTORY' },
      ...Array.from({ length: 1001 }, (_, index) => ({
        name: index >= 999 ? `file-${index}.sync-conflict-old.txt` : `file-${index}.txt`,
        deleted: index % 10 === 0,
        type: 'FILE_INFO_TYPE_FILE',
      })),
      { name: 'old-directory', deleted: true, type: 'FILE_INFO_TYPE_DIRECTORY' },
    ];
    const url = `/api/host/sync/folders/code%3Ap1/remote-need?device=${HOME_ID}`;
    const answer = await app.inject({ method: 'GET', url });
    expect(answer.statusCode).toBe(200);
    const report = answer.json();
    expect(report).toMatchObject({ total: 1001, deleted: 101 });
    expect(report.sample).toHaveLength(20);
    expect(report.sample[0]).toEqual({ path: 'file-0.txt', deleted: true });
    expect(report.conflictPaths).toEqual([
      'file-999.sync-conflict-old.txt',
      'file-1000.sync-conflict-old.txt',
    ]);
    expect(report.conflictsOverCap).toBe(false);
    expect(calls()).toEqual(
      [1, 2].map(
        (page) =>
          `GET /rest/db/remoteneed?folder=code%3Ap1&device=${HOME_ID}&page=${page}&perpage=1000`,
      ),
    );
    await expect(client.syncRemoteNeed('r1', 'code:p1', HOME_ID)).resolves.toEqual(report);
    for (const invalid of [
      url.replace(HOME_ID, 'bad-device'),
      `${url}&extra=1`,
      '/api/host/sync/folders/code%3Ap1/remote-need',
    ]) {
      expect((await app.inject({ method: 'GET', url: invalid })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url: url.replace('p1', 'broken') })).statusCode).toBe(
      502,
    );
    remoteNeedFiles = Array.from({ length: 1000 }, (_, index) => ({
      name: `${index}.sync-conflict-old.txt`,
      deleted: false,
      type: 'FILE_INFO_TYPE_FILE',
    }));
    const atCap = (await app.inject({ method: 'GET', url })).json();
    expect(atCap.conflictsOverCap).toBe(false);
    expect(atCap.conflictPaths).toHaveLength(1000);
    remoteNeedFiles.push({
      name: 'overflow.sync-conflict-old.txt',
      deleted: false,
      type: 'FILE_INFO_TYPE_FILE',
    });
    const overCap = (await app.inject({ method: 'GET', url })).json();
    expect(overCap).toMatchObject({ total: 1001, conflictPaths: [], conflictsOverCap: true });
  });

  it('scans, overrides, lists receive-only changes, reverts and stops sharing a folder', async () => {
    await client.syncScan('r1', 'code:p1');
    const overridden = await app.inject({
      method: 'POST',
      url: '/api/host/sync/folders/code%3Ap1/override',
    });
    expect(overridden.statusCode).toBe(204);
    await client.syncOverride('r1', 'git:p1');
    expect(await client.syncLocalChanges('r1', 'code:p1')).toEqual({
      count: 1,
      sample: ['edited.txt'],
    });
    await client.syncRevert('r1', 'code:p1');
    await client.syncRemoveFolder('r1', 'code:p1');
    await client.syncRemoveFolder('r1', 'code:gone');

    expect(calls()).toEqual([
      'POST /rest/db/scan?folder=code%3Ap1',
      'POST /rest/db/override?folder=code%3Ap1',
      'POST /rest/db/override?folder=git%3Ap1',
      'GET /rest/db/status?folder=code%3Ap1',
      'GET /rest/db/localchanged?folder=code%3Ap1&page=1&perpage=200',
      'POST /rest/db/revert?folder=code%3Ap1',
      'DELETE /rest/config/folders/code%3Ap1',
      'DELETE /rest/config/folders/code%3Agone',
    ]);
  });

  it('keeps Syncthing markers, conflict copies and temp files out of git in a code folder that is a repository', async () => {
    const checkout = projects.repo.rootPath;
    mkdirSync(join(checkout, '.git', 'info'), { recursive: true });
    writeFileSync(join(checkout, '.git', 'info', 'exclude'), '# local\n*.swp');
    const share = () =>
      client.syncFolders('r1', {
        projectId: 'repo',
        kind: 'code',
        type: 'receiveonly',
        peerDeviceId: HOME_ID,
        ignores: [],
      });

    await share();
    await share();

    expect(readFileSync(join(checkout, '.git', 'info', 'exclude'), 'utf8')).toBe(
      '# local\n*.swp\n/.stfolder\n/.stignore\n/.stversions\n*.sync-conflict-*\n.syncthing.*.tmp\n~syncthing~*.tmp\n',
    );
  });

  it('reports per folder what this instance still needs, skipping folders it does not share', async () => {
    const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const status = (projectId: string) =>
      fetch(`${baseUrl}/api/file-sync/projects/${projectId}/status`).then((r) => r.json());

    await expect(status('p1')).resolves.toEqual({
      folders: [{ id: 'code:p1', needItems: 0, needBytes: 0 }],
    });
    await expect(status('gone')).resolves.toEqual({ folders: [] });

    const saved = connection;
    connection = null;
    try {
      await expect(status('p1')).resolves.toEqual({ folders: null });
    } finally {
      connection = saved;
    }
  });

  it.each([
    ['a HOME-rooted code folder', { projectId: 'home', kind: 'code' }],
    ['an invalid peer device id', { projectId: 'p1', kind: 'code', peerDeviceId: 'nope' }],
  ])('rejects %s with 400 before touching Syncthing', async (_case, fields) => {
    const error: unknown = await client
      .syncFolders('r1', {
        type: 'receiveonly',
        peerDeviceId: HOME_ID,
        ignores: [],
        ...fields,
      } as never)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RemoteHostRequestError);
    expect((error as RemoteHostRequestError).status).toBe(400);
    expect(recorded).toEqual([]);
  });

  it('answers 503 while Syncthing is not running', async () => {
    const saved = connection;
    connection = null;
    try {
      const error: unknown = await client.syncDevice('r1').catch((e: unknown) => e);
      expect(error).toMatchObject({
        status: 503,
        details: expect.objectContaining({ hostCode: 'FILE_SYNC_UNAVAILABLE' }),
      });
    } finally {
      connection = saved;
    }
  });

  it('reads desired ignores but no longer accepts the store-only PUT', async () => {
    const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const url = `${baseUrl}/api/file-sync/projects/p1/ignores`;

    await expect(fetch(url).then((r) => r.json())).resolves.toEqual({
      ignores: [...DEFAULT_FILE_SYNC_IGNORES],
      revision: 0,
    });
    const removed = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ignores: [] }),
    });
    expect(removed.status).toBe(404);
    app.get(FileSyncService).setIgnores('p1', ['(?d)vendor', '*.log']);
    await expect(fetch(url).then((r) => r.json())).resolves.toEqual({
      ignores: ['(?d)vendor', '*.log'],
      revision: 1,
    });
  });
});
