/**
 * The resolve route over HTTP. Test layer: controller integration. Authorization joins
 * the session row, the agent, its profile, the access rows and the grants in a migrated
 * DB; values come from the real Vault key; files land in a real runtime directory; the
 * peer guard and the global host-key hook only meet in a Fastify request.
 */
const mockLogLines: unknown[] = [];
jest.mock('../../common/logging/logger', () => {
  const record = (...args: unknown[]) => mockLogLines.push(args);
  const child = { info: record, warn: record, error: record, debug: record, trace: record };
  return { createLogger: () => child, logger: child };
});

import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
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
import { resetEnvConfig } from '../../common/config/env.config';
import { AllExceptionsFilter } from '../../common/filters/http-exception.filter';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { expectNoCanaries } from '../../common/test/vault-canary.helper';
import { HostApiKeyModule } from '../remotes/host/host-api-key.module';
import { RuntimeDirectoryService } from '../runtime-directory/runtime-directory.service';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { SessionRowStore } from '../storage/sessions/session-row.store';
import { VaultAccessService } from './vault-access.service';
import { VAULT_ENTRY_DOMAIN, VAULT_ENTRY_VALUE_FIELD } from './vault-entries.service';
import { VAULT_OPTIONS, VaultKeyService } from './vault-key.service';
import { VAULT_KEYSTORE, VaultKeystoreUnavailableError } from './vault-keystore';
import { VaultLocalPeerGuard } from './vault-local-peer.guard';
import { VaultResolveController } from './vault-resolve.controller';
import { VaultResolveService } from './vault-resolve.service';
import { VAULT_SESSION_OVERLAY, type VaultSessionValue } from './vault-session-overlay';
import { VaultRequestStore } from '../vault-requests/vault-request.store';
import { VaultUseApprovalStore } from './vault-use-approvals';
import { VaultUseGate } from './vault-use-gate';
import { VaultValueReader } from './vault-value-reader';
import { VaultVmCacheService } from './vault-vm-cache.service';

const CODER = '11111111-1111-4111-8111-111111111111';
const REVIEWER = '22222222-2222-4222-8222-222222222222';
const STOPPED = '33333333-3333-4333-8333-333333333333';
const OTHER_PROJECT = '44444444-4444-4444-8444-444444444444';
const GUEST = '55555555-5555-4555-8555-555555555555';
const UNKNOWN = '66666666-6666-4666-8666-666666666666';
/** A running session of a second agent with the coder family. */
const SIBLING = '77777777-7777-4777-8777-777777777777';
const CANARIES = ['canary-secret-91c2', 'canary-file-7d0e', 'canary-rotated-2f4a'];
const HOST_KEY = `dck_${'k'.repeat(43)}`;

