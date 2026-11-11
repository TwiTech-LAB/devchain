import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type Database from 'better-sqlite3';
import { HOST_VAULT_CONTENT_TYPE, type HostVaultPush } from '@devchain/shared';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../../../common/config/env.config';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import {
  RUNTIME_DIRECTORY_HOST,
  type RuntimeDirectoryHost,
} from '../../runtime-directory/runtime-directory';
import { RuntimeDirectoryService } from '../../runtime-directory/runtime-directory.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import type { VaultSnapshot } from '../../storage/models/domain.models';
import { vaultSnapshotRevision } from '../../vault/vault-snapshot-revision';
import { VAULT_VM_CACHE_FILE, VaultVmCacheService } from '../../vault/vault-vm-cache.service';
import { HostApiKeyService } from './host-api-key.service';
import { HostHelperService } from './host-helper.service';
import { HostJsonBodyParser } from './host-json-body.parser';
import { HostVaultController } from './host-vault.controller';

const mockLogLines: unknown[] = [];
jest.mock('../../../common/logging/logger', () => {
  const record = (...args: unknown[]) => mockLogLines.push(args);
  const child = { info: record, warn: record, error: record, debug: record };
  return { createLogger: () => child, logger: child };
});

const TMPFS = 0x01021994;
const EXT4 = 0xef53;
const KEY = `dck_${'a'.repeat(43)}`;
const SECRET = 'canary-vm-secret-7f3a';
const FILE = '-----BEGIN KEY-----\ncanary-vm-file-91c2\n-----END KEY-----\n';
const base64 = (value: string) => Buffer.from(value).toString('base64');

type Entry = VaultSnapshot['entries'][number];
const secret: Entry = {
  id: 'e-secret',
  projectId: null,
  name: 'API_TOKEN',
  kind: 'secret',
  description: 'Token for the API',
  revision: 3,
  approvalRequired: false,
};
const file: Entry = {
  id: 'e-file',
  projectId: 'A',
  name: 'DEPLOY_KEY',
  kind: 'file',
  description: 'Deploy key',
  revision: 1,
  approvalRequired: false,
};

function push(
  entries: Entry[],
  grants: VaultSnapshot['grants'],
  values: Record<string, string> = {},
  access: VaultSnapshot['access'] = [],
  approvals: VaultSnapshot['approvals'] = [],
): HostVaultPush {
  return {
    revision: vaultSnapshotRevision({ entries, grants, access, approvals }),
    entries,
    grants,
    access,
    approvals,
    values: entries.map((entry) => ({
      entryId: entry.id,
      revision: entry.revision,
      valueBase64: base64(values[entry.id] ?? `value of ${entry.name}`),
    })),
  };
}

const FULL = push(
  [secret, file],
  [
    { entryId: 'e-secret', projectId: 'A', familySlug: 'coder' },
    { entryId: 'e-secret', projectId: 'B', familySlug: null },
    { entryId: 'e-file', projectId: 'A', familySlug: null },
  ],
  { 'e-secret': SECRET, 'e-file': FILE },
  [
    { projectId: 'A', familySlug: 'coder' },
    { projectId: 'B', familySlug: null },
  ],
);

