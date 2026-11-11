import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filter, firstValueFrom } from 'rxjs';
import { resetEnvConfig } from '../../common/config/env.config';
import {
  ForbiddenError,
  StorageError,
  ValidationError,
  VaultUnavailableError,
} from '../../common/errors/error-types';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { open, slotAad } from './vault-crypto';
import { VaultKeyService, type VaultStatus } from './vault-key.service';
import { VaultKeystoreUnavailableError, type VaultKeystore } from './vault-keystore';

const mockLogLines: unknown[] = [];
jest.mock('../../common/logging/logger', () => {
  const record = (...args: unknown[]) => mockLogLines.push(args);
  const child = { info: record, warn: record, error: record, debug: record };
  return { createLogger: () => child, logger: child };
});

/** OS credential store at the adapter seam: one per OS user, shared by instances. */
class FakeKeystore implements VaultKeystore {
  readonly items = new Map<string, Buffer>();
  available = true;
  /** While set, every call waits for it, like a store blocked on a user prompt. */
  gate: Promise<void> | null = null;
  failures = 0;

  isAvailable(): boolean {
    return this.available;
  }
  async read(account: string): Promise<Buffer | null> {
    await this.pass();
    return this.items.get(account) ?? null;
  }
  async write(account: string, secret: Buffer): Promise<void> {
    await this.pass();
    this.items.set(account, Buffer.from(secret));
  }
  async remove(account: string): Promise<void> {
    await this.pass();
    this.items.delete(account);
  }
  private async pass(): Promise<void> {
    if (!this.available) throw new VaultKeystoreUnavailableError();
    if (this.gate) await this.gate;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('The store refused the request');
    }
  }
}

