import { AsyncEntry } from '@napi-rs/keyring';
import { getEnvConfig } from '../../common/config/env.config';

export const VAULT_KEYSTORE = Symbol('VAULT_KEYSTORE');

const KEYSTORE_SERVICE = 'devchain-vault';
const AVAILABILITY_PROBE_ACCOUNT = 'availability-probe';

/** This machine has no usable OS credential store (for example no session bus on Linux). */
export class VaultKeystoreUnavailableError extends Error {
  constructor() {
    super('No OS credential store is available.');
    this.name = 'VaultKeystoreUnavailableError';
  }
}

/**
 * The OS credential store. Every call may wait without limit for a user prompt,
 * so callers bound their own wait. Calls throw `VaultKeystoreUnavailableError`
 * when no store exists, and other errors when the store refuses.
 */
export interface VaultKeystore {
  isAvailable(): boolean;
  /** Null when the store has no item for `account`. */
  read(account: string): Promise<Buffer | null>;
  write(account: string, secret: Buffer): Promise<void>;
  remove(account: string): Promise<void>;
}

/**
 * macOS Keychain, Windows Credential Manager or the Linux Secret Service. Linux
 * is pinned to the Secret Service: the kernel keyring fallback keeps keys only
 * until logout, and it would silently weaken the protection the UI reports.
 */
export class OsVaultKeystore implements VaultKeystore {
  isAvailable(): boolean {
    try {
      this.entry(AVAILABILITY_PROBE_ACCOUNT);
      return true;
    } catch {
      return false;
    }
  }

  async read(account: string): Promise<Buffer | null> {
    const secret = await this.entry(account).getSecret();
    return secret ? Buffer.from(secret) : null;
  }

  async write(account: string, secret: Buffer): Promise<void> {
    await this.entry(account).setSecret(secret);
  }

  async remove(account: string): Promise<void> {
    await this.entry(account).deleteCredential();
  }

  private entry(account: string): AsyncEntry {
    if (!getEnvConfig().VAULT_KEYSTORE_ENABLED) throw new VaultKeystoreUnavailableError();
    try {
      // Opening the entry connects to the store; this throws when none is reachable.
      return new AsyncEntry(KEYSTORE_SERVICE, account, { linux: { store: 'secret-service' } });
    } catch {
      throw new VaultKeystoreUnavailableError();
    }
  }
}