// Layer: VM API integration. The key check, the body parser, schema, tmpfs check,
// cache file and snapshot rows meet only at this route, over real SQLite and files.
describe('Host Vault push API', () => {
  let root: string;
  let runtimeDir: string;
  let fsType: number;
  let systemdEnv: boolean;
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let cache: VaultVmCacheService;
  let runtimeDirectory: RuntimeDirectoryService;
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'host-vault-'));
    runtimeDir = join(root, 'run');
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(join(root, '.devchain'));
    writeFileSync(join(root, 'claim.json'), JSON.stringify({ homePath: root }));
    writeFileSync(
      join(root, '.devchain', 'host-api-key'),
      `${createHash('sha256').update(KEY).digest('hex')}\n`,
    );
    jest
      .spyOn(config, 'getEnvConfig')
      .mockReturnValue({ ...config.getEnvConfig(), DEVCHAIN_HOST_ETC_DIR: root });
    fsType = TMPFS;
    systemdEnv = true;
    const host: RuntimeDirectoryHost = {
      platform: 'linux',
      dbPath: join(root, 'devchain.db'),
      env: () => (systemdEnv ? { RUNTIME_DIRECTORY: runtimeDir } : {}),
      isLingering: () => false,
      fileSystemType: async () => fsType,
    };

    const database = createTestDatabase();
    sqlite = database.sqlite;
    for (const id of ['A', 'B']) {
      sqlite
        .prepare(
          `INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, 'T', 'T')`,
        )
        .run(id, `Project ${id}`, `/tmp/${id}`);
    }
    storage = new LocalStorageService(database.db);
    moduleRef = await Test.createTestingModule({
      controllers: [HostVaultController],
      providers: [
        VaultVmCacheService,
        RuntimeDirectoryService,
        HostApiKeyService,
        HostJsonBodyParser,
        { provide: RUNTIME_DIRECTORY_HOST, useValue: host },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: HostHelperService, useValue: { assertClaimedHost: () => undefined } },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    cache = moduleRef.get(VaultVmCacheService);
    runtimeDirectory = moduleRef.get(RuntimeDirectoryService);
    mockLogLines.length = 0;
  });

  afterEach(async () => {
    await app.close();
    await moduleRef.close();
    sqlite.close();
    chmodSync(runtimeDir, 0o700);
    rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // app.inject calls come from 127.0.0.1: the key is required even for loopback.
  const put = (body: unknown, authorization: string | null = `Bearer ${KEY}`) =>
    app.inject({
      method: 'PUT',
      url: '/api/host/vault',
      headers: {
        'content-type': HOST_VAULT_CONTENT_TYPE,
        ...(authorization ? { authorization } : {}),
      },
      payload: JSON.stringify(body),
    });
  const cacheFile = () => join(runtimeDir, VAULT_VM_CACHE_FILE);
  const dbDump = () =>
    (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    )
      .map(({ name }) => JSON.stringify(sqlite.prepare(`SELECT * FROM "${name}"`).all()))
      .join('\n');

  it('writes the snapshot and a 0600 cache file, and no value reaches the DB or the logs', async () => {
    const response = await put(FULL);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revision: FULL.revision });
    const snapshot = await storage.readVaultSnapshot();
    expect(snapshot.entries).toEqual([file, secret]);
    expect(snapshot.grants).toHaveLength(FULL.grants.length);
    expect(snapshot.grants).toEqual(expect.arrayContaining(FULL.grants));
    expect(snapshot.access).toEqual(FULL.access);
    expect(statSync(cacheFile()).mode & 0o777).toBe(0o600);
    expect(await cache.readValues([secret, file])).toEqual(
      new Map([
        ['e-secret', Buffer.from(SECRET)],
        ['e-file', Buffer.from(FILE)],
      ]),
    );
    expect(await cache.status()).toEqual({
      appliedRevision: FULL.revision,
      cacheReady: true,
      cacheUnavailable: null,
    });
    const leaks = [SECRET, 'canary-vm-file', base64(SECRET), base64(FILE)];
    for (const surface of [dbDump(), JSON.stringify(mockLogLines)]) {
      for (const canary of leaks) expect(surface).not.toContain(canary);
    }
  });

  it('refuses a push without the host API key', async () => {
    const response = await put(FULL, null);

    expect(response.statusCode).toBe(401);
    expect(existsSync(cacheFile())).toBe(false);
  });

  it.each([
    ['RUNTIME_DIRECTORY is not set', () => (systemdEnv = false), 'runtime_directory_missing'],
    ['RUNTIME_DIRECTORY is not tmpfs', () => (fsType = EXT4), 'runtime_directory_not_tmpfs'],
  ])('refuses a push when %s', async (_name, arrange, reason) => {
    arrange();

    const response = await put(FULL);

    expect(response.statusCode).toBe(409);
    expect(response.json().details).toEqual({ code: 'VAULT_CACHE_UNAVAILABLE', reason });
    expect(await readdir(runtimeDir)).toEqual([]);
    expect((await storage.readVaultSnapshot()).entries).toEqual([]);
    expect(await cache.status()).toMatchObject({ cacheReady: false, cacheUnavailable: reason });
  });

  it('refuses a push whose revision does not match its entries, without echoing values', async () => {
    const response = await put({ ...FULL, revision: 'f'.repeat(64) });

    expect(response.statusCode).toBe(400);
    expect(response.json().details).toEqual({ code: 'VAULT_PUSH_REVISION_MISMATCH' });
    expect(response.body).not.toContain(base64(SECRET));
    expect(existsSync(cacheFile())).toBe(false);
  });

  it('keeps the cache across a DevChain restart and reports not ready once the file is gone', async () => {
    await put(FULL);
    const restarted = new VaultVmCacheService(storage, runtimeDirectory);

    expect(await restarted.status()).toEqual({
      appliedRevision: FULL.revision,
      cacheReady: true,
      cacheUnavailable: null,
    });

    rmSync(cacheFile());
    expect(await restarted.status()).toEqual({
      appliedRevision: FULL.revision,
      cacheReady: false,
      cacheUnavailable: null,
    });
    expect(await restarted.readValues([secret])).toBeNull();
  });

  it.each([
    [
      'names a project this VM does not have',
      push(
        [{ ...file, id: 'e-other', projectId: 'C' }],
        [{ entryId: 'e-other', projectId: 'C', familySlug: null }],
      ),
      () => undefined,
      409,
    ],
    [
      'gives Vault access in a project this VM does not have',
      push([], [], {}, [{ projectId: 'C', familySlug: null }]),
      () => undefined,
      409,
    ],
    [
      'cannot write the cache file',
      push([{ ...secret, revision: 4 }], []),
      () => chmodSync(runtimeDir, 0o500),
      500,
    ],
  ])(
    'keeps the applied revision and a ready cache when a push %s',
    async (_name, failing, arrange, status) => {
      await put(FULL);
      arrange();

      expect((await put(failing)).statusCode).toBe(status);

      expect(await cache.status()).toEqual({
        appliedRevision: FULL.revision,
        cacheReady: true,
        cacheUnavailable: null,
      });
      expect(await cache.readValues([secret, file])).not.toBeNull();
    },
  );

  it('applies later pushes that swap names and remove entries, and drops removed values', async () => {
    await put(FULL);
    const movedSecret = { ...secret, projectId: 'A', name: 'DEPLOY_KEY', revision: 4 };
    const renamedFile = { ...file, name: 'API_TOKEN' };
    const grants = [
      { entryId: 'e-file', projectId: 'A', familySlug: null },
      { entryId: 'e-secret', projectId: 'A', familySlug: null },
    ];
    // The access of project B is gone from this push, so the VM revokes it.
    const access = [{ projectId: 'A', familySlug: null }];
    const swapped = push([renamedFile, movedSecret], grants, { 'e-secret': 'rotated' }, access);

    expect((await put(swapped)).statusCode).toBe(200);
    expect(await storage.readVaultSnapshot()).toEqual({
      entries: [renamedFile, movedSecret],
      grants,
      access,
      approvals: [],
    });
    expect(await storage.getVaultAccessDecision('B', 'coder')).toBe('not_enabled');
    expect(await storage.getVaultAccessDecision('A', 'reviewer')).toBe('granted');
    expect(await cache.readValues([movedSecret])).toEqual(
      new Map([['e-secret', Buffer.from('rotated')]]),
    );

    const smaller = push([movedSecret], [grants[1]], { 'e-secret': 'rotated' });
    expect((await put(smaller)).statusCode).toBe(200);
    expect(await cache.status()).toMatchObject({
      appliedRevision: smaller.revision,
      cacheReady: true,
    });
    expect(await cache.readValues([renamedFile])).toBeNull();
  });

  it('removes the snapshot and the cache file for a push with no entries', async () => {
    await put(FULL);
    const empty = push([], []);

    expect((await put(empty)).statusCode).toBe(200);

    expect(await storage.readVaultSnapshot()).toEqual({
      entries: [],
      grants: [],
      access: [],
      approvals: [],
    });
    expect(existsSync(cacheFile())).toBe(false);
    expect(await cache.status()).toEqual({
      appliedRevision: empty.revision,
      cacheReady: true,
      cacheUnavailable: null,
    });
  });
});
