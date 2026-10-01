import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
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
  const projects: Record<string, { id: string; rootPath: string }> = {};

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
        if (url === '/rest/config/folders') return json([{ id: 'code:p1' }]);
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
          });
        }
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
      .overrideProvider(DB_CONNECTION)
      .useValue(drizzle(sqlite))
      .overrideProvider(STORAGE_SERVICE)
      .useValue({ getProject: async (id: string) => projects[id] })
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
  });

  afterAll(async () => {
    await app.close();
    await new Promise((resolve) => fake.close(resolve));
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  const calls = () => recorded.map((r) => `${r.method} ${r.url}`);

  it('discovers only real Git directories for initial sync and reads the installed layout thereafter', async () => {
    const sync = app.get(FileSyncService);
    mkdirSync(projects.gone.rootPath, { recursive: true });
    expect(await sync.initialFolders('gone')).toEqual([{ id: 'code:gone', kind: 'code' }]);
    writeFileSync(join(projects.gone.rootPath, '.git'), 'gitdir: /other/worktree');
    expect(await sync.initialFolders('gone')).toEqual([{ id: 'code:gone', kind: 'code' }]);
    mkdirSync(join(projects.repo.rootPath, '.git'), { recursive: true });
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

  it('refuses transcript shares', async () => {
    await expect(
      client.syncFolders('r1', {
        projectId: 'p1',
        kind: 'transcript',
        provider: 'claude',
        type: 'sendreceive',
        peerDeviceId: HOME_ID,
        ignores: [],
      } as never),
    ).rejects.toThrow();
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
  });

  it('scans, reverts and stops sharing a folder; stopping an unknown folder succeeds', async () => {
    await client.syncScan('r1', 'code:p1');
    await client.syncRevert('r1', 'code:p1');
    await client.syncRemoveFolder('r1', 'code:p1');
    await client.syncRemoveFolder('r1', 'code:gone');

    expect(calls()).toEqual([
      'POST /rest/db/scan?folder=code%3Ap1',
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
    [
      'a provider without file transcripts',
      { projectId: 'p1', kind: 'transcript', provider: 'opencode' },
    ],
    ['a transcript folder without a provider', { projectId: 'p1', kind: 'transcript' }],
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

  it('keeps per-project ignore patterns, defaulting to the build directories', async () => {
    const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    const url = `${baseUrl}/api/file-sync/projects/p1/ignores`;
    const put = (ignores: string[] | null) =>
      fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ignores }),
      }).then((r) => r.json());

    await expect(fetch(url).then((r) => r.json())).resolves.toEqual({
      ignores: [...DEFAULT_FILE_SYNC_IGNORES],
    });
    await expect(put(['(?d)vendor', '*.log'])).resolves.toEqual({
      ignores: ['(?d)vendor', '*.log'],
    });
    await expect(fetch(url).then((r) => r.json())).resolves.toEqual({
      ignores: ['(?d)vendor', '*.log'],
    });
    await expect(put(null)).resolves.toEqual({ ignores: [...DEFAULT_FILE_SYNC_IGNORES] });
  });
});
