import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { StorageError } from '../../../common/errors/error-types';
import type { IntegrationCredentials } from '../models/domain.models';

const APP_SALT = Buffer.from('devchain-integration-credential-store-v1-salt', 'utf8');
const CIPHER_CONTEXT = Buffer.from('devchain-integration-credentials-v1', 'utf8');
const SECRET_LENGTH = 32;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export const DEFAULT_INTEGRATION_SECRET_FILE = join(
  homedir(),
  '.devchain',
  'integrations',
  'secret.key',
);

export interface IntegrationCredentialCipherOptions {
  secretDirectory?: string;
  machineIdentity?: string;
}

export class IntegrationCredentialCipher {
  private readonly secretDirectory: string;
  private readonly secretFile: string;
  private readonly machineIdentity: string;
  private encryptionKey: Buffer | null = null;

  constructor(options: IntegrationCredentialCipherOptions = {}) {
    this.secretDirectory = options.secretDirectory ?? join(homedir(), '.devchain', 'integrations');
    this.secretFile = join(this.secretDirectory, 'secret.key');
    this.machineIdentity = options.machineIdentity ?? `${hostname()}:${userInfo().username}`;
  }

  encrypt(credentials: IntegrationCredentials): string {
    try {
      const key = this.getEncryptionKey();
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv('aes-256-gcm', key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      cipher.setAAD(CIPHER_CONTEXT);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(credentials), 'utf8'),
        cipher.final(),
      ]);
      return `v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')}`;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError('Unable to encrypt integration credentials.');
    }
  }

  decrypt(ciphertext: string): IntegrationCredentials {
    try {
      if (!ciphertext.startsWith('v1:')) {
        throw new Error('Unsupported credential ciphertext version');
      }
      const data = Buffer.from(ciphertext.slice(3), 'base64');
      if (data.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error('Credential ciphertext is incomplete');
      }

      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.getEncryptionKey(),
        data.subarray(0, IV_LENGTH),
        { authTagLength: AUTH_TAG_LENGTH },
      );
      decipher.setAAD(CIPHER_CONTEXT);
      decipher.setAuthTag(data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH));
      const plaintext = Buffer.concat([
        decipher.update(data.subarray(IV_LENGTH + AUTH_TAG_LENGTH)),
        decipher.final(),
      ]).toString('utf8');
      return this.parseCredentials(plaintext);
    } catch {
      throw new StorageError('Unable to decrypt integration credentials.');
    }
  }

  private getEncryptionKey(): Buffer {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    const password = Buffer.concat([
      this.getOrCreateSecret(),
      Buffer.from(this.machineIdentity, 'utf8'),
    ]);
    this.encryptionKey = scryptSync(password, APP_SALT, KEY_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    });
    return this.encryptionKey;
  }

  private getOrCreateSecret(): Buffer {
    mkdirSync(this.secretDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.secretDirectory, 0o700);

    if (!existsSync(this.secretFile)) {
      try {
        writeFileSync(this.secretFile, randomBytes(SECRET_LENGTH), {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new StorageError('Unable to create the integration credential key.');
        }
      }
    }

    const file = lstatSync(this.secretFile);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new StorageError('The integration credential key is not a regular file.');
    }
    chmodSync(this.secretFile, 0o600);
    const secret = readFileSync(this.secretFile);
    if (secret.length !== SECRET_LENGTH) {
      throw new StorageError('The integration credential key has an invalid length.');
    }
    return secret;
  }

  private parseCredentials(plaintext: string): IntegrationCredentials {
    const value = JSON.parse(plaintext) as unknown;
    if (!value || typeof value !== 'object') {
      throw new Error('Credential payload is invalid');
    }
    const candidate = value as Record<string, unknown>;
    if (candidate.provider === 'clickup' && typeof candidate.token === 'string') {
      return { provider: 'clickup', token: candidate.token };
    }
    if (
      candidate.provider === 'jira' &&
      typeof candidate.siteUrl === 'string' &&
      typeof candidate.email === 'string' &&
      typeof candidate.token === 'string'
    ) {
      return {
        provider: 'jira',
        siteUrl: candidate.siteUrl,
        email: candidate.email,
        token: candidate.token,
      };
    }
    throw new Error('Credential payload is invalid');
  }
}
