import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { LocalStorageService } from '../storage/local/local-storage.service';
import type { VaultEntryProjectAccess, VaultGrantAccess } from '../storage/models/domain.models';
import { VAULT_ENTRY_DOMAIN, VAULT_ENTRY_VALUE_FIELD } from './vault-entries.service';
import { VaultKeyService } from './vault-key.service';
import { VaultKeystoreUnavailableError, type VaultKeystore } from './vault-keystore';
import { VaultAccessService } from './vault-access.service';
import { VaultLaunchService } from './vault-launch.service';

const NO_KEYSTORE: VaultKeystore = {
  isAvailable: () => false,
  read: () => Promise.reject(new VaultKeystoreUnavailableError()),
  write: () => Promise.reject(new VaultKeystoreUnavailableError()),
  remove: () => Promise.reject(new VaultKeystoreUnavailableError()),
};

// Backend integration: grants and access go through the real storage delegates on
// migrated SQLite. Values reach agents only through the resolve route
// (vault-resolve.controller.integration.spec.ts).
describe('VaultLaunchService', () => {
  let root: string;
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let storage: LocalStorageService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'devchain-vault-launch-'));
    ({ sqlite, db } = createTestDatabase());
    storage = new LocalStorageService(db);
    for (const id of ['A', 'B']) {
      sqlite
        .prepare(
          `INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, 'T', 'T')`,
        )
        .run(id, `Project ${id}`, `/tmp/${id}`);
    }
    for (const slug of ['coder', 'reviewer']) {
      sqlite
        .prepare(
          `INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
           VALUES (?, 'A', ?, ?, 'T', 'T')`,
        )
        .run(randomUUID(), `profile-${slug}`, slug);
    }
  });

  afterEach(() => {
    sqlite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reads access and counts granted entries without a value, also while the Vault is locked', async () => {
    const vault = new VaultKeyService(storage, NO_KEYSTORE, {
      unlockTimeoutMs: 1000,
      fileKeyDirectory: join(root, 'vault'),
    });
    await vault.onModuleInit();
    await vault.setup('recovery');
    const grants: Array<[string, VaultGrantAccess]> = [
      ['ALL_AGENTS', { mode: 'all' }],
      ['CODER_ONLY', { mode: 'families', familySlugs: ['coder'] }],
    ];
    for (const [name, access] of grants) {
      const id = randomUUID();
      await storage.createVaultEntry({
        id,
        projects: [{ projectId: 'A', ...access } as VaultEntryProjectAccess],
        name,
        kind: 'secret',
        description: name,
        valueCiphertext: vault.encrypt(VAULT_ENTRY_DOMAIN, id, VAULT_ENTRY_VALUE_FIELD, 'v'),
      });
    }
    await storage.setVaultFamilyAccess('A', { mode: 'all' });
    vault.onModuleDestroy();

    const locked = new VaultKeyService(storage, NO_KEYSTORE, {
      fileKeyDirectory: join(root, 'vault'),
    });
    await locked.onModuleInit();
    expect(locked.getState()).toBe('locked');
    const launch = new VaultLaunchService(
      storage,
      new VaultAccessService(storage, locked, { valuesFor: () => [] }),
    );

    expect(await launch.hasAccess('A', 'coder')).toBe(true);
    expect(await launch.grantedEntryCount('A', 'coder')).toBe(2);
    expect(await launch.grantedEntryCount('A', 'reviewer')).toBe(1);
    expect(await launch.grantedEntryCount('B', 'coder')).toBe(0);
    await storage.setVaultFamilyAccess('A', { mode: 'none' });
    expect(await launch.hasAccess('A', 'coder')).toBe(false);
    expect(await launch.grantedEntryCount('A', 'coder')).toBe(0);
    locked.onModuleDestroy();
  });
});
