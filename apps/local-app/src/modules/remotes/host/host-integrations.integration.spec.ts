import { Test, type TestingModule } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type Database from 'better-sqlite3';
import { HOST_INTEGRATIONS_CONTENT_TYPE, type HostIntegrationsPush } from '@devchain/shared';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../../../common/config/env.config';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { hostIntegrationsRevision } from '../../external-integrations/vm-cache/integration-push-revision';
import {
  INTEGRATIONS_VM_CACHE_FILE,
  IntegrationVmCacheService,
} from '../../external-integrations/vm-cache/integration-vm-cache.service';
import {
  RUNTIME_DIRECTORY_HOST,
  type RuntimeDirectoryHost,
} from '../../runtime-directory/runtime-directory';
import { RuntimeDirectoryService } from '../../runtime-directory/runtime-directory.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { HostApiKeyService } from './host-api-key.service';
import { HostHelperService } from './host-helper.service';
import { HostIntegrationsController } from './host-integrations.controller';
import { HostJsonBodyParser } from './host-json-body.parser';

const mockLogLines: unknown[] = [];
jest.mock('../../../common/logging/logger', () => {
  const record = (...args: unknown[]) => mockLogLines.push(args);
  const child = { info: record, warn: record, error: record, debug: record, trace: record };
  return { createLogger: () => child, logger: child };
});

const TMPFS = 0x01021994;
const KEY = `dck_${'a'.repeat(43)}`;
const TOKEN_A = 'canary-vm-jira-a-4c1d';
const TOKEN_B = 'canary-vm-clickup-b-90ee';
const CANARIES = [TOKEN_A, TOKEN_B];

const A = { id: 'conn-a', projectId: 'A', provider: 'jira', generation: 3 } as const;
const B = { id: 'conn-b', projectId: 'B', provider: 'clickup', generation: 1 } as const;
const jiraA = {
  provider: 'jira',
  siteUrl: 'https://acme.atlassian.net',
  email: 'agent@example.com',
  token: TOKEN_A,
} as const;
const clickupB = { provider: 'clickup', token: TOKEN_B } as const;

const FULL: HostIntegrationsPush = {
  revision: hostIntegrationsRevision([A, B]),
  connections: [A, B],
  secrets: [
    { connectionId: A.id, generation: A.generation, credentials: jiraA },
    { connectionId: B.id, generation: B.generation, credentials: clickupB },
  ],
};

