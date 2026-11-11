import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_KEY_LENGTH } from './vault-crypto';

const KEY_FILE = 'kek';

/**
 * The key-encryption key of the explicit `file` protection mode, at
 * `<vault dir>/kek` (0600 in a 0700 directory). Instances of one OS user share
 * the file; each wraps its own data key with it.
 */
export class VaultFileKey {
  constructor(private readonly directory: string) {}

  /** Creates the key file when missing and returns its key. */
  readOrCreate(): Buffer {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    try {
      writeFileSync(this.path, randomBytes(VAULT_KEY_LENGTH), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const key = this.read();
    if (!key) throw new Error('The Vault key file is not usable.');
    return key;
  }

  /** Null when the file is missing, not a regular file, or the wrong length. */
  read(): Buffer | null {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile()) return null;
      chmodSync(this.path, 0o600);
      const key = readFileSync(this.path);
      return key.length === VAULT_KEY_LENGTH ? key : null;
    } catch {
      return null;
    }
  }

  private get path(): string {
    return join(this.directory, KEY_FILE);
  }
}
