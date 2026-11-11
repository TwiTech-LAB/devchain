import type { VaultKeySlotStorage } from '../../interfaces/storage.interface';
import { ConflictError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import type {
  CreateVaultKeySlot,
  VaultKdfParams,
  VaultKeySlot,
  VaultKeySlotKind,
} from '../../models/domain.models';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('VaultKeySlotStorageDelegate');

interface VaultKeySlotRow {
  id: string;
  vault_id: string;
  kind: string;
  dek_version: number;
  wrapped_dek: string;
  keystore_account: string | null;
  kdf_params: string | null;
  pending_recovery_code: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SLOT =
  'SELECT id, vault_id, kind, dek_version, wrapped_dek, keystore_account, kdf_params, pending_recovery_code, created_at, updated_at FROM vault_key_slots';

const INSERT_SLOT = `INSERT INTO vault_key_slots
  (id, vault_id, kind, dek_version, wrapped_dek, keystore_account, kdf_params,
   pending_recovery_code, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Wrapped data-key copies. Rows hold envelopes only; unwrapping lives in the vault module. */
export class VaultKeySlotStorageDelegate
  extends BaseStorageDelegate
  implements VaultKeySlotStorage
{
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async listVaultKeySlots(): Promise<VaultKeySlot[]> {
    return this.listSync();
  }

  async initializeVaultKeySlots(slots: CreateVaultKeySlot[]): Promise<VaultKeySlot[]> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const existing = this.rawClient
        .prepare('SELECT COUNT(*) AS count FROM vault_key_slots')
        .get() as {
        count: number;
      };
      if (existing.count > 0) {
        throw new ConflictError('The Vault is already set up.', { code: 'VAULT_ALREADY_SET_UP' });
      }
      const now = new Date().toISOString();
      for (const slot of slots) this.insertSync(slot, now);
      logger.info({ kinds: slots.map((slot) => slot.kind) }, 'Initialized vault key slots');
      return this.listSync();
    });
  }

  async replaceVaultKeySlot(slot: CreateVaultKeySlot): Promise<VaultKeySlot> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.rawClient
        .prepare('DELETE FROM vault_key_slots WHERE kind = ? AND dek_version = ?')
        .run(slot.kind, slot.dekVersion);
      this.insertSync(slot, new Date().toISOString());
      logger.info({ kind: slot.kind, dekVersion: slot.dekVersion }, 'Replaced vault key slot');
      return this.mapSlot(
        this.rawClient.prepare(`${SELECT_SLOT} WHERE id = ?`).get(slot.id) as VaultKeySlotRow,
      );
    });
  }

  async clearVaultPendingRecoveryCode(): Promise<void> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.rawClient
        .prepare(
          `UPDATE vault_key_slots SET pending_recovery_code = NULL, updated_at = ?
           WHERE pending_recovery_code IS NOT NULL`,
        )
        .run(new Date().toISOString());
    });
  }

  private listSync(): VaultKeySlot[] {
    const rows = this.rawClient
      .prepare(`${SELECT_SLOT} ORDER BY dek_version, kind`)
      .all() as VaultKeySlotRow[];
    return rows.map((row) => this.mapSlot(row));
  }

  private insertSync(slot: CreateVaultKeySlot, now: string): void {
    this.rawClient
      .prepare(INSERT_SLOT)
      .run(
        slot.id,
        slot.vaultId,
        slot.kind,
        slot.dekVersion,
        slot.wrappedDek,
        slot.keystoreAccount,
        slot.kdfParams ? JSON.stringify(slot.kdfParams) : null,
        slot.pendingRecoveryCode,
        now,
        now,
      );
  }

  private mapSlot(row: VaultKeySlotRow): VaultKeySlot {
    return {
      id: row.id,
      vaultId: row.vault_id,
      kind: row.kind as VaultKeySlotKind,
      dekVersion: row.dek_version,
      wrappedDek: row.wrapped_dek,
      keystoreAccount: row.keystore_account,
      kdfParams: row.kdf_params ? (JSON.parse(row.kdf_params) as VaultKdfParams) : null,
      pendingRecoveryCode: row.pending_recovery_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
