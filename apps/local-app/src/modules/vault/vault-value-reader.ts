import { Inject, Injectable, Optional } from '@nestjs/common';
import { filter, firstValueFrom, timeout } from 'rxjs';
import { ConflictError, VaultLockedError } from '../../common/errors/error-types';
import { STORAGE_SERVICE, type VaultEntryStorage } from '../storage/interfaces/storage.interface';
import type { VaultResolvedEntry } from '../storage/models/domain.models';
import { VAULT_ENTRY_DOMAIN, VAULT_ENTRY_VALUE_FIELD } from './vault-entries.service';
import { VaultKeyService } from './vault-key.service';
import { VaultVmCacheService } from './vault-vm-cache.service';

export const VAULT_UNLOCK_WAIT_MS = Symbol('VAULT_UNLOCK_WAIT_MS');
const DEFAULT_UNLOCK_WAIT_MS = 5000;

const VM_CACHE_NOT_READY =
  'Home has not sent the Vault values to this VM since it started. Reconnect home to use Vault entries.';

type ReaderStorage = Pick<VaultEntryStorage, 'readVaultEntryCiphertexts'>;

/**
 * Reads plaintext values of resolved entries: at home it decrypts with the data key,
 * on a claimed VM it reads the cache of home's push. The result holds plaintext:
 * keep it in memory, never log it.
 */
@Injectable()
export class VaultValueReader {
  private readonly unlockWaitMs: number;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ReaderStorage,
    private readonly vault: VaultKeyService,
    private readonly vmCache: VaultVmCacheService,
    @Optional() @Inject(VAULT_UNLOCK_WAIT_MS) unlockWaitMs?: number,
  ) {
    this.unlockWaitMs = unlockWaitMs ?? DEFAULT_UNLOCK_WAIT_MS;
  }

  /**
   * Values by entry id. An entry deleted since resolution is absent. Throws
   * `VaultLockedError` when home's Vault stays locked past a short wait while it
   * unlocks, and at once on a VM whose cache lacks any entry at its revision.
   */
  async read(resolved: readonly VaultResolvedEntry[]): Promise<Map<string, Buffer>> {
    if (resolved.length === 0) return new Map();
    if (this.vmCache.isClaimedHost()) {
      const values = await this.vmCache.readValues(resolved);
      if (!values) throw new VaultLockedError('vm_cache_not_ready', VM_CACHE_NOT_READY);
      return values;
    }
    await this.awaitUnlocked();
    const sealed = await this.storage.readVaultEntryCiphertexts(resolved.map((entry) => entry.id));
    const names = new Map(resolved.map((entry) => [entry.id, entry.name]));
    return new Map(
      sealed.map((row) => [
        row.id,
        this.open(row.id, names.get(row.id) ?? row.id, row.valueCiphertext),
      ]),
    );
  }

  private async awaitUnlocked(): Promise<void> {
    if (this.vault.getState() === 'unlocking') {
      await firstValueFrom(
        this.vault.statusChanges().pipe(
          filter((status) => status.state !== 'unlocking'),
          timeout({ first: this.unlockWaitMs }),
        ),
      ).catch(() => undefined);
    }
    const state = this.vault.getState();
    if (state !== 'unlocked') throw new VaultLockedError(state);
  }

  private open(entryId: string, name: string, ciphertext: string): Buffer {
    try {
      return this.vault.decrypt(VAULT_ENTRY_DOMAIN, entryId, VAULT_ENTRY_VALUE_FIELD, ciphertext);
    } catch {
      throw new ConflictError(`The Vault entry ${name} cannot be read. Replace its value.`, {
        code: 'VAULT_ENTRY_UNREADABLE',
        entryId,
      });
    }
  }
}
