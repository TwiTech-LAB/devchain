import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEnvConfig } from '../../common/config/env.config';
import { StorageError, VaultUnavailableError } from '../../common/errors/error-types';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { IntegrationCredentialCipher } from '../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { VaultStoreKey } from '../storage/local/vault-store-key';
import { VaultKeyService } from './vault-key.service';
import type { VaultKeystore } from './vault-keystore';
import { VaultStoreMigrationService } from './vault-store-migration.service';

jest.mock('../../common/logging/logger', () => {
  const child = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => child, logger: child };
});

class FakeKeystore implements VaultKeystore {
  readonly items = new Map<string, Buffer>();
  available = true;
  isAvailable(): boolean {
    return this.available;
  }
  async read(account: string): Promise<Buffer | null> {
    return this.items.get(account) ?? null;
  }
  async write(account: string, secret: Buffer): Promise<void> {
    this.items.set(account, Buffer.from(secret));
  }
  async remove(account: string): Promise<void> {
    this.items.delete(account);
  }
}

const CLICKUP = { provider: 'clickup' as const, token: 'canary-clickup-token' };
const PAYLOAD = { payloadKind: 'env' as const, envKey: 'OPENAI_API_KEY', value: 'canary-login' };
const PROXMOX_TOKEN = 'canary-proxmox-token';
const VM_API_KEY = 'canary-vm-api-key';

const SECRET_COLUMNS = [
  'SELECT credential_ciphertext AS envelope FROM integration_connections',
  'SELECT payload_ciphertext AS envelope FROM provider_auth_entries',
  'SELECT token_secret_ciphertext AS envelope FROM vm_provider_connections',
];
const VAULT_ENVELOPE = /^v1:\d+:/;

interface Instance {
  storage: LocalStorageService;
  vault: VaultKeyService;
  migration: VaultStoreMigrationService;
}

interface Seeded {
  projectId: string;
  connectionId: string;
  entryId: string;
  vmProviderId: string;
  remoteId: string;
}