// Layer: VM API integration. The key check, body parser, schema, tmpfs check, cache
// file, connection rows and project release meet only here, over real SQLite and files.
describe('Host integrations push API', () => {
  let root: string;
  let runtimeDir: string;
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let cache: IntegrationVmCacheService;
  let moduleRef: TestingModule;
  let app: NestFastifyApplication;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'host-integrations-'));
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
    const host: RuntimeDirectoryHost = {
      platform: 'linux',
      dbPath: join(root, 'devchain.db'),
      env: () => ({ RUNTIME_DIRECTORY: runtimeDir }),
      isLingering: () => false,
      fileSystemType: async () => TMPFS,
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
      controllers: [HostIntegrationsController],
      providers: [
        IntegrationVmCacheService,
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
    cache = moduleRef.get(IntegrationVmCacheService);
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
      url: '/api/host/integrations',
      headers: {
        'content-type': HOST_INTEGRATIONS_CONTENT_TYPE,
        ...(authorization ? { authorization } : {}),
      },
      payload: JSON.stringify(body),
    });
  const cacheFile = () => join(runtimeDir, INTEGRATIONS_VM_CACHE_FILE);
  const cachedText = () => (existsSync(cacheFile()) ? readFileSync(cacheFile(), 'utf8') : '');
  const rows = () =>
    sqlite
      .prepare(
        'SELECT id, project_id, credential_ciphertext FROM integration_connections ORDER BY id',
      )
      .all();
  const dbDump = () =>
    (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    )
      .map(({ name }) => JSON.stringify(sqlite.prepare(`SELECT * FROM "${name}"`).all()))
      .join('\n');
  const expectNoLeak = (...surfaces: string[]) => {
    for (const surface of [dbDump(), JSON.stringify(mockLogLines), ...surfaces]) {
      for (const canary of CANARIES) expect(surface).not.toContain(canary);
    }
  };
  const read = (connection: typeof A | typeof B) => cache.readCredentials(connection);

  it('stores the rows without credentials and a 0600 cache file; no token reaches the DB or the logs', async () => {
    const response = await put(FULL);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ revision: FULL.revision, seededProjectIds: [] });
    expect(rows()).toEqual([
      { id: 'conn-a', project_id: 'A', credential_ciphertext: '' },
      { id: 'conn-b', project_id: 'B', credential_ciphertext: '' },
    ]);
    expect(statSync(cacheFile()).mode & 0o777).toBe(0o600);
    expect(await read(A)).toEqual({ state: 'ready', credentials: jiraA });
    expect(await cache.status()).toEqual({
      appliedRevision: FULL.revision,
      cacheReady: true,
      cacheUnavailable: null,
      seededProjectIds: [],
      pendingReceipts: 0,
    });
    expect(mockLogLines.length).toBeGreaterThan(0);
    expectNoLeak(response.body);
  });

  it.each([
    ['without a key', null],
    ['with a wrong key', `Bearer dck_${'b'.repeat(43)}`],
  ])('refuses a loopback push %s, without storing or echoing it', async (_name, authorization) => {
    const response = await put(FULL, authorization);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'HOST_API_KEY_REJECTED' });
    expect(rows()).toEqual([]);
    expect(existsSync(cacheFile())).toBe(false);
    expectNoLeak(response.body);
  });

  it.each([
    [
      'a secret of another generation',
      { ...FULL, secrets: [{ ...FULL.secrets![0], generation: 2 }] },
      () => undefined,
      400,
    ],
    ['a revision that does not match', { ...FULL, revision: 'f'.repeat(64) }, () => undefined, 400],
    ['an unwritable runtime directory', FULL, () => chmodSync(runtimeDir, 0o500), 500],
  ])(
    'refuses a push with %s without echoing or logging a token, and keeps the cache',
    async (_name, failing, arrange, status) => {
      await put({
        ...FULL,
        connections: [B],
        revision: hostIntegrationsRevision([B]),
        secrets: [FULL.secrets![1]],
      });
      arrange();
      mockLogLines.length = 0;

      const response = await put(failing);

      expect(response.statusCode).toBe(status);
      // The refusal is logged, and the log holds no token.
      expect(mockLogLines).not.toEqual([]);
      expectNoLeak(response.body);
      chmodSync(runtimeDir, 0o700);
      expect(await read(B)).toEqual({ state: 'ready', credentials: clickupB });
    },
  );

  describe('seeding links and taking acknowledgements', () => {
    const T = '2026-11-01T00:00:00.000Z';
    const link = (id: string, epicId: string, task: string, connectionId: string | null) => ({
      id,
      epic_id: epicId,
      project_id: 'A',
      connection_id: connectionId,
      provider: 'jira' as const,
      remote_scope_key: 'site',
      remote_task_id: task,
      source_snapshot: JSON.stringify({ remoteKey: task }),
      created_at: T,
      updated_at: T,
    });
    const SEED = [
      {
        projectId: 'A',
        links: [
          link('link-1', 'epic-1', 'J-1', 'conn-a'),
          link('link-2', 'epic-2', 'J-2', 'conn-gone'),
          link('link-3', 'epic-missing', 'J-3', null),
        ],
      },
    ];
    const links = () =>
      sqlite
        .prepare('SELECT id, epic_id, connection_id FROM external_task_links ORDER BY id')
        .all();

    beforeEach(() => {
      sqlite
        .prepare(
          `INSERT INTO statuses (id, project_id, label, color, position, created_at, updated_at)
           VALUES ('status-a', 'A', 'Open', '#000', 0, 'T', 'T')`,
        )
        .run();
      for (const id of ['epic-1', 'epic-2']) {
        sqlite
          .prepare(
            `INSERT INTO epics (id, project_id, title, status_id, version, created_at, updated_at)
             VALUES (?, 'A', ?, 'status-a', 1, 'T', 'T')`,
          )
          .run(id, id);
      }
    });

    it('seeds a project once, skipping epics it lacks and connections it does not hold', async () => {
      const first = await put({ ...FULL, seed: SEED });
      // The VM agent unlinked one; a later seed must not bring it back.
      sqlite.prepare("DELETE FROM external_task_links WHERE id = 'link-1'").run();
      const second = await put({ ...FULL, seed: SEED });

      expect(first.json()).toEqual({ revision: FULL.revision, seededProjectIds: ['A'] });
      expect(second.statusCode).toBe(200);
      expect(links()).toEqual([{ id: 'link-2', epic_id: 'epic-2', connection_id: null }]);
      expect((await cache.status()).seededProjectIds).toEqual(['A']);
    });

    it('refuses a seed link of another project', async () => {
      const response = await put({
        ...FULL,
        seed: [{ projectId: 'B', links: [link('link-1', 'epic-1', 'J-1', null)] }],
      });

      expect(response.statusCode).toBe(400);
      expect(links()).toEqual([]);
    });

    it('deletes the receipts home acknowledged and reports the rest as pending', async () => {
      await put({ ...FULL, seed: SEED });
      const receipt = (id: string, seq: number) =>
        sqlite
          .prepare(
            `INSERT INTO external_link_receipts
               (id, seq, kind, project_id, epic_id, link_id, provider, remote_scope_key, remote_task_id, created_at)
             VALUES (?, ?, 'release', 'A', 'epic-1', 'link-1', 'jira', 'site', 'J-1', 'T')`,
          )
          .run(id, seq);
      receipt('r-1', 1);
      receipt('r-2', 2);
      expect((await cache.status()).pendingReceipts).toBe(2);

      await put({ ...FULL, acks: [{ receiptId: 'r-1' }, { receiptId: 'r-unknown' }] });

      expect((await cache.status()).pendingReceipts).toBe(1);
      expect(sqlite.prepare('SELECT id FROM external_link_receipts').all()).toEqual([
        { id: 'r-2' },
      ]);
    });

    it('forgets the seed with a released project, so a new Connect is seeded again', async () => {
      await put({ ...FULL, seed: SEED });
      await storage.setProjectFrozen('A', new Date().toISOString());

      await cache.releaseProject('A');

      expect((await cache.status()).seededProjectIds).toEqual([]);
    });
  });

  describe('releasing a project on the VM', () => {
    beforeEach(async () => {
      expect((await put(FULL)).statusCode).toBe(200);
      await storage.setProjectFrozen('A', new Date().toISOString());
    });

    const expectReleased = async () => {
      expect(rows()).toEqual([{ id: 'conn-b', project_id: 'B', credential_ciphertext: '' }]);
      expect(await read(A)).toEqual({ state: 'missing' });
      expect(cachedText()).not.toContain(TOKEN_A);
      expect(await read(B)).toEqual({ state: 'ready', credentials: clickupB });
    };

    it('removes the rows and credentials before it returns, and a stale detaching push brings back neither', async () => {
      await cache.releaseProject('A');
      await expectReleased();

      // Home still sends the project while its binding is `detaching`.
      expect((await put(FULL)).statusCode).toBe(200);
      await expectReleased();
    });

    it.each([
      ['before', true],
      ['after', false],
    ])(
      'keeps the invariant when the stale push starts %s the release',
      async (_name, pushFirst) => {
        const stale = () => put(FULL);
        const release = () => cache.releaseProject('A');
        const [first, second] = pushFirst ? [stale, release] : [release, stale];

        const results = await Promise.all([first(), second()]);

        expect(results).toContainEqual(expect.objectContaining({ statusCode: 200 }));
        await expectReleased();
      },
    );

    it('leaves rows without credentials, never the reverse, when the release fails; the next push refills them', async () => {
      await storage.setProjectFrozen('A', null);

      await expect(cache.releaseProject('A')).rejects.toMatchObject({
        details: { code: 'PROJECT_NOT_FROZEN' },
      });

      expect(rows()).toHaveLength(2);
      expect(await read(A)).toEqual({ state: 'missing' });
      expect((await cache.status()).cacheReady).toBe(false);
      expect((await put(FULL)).statusCode).toBe(200);
      expect(await read(A)).toEqual({ state: 'ready', credentials: jiraA });
    });

    it('keeps the refusal for a connection row on an instance whose rows are its own', async () => {
      await expect(storage.releaseProject('A')).rejects.toMatchObject({
        details: { code: 'PROJECT_HAS_INTEGRATION_CONNECTIONS' },
      });
    });
  });
});