describe('Vault resolve route', () => {
  let app: NestFastifyApplication;
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let vault: VaultKeyService;
  let root: string;
  let runtimeRoot: string;
  let ids: Record<'secret' | 'file' | 'reviewerOnly', string>;
  const events: unknown[] = [];
  let sessionValues: VaultSessionValue[] = [];
  const requestUse = jest.fn(async (_input: unknown) => undefined);
  const vmCache = {
    isClaimedHost: () => false,
    readValues: async (): Promise<Map<string, Buffer> | null> => null,
  };
  let approvals: VaultUseApprovalStore;
  let reader: VaultValueReader;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-resolve-'));
    runtimeRoot = join(root, 'run');
    const database = createTestDatabase();
    sqlite = database.sqlite;
    storage = new LocalStorageService(database.db);
    const insert = (sql: string) => sqlite.prepare(sql).run();
    insert(`INSERT INTO projects (id, name, root_path, created_at, updated_at)
            VALUES ('A', 'Project A', '/tmp/A', 'T', 'T'), ('B', 'Project B', '/tmp/B', 'T', 'T')`);
    insert(`INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
            VALUES ('p-coder', 'A', 'Coder', 'coder', 'T', 'T'),
                   ('p-reviewer', 'A', 'Reviewer', 'reviewer', 'T', 'T'),
                   ('p-b', 'B', 'Builder', 'coder', 'T', 'T')`);
    insert(`INSERT INTO providers (id, name, mcp_configured, created_at, updated_at)
            VALUES ('prov', 'claude', 0, 'T', 'T')`);
    insert(`INSERT INTO profile_provider_configs
              (id, profile_id, provider_id, name, position, created_at, updated_at)
            VALUES ('c-coder', 'p-coder', 'prov', 'Coder', 0, 'T', 'T'),
                   ('c-reviewer', 'p-reviewer', 'prov', 'Reviewer', 0, 'T', 'T'),
                   ('c-b', 'p-b', 'prov', 'Builder', 0, 'T', 'T')`);
    insert(`INSERT INTO agents
              (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
            VALUES ('a-coder', 'A', 'p-coder', 'c-coder', 'Coder', 'T', 'T'),
                   ('a-reviewer', 'A', 'p-reviewer', 'c-reviewer', 'Reviewer', 'T', 'T'),
                   ('a-b', 'B', 'p-b', 'c-b', 'Builder', 'T', 'T'),
                   ('a-coder-2', 'A', 'p-coder', 'c-coder', 'Coder 2', 'T', 'T')`);
    insert(`INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
            VALUES ('${CODER}', 'a-coder', 'running', 'T', 'T', 'T'),
                   ('${REVIEWER}', 'a-reviewer', 'running', 'T', 'T', 'T'),
                   ('${STOPPED}', 'a-coder', 'stopped', 'T', 'T', 'T'),
                   ('${OTHER_PROJECT}', 'a-b', 'running', 'T', 'T', 'T'),
                   ('${SIBLING}', 'a-coder-2', 'running', 'T', 'T', 'T')`);
    insert(`INSERT INTO guests
              (id, project_id, name, tmux_session_id, last_seen_at, created_at, updated_at)
            VALUES ('${GUEST}', 'A', 'Guest', 'tmux-guest', 'T', 'T', 'T')`);

    const unavailable = () => Promise.reject(new VaultKeystoreUnavailableError());
    const module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true }), HostApiKeyModule],
      controllers: [VaultResolveController],
      providers: [
        VaultKeyService,
        VaultAccessService,
        VaultValueReader,
        VaultResolveService,
        VaultUseGate,
        VaultUseApprovalStore,
        { provide: VaultRequestStore, useValue: { add: requestUse } },
        VaultLocalPeerGuard,
        SessionRowStore,
        { provide: DB_CONNECTION, useValue: database.db },
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: VaultVmCacheService, useValue: vmCache },
        { provide: VAULT_SESSION_OVERLAY, useValue: { valuesFor: () => sessionValues } },
        {
          provide: RuntimeDirectoryService,
          useValue: new RuntimeDirectoryService({
            platform: 'linux',
            dbPath: join(root, 'devchain.db'),
            env: () => ({ RUNTIME_DIRECTORY: runtimeRoot }),
            isLingering: () => false,
            fileSystemType: async () => null,
          }),
        },
        {
          provide: VAULT_KEYSTORE,
          useValue: {
            isAvailable: () => false,
            read: unavailable,
            write: unavailable,
            remove: unavailable,
          },
        },
        { provide: VAULT_OPTIONS, useValue: { fileKeyDirectory: join(root, 'vault') } },
      ],
    }).compile();
    vault = module.get(VaultKeyService);
    approvals = module.get(VaultUseApprovalStore);
    reader = module.get(VaultValueReader);
    module.get(EventEmitter2).onAny((event, payload) => events.push([event, payload]));
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await vault.setup('file');

    const entry = async (
      name: string,
      kind: 'secret' | 'file',
      value: string,
      access: { mode: 'all' } | { mode: 'families'; familySlugs: string[] },
    ) => {
      const id = `entry-${name}`;
      await storage.createVaultEntry({
        id,
        projects: [{ projectId: 'A', ...access }],
        name,
        kind,
        description: name,
        valueCiphertext: vault.encrypt(VAULT_ENTRY_DOMAIN, id, VAULT_ENTRY_VALUE_FIELD, value),
      });
      return id;
    };
    ids = {
      secret: await entry('API_TOKEN', 'secret', CANARIES[0], { mode: 'all' }),
      file: await entry('SERVICE_KEY', 'file', `-----BEGIN-----\n${CANARIES[1]}\n`, {
        mode: 'families',
        familySlugs: ['coder'],
      }),
      reviewerOnly: await entry('REVIEW_TOKEN', 'secret', 'review-value', {
        mode: 'families',
        familySlugs: ['reviewer'],
      }),
    };
    await storage.setVaultFamilyAccess('A', { mode: 'families', familySlugs: ['coder'] });
  });

  afterEach(() => {
    sessionValues = [];
  });

  afterAll(async () => {
    await app.close();
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  const resolve = (payload: unknown, remoteAddress = '127.0.0.1', headers = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/vault/sessions/resolve',
      payload: payload as Record<string, unknown>,
      remoteAddress,
      headers,
    });

  it('returns the current values of the granted entries, files at stable 0600 paths', async () => {
    const response = await resolve({ sessionId: CODER });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { env: Record<string, string>; files: Record<string, string> };
    expect(body.env).toEqual({ API_TOKEN: CANARIES[0] });
    expect(Object.keys(body.files)).toEqual(['SERVICE_KEY']);
    const path = body.files.SERVICE_KEY;
    expect(path.startsWith(`${runtimeRoot}/`)).toBe(true);
    expect(path.endsWith(join('session-files', CODER, 'vault', 'SERVICE_KEY'))).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain(CANARIES[1]);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    sqlite
      .prepare('UPDATE vault_entries SET value_ciphertext = ? WHERE id = ?')
      .run(
        vault.encrypt(VAULT_ENTRY_DOMAIN, ids.secret, VAULT_ENTRY_VALUE_FIELD, CANARIES[2]),
        ids.secret,
      );
    const subset = await resolve({ sessionId: CODER, names: ['API_TOKEN'] });
    expect(subset.json()).toEqual({
      env: { API_TOKEN: CANARIES[2] },
      files: {},
      needsApproval: [],
    });
    // A subset leaves the files of other granted names in place.
    expect(readFileSync(path, 'utf8')).toContain(CANARIES[1]);
    const used = sqlite
      .prepare('SELECT id, last_used_at FROM vault_entries ORDER BY id')
      .all() as Array<{ id: string; last_used_at: string | null }>;
    expect(used.filter((row) => row.last_used_at).map((row) => row.id)).toEqual(
      [ids.secret, ids.file].sort(),
    );
  });

  it('adds session-only values and lets them win over a stored entry of the same name', async () => {
    sessionValues = [
      {
        name: 'API_TOKEN',
        kind: 'secret',
        description: 'Session only',
        value: Buffer.from('session-only-token'),
      },
      {
        name: 'SESSION_FILE',
        kind: 'file',
        description: 'Session only',
        value: Buffer.from('session-only-file'),
      },
    ];

    const body = (await resolve({ sessionId: CODER })).json() as {
      env: Record<string, string>;
      files: Record<string, string>;
    };

    expect(body.env).toEqual({ API_TOKEN: 'session-only-token' });
    expect(Object.keys(body.files).sort()).toEqual(['SERVICE_KEY', 'SESSION_FILE']);
    expect(readFileSync(body.files.SESSION_FILE, 'utf8')).toBe('session-only-file');
  });

  it('refuses each caller it cannot authorize with its own code and no echo of the request', async () => {
    const cases: Array<[string, unknown, number, string]> = [
      ['session id prefix', { sessionId: CODER.slice(0, 8) }, 400, 'VAULT_SESSION_ID_INVALID'],
      ['guest id', { sessionId: GUEST }, 403, 'VAULT_AGENT_SESSION_REQUIRED'],
      ['stopped session', { sessionId: STOPPED }, 403, 'VAULT_SESSION_NOT_ACTIVE'],
      ['unknown session', { sessionId: UNKNOWN }, 403, 'VAULT_SESSION_NOT_ACTIVE'],
      ['family without access', { sessionId: REVIEWER }, 403, 'VAULT_ACCESS_DENIED'],
      ['project with the Vault off', { sessionId: OTHER_PROJECT }, 403, 'VAULT_NOT_ENABLED'],
      [
        'name not granted',
        { sessionId: CODER, names: ['API_TOKEN', 'REVIEW_TOKEN'] },
        403,
        'VAULT_ENTRY_NOT_GRANTED',
      ],
      [
        'malformed body',
        { sessionId: CODER, names: ['NOT-A-NAME canary-body-echo'] },
        400,
        'VAULT_RESOLVE_BODY_INVALID',
      ],
    ];
    for (const [label, payload, status, code] of cases) {
      const response = await resolve(payload);
      expect([label, response.statusCode, response.json().details?.code]).toEqual([
        label,
        status,
        code,
      ]);
      for (const echoed of ['canary-body-echo', CODER, ...CANARIES]) {
        expect(response.body).not.toContain(echoed);
      }
    }
    // Entry names are not confidential: the refusal names the missing ones for the CLI.
    const missing = await resolve({ sessionId: CODER, names: ['API_TOKEN', 'REVIEW_TOKEN'] });
    expect(missing.json().details).toEqual({
      code: 'VAULT_ENTRY_NOT_GRANTED',
      names: ['REVIEW_TOKEN'],
    });
  });

  it('prunes the session files of earlier resolves when access is revoked', async () => {
    const first = await resolve({ sessionId: CODER });
    const path = (first.json() as { files: Record<string, string> }).files.SERVICE_KEY;
    expect(readFileSync(path, 'utf8')).toContain(CANARIES[1]);

    try {
      await storage.setVaultFamilyAccess('A', { mode: 'none' });
      const refused = await resolve({ sessionId: CODER });
      expect([refused.statusCode, refused.json().details?.code]).toEqual([
        403,
        'VAULT_NOT_ENABLED',
      ]);
      // A revoked key file must not stay readable at its stable path.
      expect(existsSync(path)).toBe(false);
    } finally {
      await storage.setVaultFamilyAccess('A', { mode: 'families', familySlugs: ['coder'] });
    }
  });

  it('answers 409 VAULT_LOCKED while the Vault is locked', async () => {
    const state = jest.spyOn(vault, 'getState').mockReturnValue('locked');
    try {
      const response = await resolve({ sessionId: CODER });
      expect([response.statusCode, response.json().code]).toEqual([409, 'VAULT_LOCKED']);
    } finally {
      state.mockRestore();
    }
  });

  it('admits loopback peers only', async () => {
    expect((await resolve({ sessionId: CODER }, '::1')).statusCode).toBe(200);
    const external = await resolve({ sessionId: CODER }, '192.168.1.30');
    expect([external.statusCode, external.json().details]).toEqual([
      403,
      { code: 'VAULT_PEER_REFUSED' },
    ]);
  });

  describe('use approval gate', () => {
    // An earlier test rotates the stored value.
    const TOKEN = { API_TOKEN: expect.stringMatching(/^canary-/) };
    const gate = (required: boolean) =>
      sqlite
        .prepare('UPDATE vault_entries SET approval_required = ? WHERE id IN (?, ?)')
        .run(required ? 1 : 0, ids.secret, ids.file);
    const endSessions = () => {
      for (const sessionId of [CODER, SIBLING]) {
        approvals.onSessionStopped({ sessionId } as never);
      }
    };

    beforeEach(() => {
      gate(true);
      requestUse.mockClear();
    });

    afterEach(async () => {
      gate(false);
      endSessions();
      sqlite.prepare('DELETE FROM vault_use_family_approvals').run();
      jest.restoreAllMocks();
    });

    it('asks the user once per named gated entry and answers 409 with the names', async () => {
      const response = await resolve({ sessionId: CODER, names: ['API_TOKEN', 'SERVICE_KEY'] });

      expect([response.statusCode, response.json().details]).toEqual([
        409,
        { code: 'VAULT_USE_APPROVAL_PENDING', names: ['API_TOKEN', 'SERVICE_KEY'] },
      ]);
      expect(requestUse.mock.calls.map(([input]) => input)).toEqual([
        {
          projectId: 'A',
          sessionId: CODER,
          agentId: 'a-coder',
          agentName: 'Coder',
          familySlug: 'coder',
          entryId: ids.secret,
          name: 'API_TOKEN',
          kind: 'secret',
          type: 'use',
          description: '',
        },
        expect.objectContaining({ entryId: ids.file, name: 'SERVICE_KEY', kind: 'file' }),
      ]);
      for (const canary of CANARIES) expect(response.body).not.toContain(canary);
    });

    it('lets a session denial win over a family approval born in a sibling session, and asks nothing', async () => {
      approvals.deny(CODER, ids.secret);
      await storage.addVaultUseFamilyApproval(ids.secret, 'A', 'coder');

      const denied = await resolve({ sessionId: CODER, names: ['API_TOKEN'] });
      const sibling = await resolve({ sessionId: SIBLING, names: ['API_TOKEN'] });

      expect([denied.statusCode, denied.json().details]).toEqual([
        403,
        { code: 'VAULT_USE_DENIED', names: ['API_TOKEN'] },
      ]);
      expect([sibling.statusCode, sibling.json().env]).toEqual([200, TOKEN]);
      expect(requestUse).not.toHaveBeenCalled();
    });

    it('leaves unapproved entries out of a call without names, asks nothing, and prunes a withheld file', async () => {
      approvals.approveSession(CODER, ids.file);
      const approved = await resolve({ sessionId: CODER });
      const { files } = approved.json() as { files: Record<string, string> };
      expect(approved.json()).toMatchObject({ env: {}, needsApproval: ['API_TOKEN'] });
      expect(readFileSync(files.SERVICE_KEY, 'utf8')).toContain(CANARIES[1]);

      approvals.deny(CODER, ids.file);
      const withheld = await resolve({ sessionId: CODER });

      expect(withheld.json()).toEqual({ env: {}, files: {}, needsApproval: ['API_TOKEN'] });
      expect(existsSync(files.SERVICE_KEY)).toBe(false);
      expect(requestUse).not.toHaveBeenCalled();
    });

    it.each<[string, () => void]>([
      ['the Vault is locked', () => void jest.spyOn(vault, 'getState').mockReturnValue('locked')],
      [
        'the VM cache lacks the value',
        () => {
          jest.spyOn(vmCache, 'isClaimedHost').mockReturnValue(true);
          jest.spyOn(vmCache, 'readValues').mockResolvedValue(null);
        },
      ],
    ])('keeps a one-shot approval when %s, and spends it on one success', async (_name, fail) => {
      approvals.approveOnce(CODER, ids.secret);
      fail();
      const failed = await resolve({ sessionId: CODER, names: ['API_TOKEN'] });
      expect([failed.statusCode, failed.json().code]).toEqual([409, 'VAULT_LOCKED']);
      jest.restoreAllMocks();

      const used = await resolve({ sessionId: CODER, names: ['API_TOKEN'] });
      const again = await resolve({ sessionId: CODER, names: ['API_TOKEN'] });

      expect([used.statusCode, used.json().env]).toEqual([200, TOKEN]);
      expect([again.statusCode, again.json().details?.code]).toEqual([
        409,
        'VAULT_USE_APPROVAL_PENDING',
      ]);
    });

    it('never gives one one-shot approval to two overlapping calls', async () => {
      approvals.approveOnce(CODER, ids.secret);
      let finishRead!: () => void;
      const reading = new Promise<void>((done) => (finishRead = done));
      const read = reader.read.bind(reader);
      const spy = jest.spyOn(reader, 'read').mockImplementationOnce(async (entries) => {
        await reading;
        return read(entries);
      });

      const first = resolve({ sessionId: CODER, names: ['API_TOKEN'] });
      // The first call holds the token while its read waits.
      while (spy.mock.calls.length === 0) await new Promise((done) => setImmediate(done));
      const second = await resolve({ sessionId: CODER, names: ['API_TOKEN'] });
      finishRead();

      expect(second.json().details?.code).toBe('VAULT_USE_APPROVAL_PENDING');
      expect((await first).json().env).toEqual(TOKEN);
    });
  });

  describe('on a claimed host', () => {
    let savedEtcDir: string | undefined;

    beforeAll(() => {
      const etcDir = join(root, 'host-etc');
      const homePath = join(root, 'home');
      mkdirSync(etcDir);
      mkdirSync(join(homePath, '.devchain'), { recursive: true });
      writeFileSync(join(etcDir, 'claim.json'), JSON.stringify({ homePath }));
      writeFileSync(
        join(homePath, '.devchain', 'host-api-key'),
        `${createHash('sha256').update(HOST_KEY).digest('hex')}\n`,
      );
      savedEtcDir = process.env.DEVCHAIN_HOST_ETC_DIR;
      process.env.DEVCHAIN_HOST_ETC_DIR = etcDir;
      resetEnvConfig();
    });

    afterAll(() => {
      process.env.DEVCHAIN_HOST_ETC_DIR = savedEtcDir;
      resetEnvConfig();
    });

    it('refuses an external peer even when it holds the host API key', async () => {
      const keyless = await resolve({ sessionId: CODER }, '203.0.113.9');
      expect(keyless.statusCode).toBe(401);

      const keyed = await resolve({ sessionId: CODER }, '203.0.113.9', {
        authorization: `Bearer ${HOST_KEY}`,
      });
      expect([keyed.statusCode, keyed.json().details]).toEqual([
        403,
        { code: 'VAULT_PEER_REFUSED' },
      ]);
      expect((await resolve({ sessionId: CODER })).statusCode).toBe(200);
    });
  });

  it('never puts a value in a log line or an event', () => {
    expect(mockLogLines.length).toBeGreaterThan(0);
    expectNoCanaries({ logs: mockLogLines, events }, [
      ...CANARIES,
      'session-only-token',
      'session-only-file',
    ]);
    // The full session id authorizes this route, so logs carry a prefix at most.
    expectNoCanaries({ logs: mockLogLines }, [CODER]);
  });
});