// Backend integration: real storage delegates on migrated SQLite, the real
// Vault key service and the real legacy key file; only the OS store is faked.
describe('VaultStoreMigrationService', () => {
  let root: string;
  let legacyKeyDirectory: string;
  let fileKeyDirectory: string;
  let databases: Map<BetterSQLite3Database, Database.Database>;
  let instances: Instance[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-stores-'));
    legacyKeyDirectory = join(root, '.devchain', 'integrations');
    fileKeyDirectory = join(root, '.devchain', 'vault');
    databases = new Map();
    instances = [];
  });

  afterEach(() => {
    for (const instance of instances) {
      instance.migration.onModuleDestroy();
      instance.vault.onModuleDestroy();
    }
    for (const sqlite of databases.values()) sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  function newDatabase(): BetterSQLite3Database {
    const { sqlite, db } = createTestDatabase();
    databases.set(db, sqlite);
    return db;
  }

  function copyDatabase(db: BetterSQLite3Database): BetterSQLite3Database {
    const sqlite = new Database(databases.get(db)!.serialize());
    const copy = drizzle(sqlite);
    databases.set(copy, sqlite);
    return copy;
  }

  function sqliteOf(db: BetterSQLite3Database): Database.Database {
    return databases.get(db)!;
  }

  function legacyCipher(): IntegrationCredentialCipher {
    return new IntegrationCredentialCipher({
      secretDirectory: legacyKeyDirectory,
      machineIdentity: 'test-host:test-user',
    });
  }

  /** Storage as a build before the Vault wrote it: no Vault bound. */
  function legacyStorage(db: BetterSQLite3Database): LocalStorageService {
    return new LocalStorageService(db, legacyCipher());
  }

  /** One DevChain start; resolves after the start-up migration settles. */
  async function start(
    db: BetterSQLite3Database,
    keystore: VaultKeystore,
    storageOverride?: (
      storage: LocalStorageService,
    ) => ConstructorParameters<typeof VaultStoreMigrationService>[1],
  ): Promise<Instance> {
    const storeKey = new VaultStoreKey();
    const storage = new LocalStorageService(db, legacyCipher(), undefined, undefined, storeKey);
    const vault = new VaultKeyService(storage, keystore, {
      unlockTimeoutMs: 1000,
      retryIntervalMs: 60_000,
      fileKeyDirectory,
    });
    const migration = new VaultStoreMigrationService(
      vault,
      storageOverride ? storageOverride(storage) : storage,
      storeKey,
    );
    const instance = { storage, vault, migration };
    instances.push(instance);
    await vault.onModuleInit();
    migration.onModuleInit();
    await migration.run();
    return instance;
  }

  function stop(instance: Instance): void {
    instance.migration.onModuleDestroy();
    instance.vault.onModuleDestroy();
    instances = instances.filter((candidate) => candidate !== instance);
  }

  async function seed(storage: LocalStorageService): Promise<Seeded> {
    const project = await storage.createProject({
      name: 'Vault stores',
      description: null,
      rootPath: '/tmp/vault-stores',
      isTemplate: false,
    });
    const connection = await storage.replaceIntegrationConnection(
      { projectId: project.id, provider: 'clickup', credentials: CLICKUP },
      async () => undefined,
    );
    const entry = await storage.createProviderAuthEntry({
      provider: 'codex',
      kind: 'static',
      label: 'codex key',
      payload: PAYLOAD,
    });
    const vmProvider = await storage.createVmProviderConnection({
      kind: 'proxmox',
      name: 'lab',
      apiUrl: 'https://pve.invalid:8006',
      node: 'node',
      pool: 'devchain',
      storage: 'local',
      imageStorage: 'local',
      bridge: 'vmbr0',
      vmidMin: 100,
      vmidMax: 200,
      namePrefix: 'dc-',
      tag: 'devchain',
      sslFingerprint: 'a'.repeat(64),
      tokenId: 'root@pam!devchain',
      tokenSecret: PROXMOX_TOKEN,
    });
    const remote = await storage.createRemote({
      name: 'vm-a',
      baseUrl: 'https://127.0.0.1:4001',
      kind: 'address',
    });
    await storage.saveRemoteApiKey(remote.id, VM_API_KEY);
    return {
      projectId: project.id,
      connectionId: connection.id,
      entryId: entry.id,
      vmProviderId: vmProvider.id,
      remoteId: remote.id,
    };
  }

  function envelopes(db: BetterSQLite3Database): string[] {
    return SECRET_COLUMNS.flatMap((query) =>
      (sqliteOf(db).prepare(query).all() as Array<{ envelope: string }>).map((row) => row.envelope),
    );
  }

  async function expectReadable(storage: LocalStorageService, seeded: Seeded): Promise<void> {
    await expect(
      storage.getIntegrationConnectionCredentialsById(seeded.connectionId),
    ).resolves.toEqual(CLICKUP);
    await expect(storage.readProviderAuthPayload(seeded.entryId)).resolves.toEqual(PAYLOAD);
    await expect(storage.readVmProviderTokenSecret(seeded.vmProviderId)).resolves.toBe(
      PROXMOX_TOKEN,
    );
  }

  it('moves every row at the first start after an upgrade with a keystore; a second run changes nothing', async () => {
    const db = newDatabase();
    const seeded = await seed(legacyStorage(db));
    const apiKeyBefore = sqliteOf(db)
      .prepare('SELECT credential_ciphertext FROM remotes WHERE id = ?')
      .get(seeded.remoteId);
    expect(envelopes(db).every((envelope) => !VAULT_ENVELOPE.test(envelope))).toBe(true);

    const home = await start(db, new FakeKeystore());

    expect(home.vault.getStatus()).toMatchObject({ state: 'unlocked', protection: 'keystore' });
    const moved = envelopes(db);
    expect(moved).toHaveLength(3);
    expect(moved.every((envelope) => VAULT_ENVELOPE.test(envelope))).toBe(true);
    await expectReadable(home.storage, seeded);
    expect(home.migration.getStatus()).toEqual({
      state: 'done',
      stores: [
        { store: 'integration_connections', total: 1, vault: 1, failed: 0 },
        { store: 'provider_auth_entries', total: 1, vault: 1, failed: 0 },
        { store: 'vm_provider_connections', total: 1, vault: 1, failed: 0 },
      ],
    });
    expect(JSON.stringify(home.migration.getStatus())).not.toContain('canary');
    // The VM API key keeps the legacy key: remote access must not wait for an unlock.
    expect(
      sqliteOf(db)
        .prepare('SELECT credential_ciphertext FROM remotes WHERE id = ?')
        .get(seeded.remoteId),
    ).toEqual(apiKeyBefore);

    await expect(home.storage.migrateIntegrationCredentialsToVault()).resolves.toMatchObject({
      migrated: 0,
    });
    await expect(home.storage.migrateProviderAuthPayloadsToVault()).resolves.toMatchObject({
      migrated: 0,
    });
    await expect(home.storage.migrateVmProviderTokensToVault()).resolves.toMatchObject({
      migrated: 0,
    });
    expect(envelopes(db)).toEqual(moved);
  });

  it('keeps a copy of the DB and ~/.devchain without the keystore item from decrypting, keeps the rows while locked, and resumes after unlock', async () => {
    const db = newDatabase();
    const seeded = await seed(legacyStorage(db));
    const first = await start(db, new FakeKeystore());
    const recoveryCode = first.vault.getPendingRecoveryCode()!;
    stop(first);

    const copy = copyDatabase(db);
    const before = envelopes(copy);
    const thief = await start(copy, new FakeKeystore());

    expect(thief.vault.getStatus()).toMatchObject({ state: 'locked', reason: 'keystore_missing' });
    expect(thief.migration.getStatus().state).toBe('waiting');
    for (const read of [
      () => thief.storage.getIntegrationConnectionCredentialsById(seeded.connectionId),
      () => thief.storage.readProviderAuthPayload(seeded.entryId),
      () => thief.storage.readVmProviderTokenSecret(seeded.vmProviderId),
    ]) {
      await expect(read()).rejects.toMatchObject({
        code: 'vault_unavailable',
        message: expect.stringContaining('Vault locked'),
      });
    }
    for (const envelope of before) {
      expect(() => legacyCipher().decryptValue(envelope)).toThrow(StorageError);
    }

    // Writes refuse too; nothing is deleted or replaced.
    const verify = jest.fn().mockResolvedValue(undefined);
    await expect(
      thief.storage.replaceIntegrationConnection(
        { projectId: seeded.projectId, provider: 'clickup', credentials: CLICKUP },
        verify,
      ),
    ).rejects.toBeInstanceOf(VaultUnavailableError);
    expect(verify).not.toHaveBeenCalled();
    await expect(
      thief.storage.updateProviderAuthPayload(seeded.entryId, PAYLOAD),
    ).rejects.toBeInstanceOf(VaultUnavailableError);
    await expect(
      thief.storage.createProviderAuthEntry({
        provider: 'codex',
        kind: 'static',
        label: 'another',
        payload: PAYLOAD,
      }),
    ).rejects.toBeInstanceOf(VaultUnavailableError);
    expect(envelopes(copy)).toEqual(before);

    // The VM API key still opens: the /r proxy and the health poll keep working.
    await expect(thief.storage.readRemoteApiKey(seeded.remoteId)).resolves.toBe(VM_API_KEY);

    await thief.vault.unlockWithRecoveryCode(recoveryCode);
    await expectReadable(thief.storage, seeded);
  });

  it('resumes an interrupted migration at the next start and reads mixed rows in between', async () => {
    const db = newDatabase();
    const seeded = await seed(legacyStorage(db));
    const keystore = new FakeKeystore();

    const interrupted = await start(db, keystore, (storage) => ({
      migrateIntegrationCredentialsToVault: () => storage.migrateIntegrationCredentialsToVault(),
      migrateProviderAuthPayloadsToVault: () => storage.migrateProviderAuthPayloadsToVault(),
      migrateVmProviderTokensToVault: () => Promise.reject(new Error('process stopped')),
    }));

    expect(interrupted.migration.getStatus().state).toBe('incomplete');
    expect(envelopes(db).map((envelope) => VAULT_ENVELOPE.test(envelope))).toEqual([
      true,
      true,
      false,
    ]);
    await expectReadable(interrupted.storage, seeded);
    stop(interrupted);

    const next = await start(db, keystore);
    expect(next.migration.getStatus().state).toBe('done');
    expect(envelopes(db).every((envelope) => VAULT_ENVELOPE.test(envelope))).toBe(true);
    await expectReadable(next.storage, seeded);
  });

  it('leaves a row that does not open under the legacy key as it is and reports it', async () => {
    const db = newDatabase();
    const seeded = await seed(legacyStorage(db));
    sqliteOf(db)
      .prepare('UPDATE provider_auth_entries SET payload_ciphertext = ? WHERE id = ?')
      .run('v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', seeded.entryId);

    const home = await start(db, new FakeKeystore());

    expect(home.migration.getStatus()).toMatchObject({
      state: 'incomplete',
      stores: expect.arrayContaining([
        { store: 'provider_auth_entries', total: 1, vault: 0, failed: 1 },
      ]),
    });
    expect(
      sqliteOf(db)
        .prepare('SELECT payload_ciphertext FROM provider_auth_entries WHERE id = ?')
        .get(seeded.entryId),
    ).toEqual({ payload_ciphertext: 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  });

  it.each([
    ['recovery', false],
    ['file', true],
  ] as const)('without a keystore, setup with %s moves the stores: %s', async (mode, moves) => {
    const db = newDatabase();
    const seeded = await seed(legacyStorage(db));
    const keystore = new FakeKeystore();
    keystore.available = false;
    const home = await start(db, keystore);
    expect(home.migration.getStatus().state).toBe('not_applicable');

    await home.vault.setup(mode);
    await home.migration.run();

    expect(envelopes(db).every((envelope) => VAULT_ENVELOPE.test(envelope))).toBe(moves);
    expect(home.migration.getStatus().state).toBe(moves ? 'done' : 'not_applicable');
    await expectReadable(home.storage, seeded);
    const entry = await home.storage.createProviderAuthEntry({
      provider: 'codex',
      kind: 'static',
      label: 'written after setup',
      payload: PAYLOAD,
    });
    const written = sqliteOf(db)
      .prepare('SELECT payload_ciphertext AS envelope FROM provider_auth_entries WHERE id = ?')
      .get(entry.id) as { envelope: string };
    expect(VAULT_ENVELOPE.test(written.envelope)).toBe(moves);
  });

  describe('on a claimed VM', () => {
    let savedEtcDir: string | undefined;

    beforeEach(() => {
      const etcDir = join(root, 'host-etc');
      mkdirSync(etcDir);
      writeFileSync(join(etcDir, 'claim.json'), '{}');
      savedEtcDir = process.env.DEVCHAIN_HOST_ETC_DIR;
      process.env.DEVCHAIN_HOST_ETC_DIR = etcDir;
      resetEnvConfig();
    });

    afterEach(() => {
      process.env.DEVCHAIN_HOST_ETC_DIR = savedEtcDir;
      resetEnvConfig();
    });

    it('never moves the stores and keeps them working', async () => {
      const db = newDatabase();
      const seeded = await seed(legacyStorage(db));
      const before = envelopes(db);

      const vm = await start(db, new FakeKeystore());

      expect(vm.migration.getStatus().state).toBe('not_applicable');
      expect(envelopes(db)).toEqual(before);
      await expectReadable(vm.storage, seeded);
    });
  });
});
