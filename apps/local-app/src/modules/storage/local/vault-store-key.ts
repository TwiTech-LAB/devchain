import { Injectable } from '@nestjs/common';
import { VaultUnavailableError } from '../../../common/errors/error-types';

/**
 * Which key seals new values of the stores that `StoredSecretCodec` handles:
 * - `vault`: the Vault data key; the Vault is unlocked and unlocks on its own at start;
 * - `legacy`: the integration credential key; the Vault has no auto-unlock slot,
 *   is not set up, or this is a claimed VM;
 * - `locked`: the Vault protects these stores but is not unlocked now.
 */
export type VaultStoreKeyMode = 'vault' | 'legacy' | 'locked';

export interface VaultStoreKeySource {
  mode(): VaultStoreKeyMode;
  /** The Vault state, for the `VaultUnavailableError` details. */
  state(): string;
  /** Throws `VaultUnavailableError` unless the Vault is unlocked. */
  encrypt(domain: string, recordId: string, field: string, plaintext: string): string;
  /** Throws `VaultUnavailableError` unless unlocked, `StorageError` for a bad envelope. */
  decrypt(domain: string, recordId: string, field: string, envelope: string): string;
}

/**
 * The Vault data key as the storage layer sees it. The Vault module depends on
 * storage, so it binds itself here instead of being injected into storage.
 * Unbound (no Vault module in this process), new values stay `legacy` and a
 * Vault envelope does not open.
 */
@Injectable()
export class VaultStoreKey {
  private source: VaultStoreKeySource | null = null;

  bind(source: VaultStoreKeySource): void {
    this.source = source;
  }

  mode(): VaultStoreKeyMode {
    return this.source?.mode() ?? 'legacy';
  }

  /** Throws `VaultUnavailableError` while new values cannot be sealed (`locked`). */
  assertCanSeal(): void {
    if (this.mode() === 'locked') throw this.unavailable();
  }

  unavailable(): VaultUnavailableError {
    return new VaultUnavailableError(
      this.source?.state() ?? 'not_set_up',
      'Vault locked. Unlock the Vault in Settings → Vault to use this login or connection.',
    );
  }

  encrypt(domain: string, recordId: string, field: string, plaintext: string): string {
    return this.call((source) => source.encrypt(domain, recordId, field, plaintext));
  }

  decrypt(domain: string, recordId: string, field: string, envelope: string): string {
    return this.call((source) => source.decrypt(domain, recordId, field, envelope));
  }

  private call(work: (source: VaultStoreKeySource) => string): string {
    if (!this.source) throw this.unavailable();
    try {
      return work(this.source);
    } catch (error) {
      if (error instanceof VaultUnavailableError) throw this.unavailable();
      throw error;
    }
  }
}