// Backend integration: the slot rows go through the real storage delegate on
// migrated SQLite; only the OS credential store is faked, at its adapter seam.
describe('VaultKeyService', () => {
  let root: string;
  let fileKeyDirectory: string;
  let databases: Map<BetterSQLite3Database, Database.Database>;
  let services: VaultKeyService[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-'));
    fileKeyDirectory = join(root, '.devchain', 'vault');
    databases = new Map();
    services = [];
    mockLogLines.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
    for (const service of services) service.onModuleDestroy();
    for (const sqlite of databases.values()) sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  function newDatabase(): BetterSQLite3Database {
    const { sqlite, db } = createTestDatabase();
    databases.set(db, sqlite);
    return db;
  }

  /** A byte copy of the DB file, as a leaked `~/.devchain` would carry it. */
  function copyDatabase(db: BetterSQLite3Database): BetterSQLite3Database {
    const sqlite = new Database(databases.get(db)!.serialize());
    const copy = drizzle(sqlite);
    databases.set(copy, sqlite);
    return copy;
  }

  function createVault(db: BetterSQLite3Database, keystore: VaultKeystore): VaultKeyService {
    const service = new VaultKeyService(new LocalStorageService(db), keystore, {
      unlockTimeoutMs: 1000,
      retryIntervalMs: 5000,
      fileKeyDirectory,
    });
    services.push(service);
    return service;
  }

  async function startVault(
    db: BetterSQLite3Database,
    keystore: VaultKeystore,
  ): Promise<VaultKeyService> {
    const service = createVault(db, keystore);
    await service.onModuleInit();
    return service;
  }

  function stop(service: VaultKeyService): void {
    service.onModuleDestroy();
    services = services.filter((candidate) => candidate !== service);
  }

  function reached(service: VaultKeyService, state: VaultStatus['state']): Promise<VaultStatus> {
    return firstValueFrom(service.statusChanges().pipe(filter((status) => status.state === state)));
  }

  it('sets up a keystore and a recovery slot at the first start and unlocks at the next', async () => {
    const db = newDatabase();
    const keystore = new FakeKeystore();

    const first = await startVault(db, keystore);
    expect(first.getStatus()).toEqual({
      state: 'unlocked',
      protection: 'keystore',
      reason: null,
      keystoreAvailable: true,
      recoveryCodePending: true,
    });
    expect(first.getPendingRecoveryCode()).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    const envelope = first.encrypt('agent-secret', 'entry-1', 'value', 'canary-value');
    stop(first);

    const second = await startVault(db, keystore);
    expect(second.getState()).toBe('unlocked');
    expect(second.decrypt('agent-secret', 'entry-1', 'value', envelope).toString()).toBe(
      'canary-value',
    );
    expect(keystore.items.size).toBe(1);
  });

  it.each([
    ['file', 'file', 'unlocked', null],
    ['recovery', 'recovery', 'locked', 'recovery_required'],
  ] as const)(
    'stays not_set_up without a keystore until setup with %s',
    async (mode, protection, restartState, restartReason) => {
      const db = newDatabase();
      const keystore = new FakeKeystore();
      keystore.available = false;

      const first = await startVault(db, keystore);
      expect(first.getStatus()).toMatchObject({
        state: 'not_set_up',
        reason: 'keystore_unavailable',
      });
      expect(existsSync(join(fileKeyDirectory, 'kek'))).toBe(false);

      expect(await first.setup(mode)).toMatchObject({
        state: 'unlocked',
        protection,
        recoveryCodePending: true,
      });
      expect(first.getPendingRecoveryCode()).not.toBeNull();
      stop(first);

      const second = await startVault(db, keystore);
      expect(second.getStatus()).toMatchObject({ state: restartState, reason: restartReason });
    },
  );

  it('refuses a second setup', async () => {
    const keystore = new FakeKeystore();
    keystore.available = false;
    const vault = await startVault(newDatabase(), keystore);
    await vault.setup('recovery');

    await expect(vault.setup('file')).rejects.toMatchObject({
      details: { code: 'VAULT_ALREADY_SET_UP' },
    });
  });

  it('unlocks with the recovery code when the keystore item is missing and stores a new keystore slot', async () => {
    const db = newDatabase();
    const keystore = new FakeKeystore();
    const first = await startVault(db, keystore);
    const code = first.getPendingRecoveryCode()!;
    const envelope = first.encrypt('agent-secret', 'entry-1', 'value', 'canary-value');
    stop(first);
    keystore.items.clear();

    const second = await startVault(db, keystore);
    expect(second.getStatus()).toMatchObject({ state: 'locked', reason: 'keystore_missing' });

    // Typed by hand: lower case, spaces instead of dashes.
    await second.unlockWithRecoveryCode(code.toLowerCase().replace(/-/g, ' '));
    expect(second.getState()).toBe('unlocked');
    expect(second.decrypt('agent-secret', 'entry-1', 'value', envelope).toString()).toBe(
      'canary-value',
    );
    expect(keystore.items.size).toBe(1);
    stop(second);

    const third = await startVault(db, keystore);
    expect(third.getState()).toBe('unlocked');
  });

  it('rejects a wrong recovery code and stays locked', async () => {
    const db = newDatabase();
    const keystore = new FakeKeystore();
    stop(await startVault(db, keystore));
    keystore.items.clear();
    const vault = await startVault(db, keystore);

    await expect(vault.unlockWithRecoveryCode('A'.repeat(32))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(vault.getState()).toBe('locked');
  });

  it('cannot decrypt from a copy of the DB and ~/.devchain without the keystore item', async () => {
    const db = newDatabase();
    const home = await startVault(db, new FakeKeystore());
    const envelope = home.encrypt('agent-secret', 'entry-1', 'value', 'canary-value');

    const copy = await startVault(copyDatabase(db), new FakeKeystore());

    expect(copy.getStatus()).toMatchObject({ state: 'locked', reason: 'keystore_missing' });
    expect(() => copy.decrypt('agent-secret', 'entry-1', 'value', envelope)).toThrow(
      VaultUnavailableError,
    );
    // Keystore mode writes no key next to the DB.
    expect(existsSync(join(fileKeyDirectory, 'kek'))).toBe(false);
  });

  it.each([
    ['another record id', ['agent-secret', 'entry-2', 'value']],
    ['another field', ['agent-secret', 'entry-1', 'description']],
    ['another domain', ['integration', 'entry-1', 'value']],
  ] as const)('refuses ciphertext moved to %s', async (_label, [domain, recordId, field]) => {
    const vault = await startVault(newDatabase(), new FakeKeystore());
    const envelope = vault.encrypt('agent-secret', 'entry-1', 'value', 'canary-value');

    expect(() => vault.decrypt(domain, recordId, field, envelope)).toThrow(StorageError);
  });

  it('keeps separate keystore items for two instances of one OS user', async () => {
    const keystore = new FakeKeystore();
    const first = await startVault(newDatabase(), keystore);
    const second = await startVault(newDatabase(), keystore);
    const envelope = first.encrypt('agent-secret', 'entry-1', 'value', 'canary-value');

    expect(keystore.items.size).toBe(2);
    expect(second.getState()).toBe('unlocked');
    expect(() => second.decrypt('agent-secret', 'entry-1', 'value', envelope)).toThrow(
      StorageError,
    );
  });

  describe('with a blocked keystore', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    });

    it('reports locked within the time limit and unlocks when the store answers', async () => {
      const db = newDatabase();
      const keystore = new FakeKeystore();
      const setUp = createVault(db, keystore);
      const setUpDone = setUp.onModuleInit();
      await reached(setUp, 'unlocked');
      await setUpDone;
      stop(setUp);

      let answer!: () => void;
      keystore.gate = new Promise((resolve) => (answer = resolve));
      const vault = createVault(db, keystore);
      const started = vault.onModuleInit();
      await jest.advanceTimersByTimeAsync(1000);
      await started;
      expect(vault.getStatus()).toMatchObject({ state: 'locked', reason: 'keystore_timeout' });

      keystore.gate = null;
      answer();
      await reached(vault, 'unlocked');
    });

    it('retries in the background after a keystore error', async () => {
      const db = newDatabase();
      const keystore = new FakeKeystore();
      const setUp = createVault(db, keystore);
      const setUpDone = setUp.onModuleInit();
      await reached(setUp, 'unlocked');
      await setUpDone;
      stop(setUp);

      keystore.failures = 1;
      const vault = await startVault(db, keystore);
      expect(vault.getStatus()).toMatchObject({ state: 'locked', reason: 'keystore_error' });

      await jest.advanceTimersByTimeAsync(5000);
      await reached(vault, 'unlocked');
    });

    it('stays unlocked when the start-time retry fires after a recovery-code unlock', async () => {
      const db = newDatabase();
      const keystore = new FakeKeystore();
      const setUp = createVault(db, keystore);
      const setUpDone = setUp.onModuleInit();
      await reached(setUp, 'unlocked');
      await setUpDone;
      const code = setUp.getPendingRecoveryCode()!;
      stop(setUp);

      keystore.failures = 1;
      const vault = await startVault(db, keystore);
      expect(vault.getStatus()).toMatchObject({ state: 'locked', reason: 'keystore_error' });
      await vault.unlockWithRecoveryCode(code);
      expect(vault.getState()).toBe('unlocked');

      keystore.available = false;
      await jest.advanceTimersByTimeAsync(5000);
      expect(vault.getStatus()).toMatchObject({ state: 'unlocked', reason: null });
    });
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

    it('reports not_set_up, makes no keystore item and refuses setup', async () => {
      const keystore = new FakeKeystore();
      const vault = await startVault(newDatabase(), keystore);

      expect(vault.getStatus()).toMatchObject({ state: 'not_set_up', reason: 'claimed_host' });
      expect(keystore.items.size).toBe(0);
      await expect(vault.setup('file')).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  it('puts no data key, key-encryption key or recovery code in events or logs', async () => {
    const db = newDatabase();
    const keystore = new FakeKeystore();
    const events: VaultStatus[] = [];
    const first = createVault(db, keystore);
    first.statusChanges().subscribe((status) => events.push(status));
    await first.onModuleInit();
    const code = first.getPendingRecoveryCode()!;
    stop(first);
    keystore.items.clear();

    const second = createVault(db, keystore);
    second.statusChanges().subscribe((status) => events.push(status));
    await second.onModuleInit();
    await second.unlockWithRecoveryCode(code);
    await second.confirmRecoveryCode();

    const [account, kek] = [...keystore.items.entries()][0];
    const slot = (await new LocalStorageService(db).listVaultKeySlots()).find(
      (candidate) => candidate.keystoreAccount === account,
    )!;
    const dek = open(
      kek,
      slotAad(slot.vaultId, slot.id, slot.kind, slot.dekVersion),
      slot.wrappedDek,
    );
    const secrets = [code, code.replace(/-/g, ''), ...[dek, kek].flatMap(encodings)];
    const published = JSON.stringify([events, mockLogLines]);

    expect(secrets.filter((secret) => published.includes(secret))).toEqual([]);
    expect(second.getPendingRecoveryCode()).toBeNull();
    expect(second.getStatus().recoveryCodePending).toBe(false);
  });
});

function encodings(key: Buffer): string[] {
  return [key.toString('hex'), key.toString('base64'), key.toString('base64url')];
}
