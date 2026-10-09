import type { ProviderAuthStorage } from '../../interfaces/storage.interface';
import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import type { IntegrationCredentialCipher } from '../integration-credential-cipher';
import type {
  CreateProviderAuthEntry,
  ProviderAuthEntry,
  ProviderAuthPayload,
} from '../../models/domain.models';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ProviderAuthStorageDelegate');

/** Binds vault ciphertext to this protection domain; see `encryptValue`. */
const VAULT_CIPHER_CONTEXT = 'devchain-provider-auth-vault-v1';

interface ProviderAuthEntryRow {
  id: string;
  provider: string;
  kind: string;
  label: string;
  payload_ciphertext: string;
  payload_kind: string;
  checked_out_remote_id: string | null;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  last_writeback_at: string | null;
}

const SELECT_ENTRY =
  'SELECT id, provider, kind, label, payload_ciphertext, payload_kind, checked_out_remote_id, created_at, updated_at, last_verified_at, last_writeback_at FROM provider_auth_entries';

/**
 * Vault entries with encrypted payloads. Every method that reads a payload
 * keeps it inside this storage layer's callers' claim path; list/get return
 * the ciphertext column so the service can drop it, never the plaintext.
 */
export class ProviderAuthStorageDelegate
  extends BaseStorageDelegate
  implements ProviderAuthStorage
{
  constructor(
    context: StorageDelegateContext,
    private readonly cipher: IntegrationCredentialCipher,
  ) {
    super(context);
  }

  async listProviderAuthEntries(): Promise<ProviderAuthEntry[]> {
    const rows = this.rawClient
      .prepare(`${SELECT_ENTRY} ORDER BY provider, label COLLATE NOCASE`)
      .all() as ProviderAuthEntryRow[];
    return rows.map((row) => this.mapEntry(row));
  }

  async getProviderAuthEntry(id: string): Promise<ProviderAuthEntry> {
    return this.getEntrySync(id);
  }

  /** Decrypts one entry's payload; only the claim/compose path may call this. */
  async readProviderAuthPayload(id: string): Promise<ProviderAuthPayload> {
    const row = this.getEntrySync(id);
    try {
      const parsed = JSON.parse(
        this.cipher.decryptValue(row.payloadCiphertext, VAULT_CIPHER_CONTEXT),
      ) as ProviderAuthPayload;
      if (this.payloadKindOf(parsed) !== row.payloadKind) {
        throw new Error('payload kind mismatch');
      }
      return parsed;
    } catch {
      throw new ConflictError('The stored provider auth payload could not be decrypted.', {
        code: 'PROVIDER_AUTH_PAYLOAD_UNREADABLE',
        entryId: id,
      });
    }
  }

  async createProviderAuthEntry(data: CreateProviderAuthEntry): Promise<ProviderAuthEntry> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const now = new Date().toISOString();
      const id = randomUUID();
      this.rawClient
        .prepare(
          `INSERT INTO provider_auth_entries
             (id, provider, kind, label, payload_ciphertext, payload_kind, created_at, updated_at,
              last_verified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          data.provider,
          data.kind,
          data.label,
          this.cipher.encryptValue(JSON.stringify(data.payload), VAULT_CIPHER_CONTEXT),
          data.payload.payloadKind,
          now,
          now,
          data.lastVerifiedAt ?? null,
        );
      logger.info({ entryId: id, provider: data.provider, kind: data.kind }, 'Created auth entry');
      return this.getEntrySync(id);
    });
  }

  async deleteProviderAuthEntry(id: string): Promise<void> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getEntrySync(id);
      this.rawClient.prepare('DELETE FROM provider_auth_entries WHERE id = ?').run(id);
      logger.info({ entryId: id }, 'Deleted auth entry');
    });
  }

  /**
   * Re-encrypts one entry's payload and stamps `last_writeback_at`. The family
   * write-back path only; the mtime bookkeeping of the pull lives at home's
   * pull service, this row is the durable record of the last write-back.
   */
  async updateProviderAuthPayload(
    id: string,
    payload: ProviderAuthPayload,
  ): Promise<ProviderAuthEntry> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getEntrySync(id);
      const now = new Date().toISOString();
      this.rawClient
        .prepare(
          `UPDATE provider_auth_entries
             SET payload_ciphertext = ?, payload_kind = ?, last_writeback_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          this.cipher.encryptValue(JSON.stringify(payload), VAULT_CIPHER_CONTEXT),
          payload.payloadKind,
          now,
          now,
          id,
        );
      logger.info({ entryId: id, payloadKind: payload.payloadKind }, 'Updated auth payload');
      return this.getEntrySync(id);
    });
  }

  /**
   * Renames one entry. Only `label` and `updated_at` change: the payload,
   * the checkout state and the verification stamps stay exactly as stored,
   * so a login held by a VM keeps working under its new name.
   */
  async renameProviderAuthEntry(id: string, label: string): Promise<ProviderAuthEntry> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getEntrySync(id);
      this.rawClient
        .prepare('UPDATE provider_auth_entries SET label = ?, updated_at = ? WHERE id = ?')
        .run(label, new Date().toISOString(), id);
      logger.info({ entryId: id }, 'Renamed auth entry');
      return this.getEntrySync(id);
    });
  }

  /**
   * Checks a family out to one remote. A family already held by another remote
   * answers 409; re-checking out to the same remote is idempotent. Static
   * entries never check out.
   */
  async checkoutProviderAuthEntry(id: string, remoteId: string): Promise<ProviderAuthEntry> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const entry = this.getEntrySync(id);
      if (entry.kind !== 'family') {
        throw new ConflictError('Static provider auth entries are never checked out.', {
          code: 'PROVIDER_AUTH_NOT_A_FAMILY',
          entryId: id,
        });
      }
      if (!this.remoteExistsSync(remoteId)) {
        throw new NotFoundError('Remote', remoteId);
      }
      if (entry.checkedOutRemoteId && entry.checkedOutRemoteId !== remoteId) {
        throw new ConflictError('This login family is already checked out to another remote.', {
          code: 'PROVIDER_AUTH_ALREADY_CHECKED_OUT',
          entryId: id,
          checkedOutRemoteId: entry.checkedOutRemoteId,
        });
      }
      if (entry.checkedOutRemoteId === remoteId) {
        return entry;
      }
      this.rawClient
        .prepare(
          'UPDATE provider_auth_entries SET checked_out_remote_id = ?, updated_at = ? WHERE id = ?',
        )
        .run(remoteId, new Date().toISOString(), id);
      logger.info({ entryId: id, remoteId }, 'Checked out auth family');
      return this.getEntrySync(id);
    });
  }

  async releaseProviderAuthEntry(id: string): Promise<ProviderAuthEntry> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const entry = this.getEntrySync(id);
      if (!entry.checkedOutRemoteId) {
        return entry;
      }
      this.rawClient
        .prepare(
          'UPDATE provider_auth_entries SET checked_out_remote_id = NULL, updated_at = ? WHERE id = ?',
        )
        .run(new Date().toISOString(), id);
      logger.info({ entryId: id }, 'Released auth family');
      return this.getEntrySync(id);
    });
  }

  private getEntrySync(id: string): ProviderAuthEntry {
    const row = this.rawClient.prepare(`${SELECT_ENTRY} WHERE id = ?`).get(id) as
      | ProviderAuthEntryRow
      | undefined;
    if (!row) {
      throw new NotFoundError('Provider auth entry', id);
    }
    return this.mapEntry(row);
  }

  private remoteExistsSync(id: string): boolean {
    return Boolean(
      this.rawClient.prepare('SELECT id FROM remotes WHERE id = ?').get(id) as
        | { id: string }
        | undefined,
    );
  }

  private payloadKindOf(payload: ProviderAuthPayload): string {
    return payload.payloadKind;
  }

  private mapEntry(row: ProviderAuthEntryRow): ProviderAuthEntry {
    return {
      id: row.id,
      provider: row.provider,
      kind: row.kind as ProviderAuthEntry['kind'],
      label: row.label,
      payloadCiphertext: row.payload_ciphertext,
      payloadKind: row.payload_kind as ProviderAuthEntry['payloadKind'],
      checkedOutRemoteId: row.checked_out_remote_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastVerifiedAt: row.last_verified_at,
      lastWritebackAt: row.last_writeback_at,
    };
  }
}
