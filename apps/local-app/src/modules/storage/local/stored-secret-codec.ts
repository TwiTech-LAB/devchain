import { StorageError, VaultUnavailableError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type Database from 'better-sqlite3';
import type { TransactionRunner } from '../db/transaction-runner';
import type { VaultStoreMigrationResult, VaultStoreName } from '../models/domain.models';
import type { IntegrationCredentialCipher } from './integration-credential-cipher';
import type { VaultStoreKey } from './vault-store-key';

const logger = createLogger('StoredSecretCodec');

/** Where one sealed column value belongs, under each of the two keys. */
export interface StoredSecretBinding {
  /** Vault AAD domain, record id and field. */
  domain: string;
  recordId: string;
  field: string;
  /** AAD context of the integration credential key. */
  legacyContext: string;
}

// Vault envelopes are `v1:<dek version>:<base64>` (vault/vault-crypto.ts, which
// storage cannot import); integration credential key envelopes are `v1:<base64>`.
// Base64 has no `:`, so the two never overlap.
const VAULT_ENVELOPE = /^v1:\d+:/;

export function isVaultEnvelope(envelope: string): boolean {
  return VAULT_ENVELOPE.test(envelope);
}

/**
 * Seals and opens one secret column under the Vault data key or, until the
 * column is migrated, the integration credential key. Reads accept both
 * formats; writes follow `VaultStoreKey.mode()`.
 */
export class StoredSecretCodec {
  constructor(
    private readonly legacy: IntegrationCredentialCipher,
    private readonly vault: VaultStoreKey,
  ) {}

  /** Throws `VaultUnavailableError` when `seal` would; lets callers refuse before side effects. */
  assertCanSeal(): void {
    this.vault.assertCanSeal();
  }

  /** Throws `VaultUnavailableError` while the Vault protects the stores but is locked. */
  seal(binding: StoredSecretBinding, plaintext: string): string {
    switch (this.vault.mode()) {
      case 'vault':
        return this.vault.encrypt(binding.domain, binding.recordId, binding.field, plaintext);
      case 'legacy':
        return this.legacy.encryptValue(plaintext, binding.legacyContext);
      case 'locked':
        throw this.vault.unavailable();
    }
  }

  /**
   * Throws `VaultUnavailableError` for a Vault envelope while the Vault is not
   * unlocked, and `StorageError` when the envelope does not open.
   */
  open(binding: StoredSecretBinding, envelope: string): string {
    if (isVaultEnvelope(envelope)) {
      return this.vault.decrypt(binding.domain, binding.recordId, binding.field, envelope);
    }
    return this.legacy.decryptValue(envelope, binding.legacyContext);
  }

  /**
   * The Vault envelope of a legacy value, checked by opening it again; null
   * when `envelope` is already a Vault envelope.
   */
  reseal(binding: StoredSecretBinding, envelope: string): string | null {
    if (isVaultEnvelope(envelope)) return null;
    if (this.vault.mode() !== 'vault') throw this.vault.unavailable();
    const plaintext = this.legacy.decryptValue(envelope, binding.legacyContext);
    const sealed = this.vault.encrypt(binding.domain, binding.recordId, binding.field, plaintext);
    if (this.vault.decrypt(binding.domain, binding.recordId, binding.field, sealed) !== plaintext) {
      throw new StorageError('The re-encrypted value did not verify.');
    }
    return sealed;
  }
}

export interface SealedRow {
  id: string;
  envelope: string;
}

export interface StoredSecretColumn {
  /** Every row id and its sealed value. */
  listEnvelopes(): SealedRow[];
  readEnvelope(id: string): string | undefined;
  /** Replaces the value only while it is still `previous`; true when a row changed. */
  replaceEnvelope(id: string, next: string, previous: string): boolean;
}

export interface StoredSecretMigration extends StoredSecretColumn {
  store: VaultStoreName;
  codec: StoredSecretCodec;
  txRunner: TransactionRunner;
  binding(id: string): StoredSecretBinding;
}

/** Column access for a table keyed by `id`; `table` and `column` are code constants. */
export function sqliteSecretColumn(
  client: Database.Database,
  table: string,
  column: string,
): StoredSecretColumn {
  return {
    listEnvelopes: () =>
      client.prepare(`SELECT id, ${column} AS envelope FROM ${table}`).all() as SealedRow[],
    readEnvelope: (id) =>
      (
        client.prepare(`SELECT ${column} AS envelope FROM ${table} WHERE id = ?`).get(id) as
          | { envelope: string }
          | undefined
      )?.envelope,
    replaceEnvelope: (id, next, previous) =>
      client
        .prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} = ?`)
        .run(next, id, previous).changes === 1,
  };
}

/**
 * Moves the legacy rows of one store to the Vault key, one transaction per row.
 * A row that does not open under the legacy key stays as it is and counts as
 * failed. Stops with `VaultUnavailableError` when the Vault stops being usable.
 */
export async function migrateStoredSecrets(
  migration: StoredSecretMigration,
): Promise<VaultStoreMigrationResult> {
  const rows = migration.listEnvelopes();
  let migrated = 0;
  let failed = 0;
  for (const { id, envelope } of rows) {
    if (isVaultEnvelope(envelope)) continue;
    try {
      const changed = await migration.txRunner.runImmediateQueuedOrJoin(() => {
        const current = migration.readEnvelope(id);
        if (current === undefined) return false;
        const sealed = migration.codec.reseal(migration.binding(id), current);
        return sealed !== null && migration.replaceEnvelope(id, sealed, current);
      });
      if (changed) migrated += 1;
    } catch (error) {
      if (error instanceof VaultUnavailableError) throw error;
      failed += 1;
      logger.warn({ store: migration.store, id }, 'Stored secret not moved to the Vault key');
    }
  }
  const after = migration.listEnvelopes();
  return {
    store: migration.store,
    total: after.length,
    vault: after.filter((row) => isVaultEnvelope(row.envelope)).length,
    migrated,
    failed,
  };
}
