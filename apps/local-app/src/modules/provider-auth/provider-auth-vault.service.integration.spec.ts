import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { NotFoundError, ValidationError } from '../../common/errors/error-types';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import type {
  ClaudeAdapter,
  CodexAdapter,
  CopilotAdapter,
  OpencodeAdapter,
} from '../providers/adapters';
import type { AntigravityAdapter } from '../providers/adapters/antigravity.adapter';
import type { StorageService } from '../storage/interfaces/storage.interface';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { IntegrationCredentialCipher } from '../storage/local/integration-credential-cipher';
import { PROVIDER_AUTH_ADAPTERS, PROVIDER_AUTH_VERIFY } from './provider-auth-adapters';
import { ProviderAuthVaultService } from './provider-auth-vault.service';

jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: jest.fn(actual.homedir) };
});

const MIGRATIONS_FOLDER = join(__dirname, '../../../drizzle');

// Layer: backend integration. The vault's contract is SQLite behavior —
// the FK release on remote deletion and the ciphertext column — plus the
// real cipher file, which only a migrated schema with a secret directory exercises.
describe('ProviderAuthVaultService', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let service: ProviderAuthVaultService;
  let secretDirectory: string;
  let pcHome: string;
  let remoteA: string;
  let remoteB: string;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    secretDirectory = mkdtempSync(join(os.tmpdir(), 'devchain-provider-auth-'));
    pcHome = mkdtempSync(join(os.tmpdir(), 'devchain-provider-auth-home-'));
    storage = new LocalStorageService(
      db,
      new IntegrationCredentialCipher({
        secretDirectory,
        machineIdentity: 'provider-auth-test:test-user',
      }),
    );
    service = new ProviderAuthVaultService(storage, fakeAdapterFactory());

    remoteA = (
      await storage.createRemote({
        name: 'vm-a',
        baseUrl: 'http://127.0.0.1:4001',
        kind: 'address',
      })
    ).id;
    remoteB = (
      await storage.createRemote({
        name: 'vm-b',
        baseUrl: 'http://127.0.0.1:4002',
        kind: 'address',
      })
    ).id;
  });

  afterEach(() => {
    sqlite.close();
    rmSync(secretDirectory, { recursive: true, force: true });
    rmSync(pcHome, { recursive: true, force: true });
  });

  function fakeAdapterFactory(): ProviderAdapterFactory {
    return {
      isSupported: (provider: string) => provider.toLowerCase() in PROVIDER_AUTH_ADAPTERS,
      getSupportedProviders: () => Object.keys(PROVIDER_AUTH_ADAPTERS),
    } as unknown as ProviderAdapterFactory;
  }

  const createClaudeStatic = (label = 'Claude token') =>
    service.createStatic({ provider: 'claude', label, token: 'sk-ant-test-token' });

  const createCodexFamily = async () => {
    // Families are normally produced by the isolated-login generator; here a
    // row is seeded directly through storage the same way that generator will.
    return storage.createProviderAuthEntry({
      provider: 'codex',
      kind: 'family',
      label: 'Codex login',
      payload: { payloadKind: 'files', content: '{"auth_mode":"chatgpt"}' },
    });
  };

  async function writePcOpencodeAuth(entries: Record<string, unknown>) {
    const opencodeDir = join(pcHome, '.local/share/opencode');
    mkdirSync(opencodeDir, { recursive: true });
    await writeFile(join(opencodeDir, 'auth.json'), JSON.stringify(entries), 'utf8');
    jest.mocked(os.homedir).mockReturnValue(pcHome);
  }

  it('keeps the adapter table aligned with the registered provider set', () => {
    // The real factory's map is the ground truth; the vault must cover it exactly.
    const fakeAdapters = {
      claude: {} as ClaudeAdapter,
      codex: {} as CodexAdapter,
      opencode: {} as OpencodeAdapter,
      agy: {} as AntigravityAdapter,
      copilot: {} as CopilotAdapter,
    };
    const factory = new ProviderAdapterFactory(
      {} as StorageService,
      fakeAdapters.claude,
      fakeAdapters.codex,
      fakeAdapters.opencode,
      fakeAdapters.agy,
      fakeAdapters.copilot,
    );
    expect([...factory.getSupportedProviders()].sort()).toEqual(
      Object.keys(PROVIDER_AUTH_ADAPTERS).sort(),
    );
  });

  it('encrypts payloads at rest and never returns them from list', async () => {
    const entry = await createClaudeStatic();

    const row = sqlite
      .prepare('SELECT payload_ciphertext FROM provider_auth_entries WHERE id = ?')
      .get(entry.id) as { payload_ciphertext: string };
    expect(row.payload_ciphertext).toMatch(/^v1:/);
    expect(row.payload_ciphertext).not.toContain('sk-ant-test-token');
    const rawTable = JSON.stringify(sqlite.prepare('SELECT * FROM provider_auth_entries').all());
    expect(rawTable).not.toContain('sk-ant-test-token');

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: entry.id,
      provider: 'claude',
      kind: 'static',
      label: 'Claude token',
      payloadKind: 'env',
      checkedOutRemoteId: null,
    });
    expect(JSON.stringify(listed)).not.toContain('ciphertext');
    expect(JSON.stringify(listed)).not.toContain('sk-ant-test-token');

    // Only the claim path decrypts: the payload round-trips through readProviderAuthPayload.
    await expect(storage.readProviderAuthPayload(entry.id)).resolves.toEqual({
      payloadKind: 'env',
      envKey: 'CLAUDE_CODE_OAUTH_TOKEN',
      value: 'sk-ant-test-token',
    });
  });

  it('checks a family out to one remote at a time and releases it for the next', async () => {
    const family = await createCodexFamily();

    await expect(service.checkout(family.id, remoteA)).resolves.toMatchObject({
      checkedOutRemoteId: remoteA,
    });
    await expect(service.checkout(family.id, remoteA)).resolves.toMatchObject({
      checkedOutRemoteId: remoteA,
    });
    await expect(service.checkout(family.id, remoteB)).rejects.toMatchObject({
      details: { code: 'PROVIDER_AUTH_ALREADY_CHECKED_OUT' },
    });
    await expect(
      service.checkout(family.id, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(service.release(family.id)).resolves.toMatchObject({ checkedOutRemoteId: null });
    await expect(service.release(family.id)).resolves.toMatchObject({ checkedOutRemoteId: null });
    await expect(service.checkout(family.id, remoteB)).resolves.toMatchObject({
      checkedOutRemoteId: remoteB,
    });
  });

  it('refuses to check out a static entry and lets claims use it from two remotes', async () => {
    const claude = await createClaudeStatic();

    await expect(service.checkout(claude.id, remoteA)).rejects.toMatchObject({
      details: { code: 'PROVIDER_AUTH_NOT_A_FAMILY' },
    });

    // A static entry composes into the claim for either remote's home path.
    for (const homePath of ['/home/dev', '/home/ops']) {
      await expect(service.buildClaimBundle({ entryIds: [claude.id], homePath })).resolves.toEqual({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-test-token' },
        files: [],
      });
    }
  });

  it('imports three OpenCode providers as one encrypted static group and reports refused/missing ids', async () => {
    const auth = {
      'zai-coding-plan': { type: 'api', key: 'sk-zai-test' },
      github: { type: 'wellknown', key: 'gh', token: 'gh-wellknown-test-token' },
      anthropic: { type: 'api', key: 'sk-anthropic-test' },
    };
    await writePcOpencodeAuth({
      ...auth,
      openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, accountId: 'acc' },
      unknown: { type: 'deviceflow' },
    });

    const results = await service.importOpencode([
      'zai-coding-plan',
      'openai',
      'github',
      'absent',
      'anthropic',
      'unknown',
    ]);
    const listed = await service.list();
    expect(listed).toHaveLength(1);
    const group = listed[0];

    expect(results).toEqual([
      { providerId: 'zai-coding-plan', outcome: 'imported', entryId: group.id },
      {
        providerId: 'openai',
        outcome: 'refused',
        reason: 'oauth entries refresh on use; generate a family instead',
      },
      { providerId: 'github', outcome: 'imported', entryId: group.id },
      { providerId: 'absent', outcome: 'missing' },
      { providerId: 'anthropic', outcome: 'imported', entryId: group.id },
      { providerId: 'unknown', outcome: 'refused', reason: 'unknown auth entry type' },
    ]);
    expect(group).toMatchObject({
      provider: 'opencode',
      kind: 'static',
      label: 'zai-coding-plan, github, anthropic',
      payloadKind: 'opencode-entries',
    });
    await expect(storage.readProviderAuthPayload(group.id)).resolves.toEqual({
      payloadKind: 'opencode-entries',
      entries: auth,
    });
    const stored = JSON.stringify(sqlite.prepare('SELECT * FROM provider_auth_entries').all());
    for (const secret of ['sk-zai-test', 'sk-anthropic-test', 'gh-wellknown-test-token']) {
      expect(stored).not.toContain(secret);
      expect(JSON.stringify(listed)).not.toContain(secret);
    }

    const bundle = await service.buildClaimBundle({ entryIds: [group.id], homePath: '/home/dev' });
    expect(bundle.env).toEqual({});
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]).toMatchObject({
      path: '/home/dev/.local/share/opencode/auth.json',
      mode: '0600',
    });
    expect(
      JSON.parse(Buffer.from(bundle.files[0].contentBase64, 'base64').toString('utf8')),
    ).toEqual(auth);
    const ids = await service.opencodeProviderIds([group.id]);
    expect(ids).toEqual(Object.keys(auth));
    expect(
      PROVIDER_AUTH_VERIFY.opencode.check('ZAI Coding Plan api\nGitHub wellknown\nAnthropic api', {
        opencodeProviderIds: ids,
      }),
    ).toEqual({ ok: true });
    expect(
      PROVIDER_AUTH_VERIFY.opencode.check('ZAI Coding Plan api\nGitHub wellknown', {
        opencodeProviderIds: ids,
      }),
    ).toEqual({ ok: false, hint: 'OpenCode does not list anthropic.' });
    const logins = await service.listOpencodeLogins();
    expect(logins.filter((login) => login.imported).map((login) => login.providerId)).toEqual(
      Object.keys(auth),
    );

    await expect(service.importOpencode(['zai-coding-plan'])).resolves.toHaveLength(1);
    expect(await service.list()).toHaveLength(2);
  });

  it('creates no group when every selected provider is missing or refused', async () => {
    await writePcOpencodeAuth({
      openai: { type: 'oauth', access: 'a', refresh: 'r' },
      unknown: { type: 'deviceflow' },
      malformed: 'not-an-object',
    });
    await expect(
      service.importOpencode(['absent', 'openai', 'unknown', 'malformed']),
    ).resolves.toEqual([
      { providerId: 'absent', outcome: 'missing' },
      {
        providerId: 'openai',
        outcome: 'refused',
        reason: 'oauth entries refresh on use; generate a family instead',
      },
      { providerId: 'unknown', outcome: 'refused', reason: 'unknown auth entry type' },
      { providerId: 'malformed', outcome: 'missing' },
    ]);
    expect(await service.list()).toEqual([]);
  });

  it('bounds group labels and stores repeated selected ids only once', async () => {
    const ids = ['a'.repeat(70), 'b'.repeat(70), 'c'.repeat(70)];
    const auth = Object.fromEntries(ids.map((id) => [id, { type: 'api', key: 'secret' }]));
    await writePcOpencodeAuth(auth);
    const results = await service.importOpencode([...ids, ids[0]]);
    const [group] = await service.list();
    expect(group.label).toBe(ids.join(', ').slice(0, 128));
    expect(group.label).toHaveLength(128);
    expect(results).toEqual(
      [...ids, ids[0]].map((providerId) => ({
        providerId,
        outcome: 'imported',
        entryId: group.id,
      })),
    );
    await expect(service.opencodeProviderIds([group.id])).resolves.toEqual(ids);
    expect(await service.list()).toHaveLength(1);
  });

  it('answers not-found when the PC has no OpenCode auth file', async () => {
    jest.mocked(os.homedir).mockReturnValue(pcHome);

    await expect(service.importOpencode(['zai-coding-plan'])).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists the PC's OpenCode logins as ids, fixed types and flags without any value", async () => {
    const opencodeDir = join(pcHome, '.local/share/opencode');
    mkdirSync(opencodeDir, { recursive: true });
    await writeFile(
      join(opencodeDir, 'auth.json'),
      JSON.stringify({
        'zai-coding-plan': { type: 'api', key: 'sk-zai-list-secret' },
        openai: {
          type: 'oauth',
          access: 'oc-access-secret',
          refresh: 'oc-refresh-secret',
          expires: 1,
          accountId: 'oc-account',
        },
        github: { type: 'wellknown', key: 'gh-key-secret', token: 'gh-token-secret' },
        'device-flow': { type: 'deviceflow' },
        raw: 'not-an-object',
        'has space': { type: 'api', key: 'space-key-secret' },
      }),
      'utf8',
    );
    jest.mocked(os.homedir).mockReturnValue(pcHome);

    await storage.createProviderAuthEntry({
      provider: 'opencode',
      kind: 'static',
      label: 'zai-coding-plan',
      payload: {
        payloadKind: 'opencode-entry',
        providerId: 'zai-coding-plan',
        entry: { type: 'api', key: 'sk-zai-list-secret' },
      },
    });
    await storage.createProviderAuthEntry({
      provider: 'opencode',
      kind: 'family',
      label: 'openai',
      payload: {
        payloadKind: 'opencode-entry',
        providerId: 'openai',
        entry: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, accountId: 'acc' },
      },
    });

    const logins = await service.listOpencodeLogins();

    // Only ids and fixed types: exact rows, no extra entry field, and a family
    // (oauth) entry does not count as imported.
    expect(logins).toEqual([
      { providerId: 'zai-coding-plan', type: 'api', importable: true, imported: true },
      { providerId: 'openai', type: 'oauth', importable: false, imported: false },
      { providerId: 'github', type: 'wellknown', importable: true, imported: false },
      { providerId: 'device-flow', type: 'other', importable: false, imported: false },
      { providerId: 'raw', type: 'other', importable: false, imported: false },
      { providerId: 'has space', type: 'api', importable: false, imported: false },
    ]);

    const serialized = JSON.stringify(logins);
    for (const secret of [
      'sk-zai-list-secret',
      'oc-access-secret',
      'oc-refresh-secret',
      'oc-account',
      'gh-key-secret',
      'gh-token-secret',
      'space-key-secret',
      'deviceflow',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  // Real file keys and the vault listing must agree without normalizing credential identities.
  it.each(['api', 'wellknown'])(
    'marks padded %s file keys non-importable alongside the canonical key',
    async (type) => {
      const paddedIds = [' openai', 'openai ', ' openai ', '\topenai', 'openai\t', 'openai\n'];
      const opencodeDir = join(pcHome, '.local/share/opencode');
      mkdirSync(opencodeDir, { recursive: true });
      await writeFile(
        join(opencodeDir, 'auth.json'),
        JSON.stringify(
          Object.fromEntries([
            ['openai', { type, key: 'canonical-secret' }],
            ...paddedIds.map((id) => [id, { type, key: 'padded-secret' }]),
          ]),
        ),
        'utf8',
      );
      jest.mocked(os.homedir).mockReturnValue(pcHome);

      await expect(service.listOpencodeLogins()).resolves.toEqual([
        { providerId: 'openai', type, importable: true, imported: false },
        ...paddedIds.map((providerId) => ({
          providerId,
          type,
          importable: false,
          imported: false,
        })),
      ]);
    },
  );

  it('lists no logins when the PC has no OpenCode auth file', async () => {
    jest.mocked(os.homedir).mockReturnValue(pcHome);

    await expect(service.listOpencodeLogins()).resolves.toEqual([]);
  });

  it('lists no logins when the auth file is not a plain JSON object, while import keeps its 404', async () => {
    const opencodeDir = join(pcHome, '.local/share/opencode');
    mkdirSync(opencodeDir, { recursive: true });
    const authPath = join(opencodeDir, 'auth.json');
    jest.mocked(os.homedir).mockReturnValue(pcHome);

    for (const content of ['not json', '["array"]', 'null', '"scalar"']) {
      await writeFile(authPath, content, 'utf8');
      await expect(service.listOpencodeLogins()).resolves.toEqual([]);
      await expect(service.importOpencode(['zai-coding-plan'])).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
  });

  it('releases checked-out families when their remote is deleted', async () => {
    const codex = await createCodexFamily();
    const agy = await storage.createProviderAuthEntry({
      provider: 'agy',
      kind: 'family',
      label: 'Agy login',
      payload: { payloadKind: 'files', content: '{"token":{"access_token":"a"}}' },
    });
    await service.checkout(codex.id, remoteA);
    await service.checkout(agy.id, remoteA);
    await service.checkout(
      (
        await storage.createProviderAuthEntry({
          provider: 'codex',
          kind: 'family',
          label: 'Codex login B',
          payload: { payloadKind: 'files', content: '{}' },
        })
      ).id,
      remoteB,
    );

    await storage.deleteRemote(remoteA);

    expect(await storage.getProviderAuthEntry(codex.id)).toMatchObject({
      checkedOutRemoteId: null,
    });
    expect(await storage.getProviderAuthEntry(agy.id)).toMatchObject({ checkedOutRemoteId: null });
    // The other remote's family stays checked out.
    const remaining = (await service.list()).filter((entry) => entry.checkedOutRemoteId !== null);
    expect(remaining).toEqual([expect.objectContaining({ label: 'Codex login B' })]);

    // The released family can move to the other remote.
    await expect(service.checkout(agy.id, remoteB)).resolves.toMatchObject({
      checkedOutRemoteId: remoteB,
    });
  });

  it('deletes an entry and reports a missing one', async () => {
    const entry = await createClaudeStatic();
    await service.delete(entry.id);
    await expect(service.list()).resolves.toEqual([]);
    await expect(service.delete(entry.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('renames an entry and keeps a held login exactly as stored apart from the label', async () => {
    const family = await createCodexFamily();
    await service.checkout(family.id, remoteA);
    const before = sqlite
      .prepare('SELECT * FROM provider_auth_entries WHERE id = ?')
      .get(family.id) as Record<string, string | null>;

    const renamed = await service.rename(family.id, 'Work login');

    expect(renamed).toMatchObject({
      id: family.id,
      label: 'Work login',
      checkedOutRemoteId: remoteA,
    });
    const after = sqlite
      .prepare('SELECT * FROM provider_auth_entries WHERE id = ?')
      .get(family.id) as Record<string, string | null>;
    expect(after['label']).toBe('Work login');
    expect(after['payload_ciphertext']).toBe(before['payload_ciphertext']);
    expect(after['payload_kind']).toBe(before['payload_kind']);
    expect(after['checked_out_remote_id']).toBe(remoteA);
    expect(after['last_verified_at']).toBe(before['last_verified_at']);
    expect(after['last_writeback_at']).toBe(before['last_writeback_at']);
    expect(Date.parse(after['updated_at'] as string)).toBeGreaterThanOrEqual(
      Date.parse(before['updated_at'] as string),
    );
    await expect(storage.readProviderAuthPayload(family.id)).resolves.toEqual({
      payloadKind: 'files',
      content: '{"auth_mode":"chatgpt"}',
    });
    await expect(
      service.rename('00000000-0000-4000-8000-000000000000', 'Nope'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  describe('buildClaimBundle', () => {
    it('composes env entries, provider files, and one OpenCode auth.json', async () => {
      await createClaudeStatic();
      await service.createStatic({
        provider: 'copilot',
        label: 'Copilot token',
        token: 'gho_test-token',
      });
      const codex = await createCodexFamily();
      await storage.createProviderAuthEntry({
        provider: 'agy',
        kind: 'family',
        label: 'Agy login',
        payload: { payloadKind: 'files', content: '{"token":{"access_token":"agy"}}' },
      });
      await storage.createProviderAuthEntry({
        provider: 'opencode',
        kind: 'static',
        label: 'zai-coding-plan',
        payload: {
          payloadKind: 'opencode-entry',
          providerId: 'zai-coding-plan',
          entry: { type: 'api', key: 'sk-zai-test' },
        },
      });
      await storage.createProviderAuthEntry({
        provider: 'opencode',
        kind: 'family',
        label: 'openai',
        payload: {
          payloadKind: 'opencode-entry',
          providerId: 'openai',
          entry: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, accountId: 'acc' },
        },
      });
      await storage.createProviderAuthEntry({
        provider: 'opencode',
        kind: 'static',
        label: 'anthropic, github',
        payload: {
          payloadKind: 'opencode-entries',
          entries: {
            anthropic: { type: 'api', key: 'anthropic-secret' },
            github: { type: 'wellknown', key: 'gh', token: 'github-secret' },
          },
        },
      });

      const bundle = await service.buildClaimBundle({
        entryIds: (await service.list()).map((entry) => entry.id),
        homePath: '/home/dev',
      });

      expect(bundle.env).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-test-token',
        COPILOT_GITHUB_TOKEN: 'gho_test-token',
      });
      expect(bundle.files).toHaveLength(3);
      const byPath = new Map(bundle.files.map((file) => [file.path, file]));

      const codexFile = byPath.get('/home/dev/.codex/auth.json')!;
      expect(codexFile).toMatchObject({ mode: '0600' });
      expect(Buffer.from(codexFile.contentBase64, 'base64').toString('utf8')).toBe(
        '{"auth_mode":"chatgpt"}',
      );

      const agyFile = byPath.get('/home/dev/.gemini/antigravity-cli/antigravity-oauth-token')!;
      expect(agyFile).toMatchObject({ mode: '0600' });
      expect(Buffer.from(agyFile.contentBase64, 'base64').toString('utf8')).toContain(
        '"access_token":"agy"',
      );

      // One composed auth.json carries every selected OpenCode provider id.
      const opencodeFile = byPath.get('/home/dev/.local/share/opencode/auth.json')!;
      expect(opencodeFile).toMatchObject({ mode: '0600' });
      const composed = JSON.parse(
        Buffer.from(opencodeFile.contentBase64, 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      expect(Object.keys(composed).sort()).toEqual([
        'anthropic',
        'github',
        'openai',
        'zai-coding-plan',
      ]);
      expect(composed['zai-coding-plan']).toEqual({ type: 'api', key: 'sk-zai-test' });
      expect(composed.anthropic).toEqual({ type: 'api', key: 'anthropic-secret' });
      expect(composed.github).toEqual({ type: 'wellknown', key: 'gh', token: 'github-secret' });
      const ids = await service.opencodeProviderIds(
        (await service.list()).map((entry) => entry.id),
      );
      expect(ids.sort()).toEqual(['anthropic', 'github', 'openai', 'zai-coding-plan']);
      expect(
        PROVIDER_AUTH_VERIFY.opencode.check(
          'ZAI Coding Plan api\nOpenAI oauth\nAnthropic api\nGitHub wellknown',
          {
            opencodeProviderIds: ids,
          },
        ),
      ).toEqual({ ok: true });
      expect(codex.id).toBeDefined();
    });

    it.each(['legacy', 'group'] as const)(
      'refuses overlapping provider ids between a group and a %s entry in either order',
      async (variant) => {
        await writePcOpencodeAuth({
          anthropic: { type: 'api', key: 'secret' },
          github: { type: 'wellknown', key: 'gh', token: 'tok' },
        });
        await service.importOpencode(['anthropic', 'github']);
        const [group] = await service.list();
        const other = await storage.createProviderAuthEntry({
          provider: 'opencode',
          kind: 'static',
          label: 'anthropic',
          payload:
            variant === 'legacy'
              ? {
                  payloadKind: 'opencode-entry',
                  providerId: 'anthropic',
                  entry: { type: 'api', key: 'other' },
                }
              : {
                  payloadKind: 'opencode-entries',
                  entries: { anthropic: { type: 'api', key: 'other' } },
                },
        });
        for (const entryIds of [
          [group.id, other.id],
          [other.id, group.id],
        ]) {
          await expect(
            service.buildClaimBundle({ entryIds, homePath: '/home/dev' }),
          ).rejects.toMatchObject({
            details: { reason: 'opencode_provider_id_duplicate' },
          });
        }
      },
    );

    it('refuses duplicate env keys, file paths, and OpenCode provider ids', async () => {
      await createClaudeStatic();
      const generic = await service.createStatic({
        provider: 'claude',
        label: 'Anthropic auth token',
        envKey: 'ANTHROPIC_AUTH_TOKEN',
        value: 'sk-ant-other',
      });
      await expect(
        service.buildClaimBundle({
          entryIds: (await service.list()).map((entry) => entry.id),
          homePath: '/home/dev',
        }),
      ).resolves.toEqual({
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-test-token',
          ANTHROPIC_AUTH_TOKEN: 'sk-ant-other',
        },
        files: [],
      });
      await service.delete(generic.id);

      const secondClaude = await createClaudeStatic('Claude token 2');
      await expect(
        service.buildClaimBundle({ entryIds: [secondClaude.id], homePath: '/home/dev' }),
      ).resolves.toEqual({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-test-token' },
        files: [],
      });
      await expect(
        service.buildClaimBundle({
          entryIds: [...(await service.list()).map((entry) => entry.id), secondClaude.id],
          homePath: '/home/dev',
        }),
      ).rejects.toMatchObject({
        details: { reason: 'provider_auth_env_duplicate' },
      });

      for (const homePath of ['relative/path', '/home/../etc']) {
        await expect(
          service.buildClaimBundle({ entryIds: [secondClaude.id], homePath }),
        ).rejects.toBeInstanceOf(ValidationError);
      }
    });
  });

  it('rejects unknown providers and non-token providers at creation', async () => {
    await expect(
      service.createStatic({ provider: 'gemini', label: 'Nope', token: 'x' }),
    ).rejects.toMatchObject({
      details: { reason: 'provider_not_supported' },
    });
    await expect(
      service.createStatic({
        provider: 'codex',
        label: 'Not a token',
        envKey: 'SOME_KEY',
        value: 'v',
      }),
    ).resolves.toMatchObject({ provider: 'codex', kind: 'static', payloadKind: 'env' });
    await expect(
      service.createStatic({ provider: 'codex', label: 'Not pasteable', token: 'x' }),
    ).rejects.toMatchObject({ details: { reason: 'provider_not_env_static' } });
  });
});
