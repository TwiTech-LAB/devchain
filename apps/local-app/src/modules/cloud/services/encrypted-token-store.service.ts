import { Injectable, Inject } from '@nestjs/common';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir, hostname, userInfo } from 'os';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { createLogger } from '../../../common/logging/logger';
import type { CloudTokens } from '../types';

const logger = createLogger('EncryptedTokenStore');

// local-machine protection only — not strong secret isolation.
// A user with shell access to this machine can recover refresh tokens.
const APP_SALT = Buffer.from('devchain-cloud-token-store-v1-salt', 'utf8');
const SETTINGS_KEY = 'cloud.tokens.encrypted';
const SECRET_DIR = join(homedir(), '.devchain', 'cloud');
const SECRET_FILE = join(SECRET_DIR, 'secret.key');
const SECRET_LENGTH = 32;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

@Injectable()
export class EncryptedTokenStoreService {
  private sqlite: Database.Database;
  private encryptionKey: Buffer | null = null;

  constructor(@Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(this.db);
  }

  private getEncryptionKey(): Buffer {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    const secret = this.getOrCreateSecret();
    const machineComponent = Buffer.from(`${hostname()}:${userInfo().username}`, 'utf8');
    const password = Buffer.concat([secret, machineComponent]);

    this.encryptionKey = scryptSync(password, APP_SALT, KEY_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    });

    return this.encryptionKey;
  }

  private getOrCreateSecret(): Buffer {
    if (existsSync(SECRET_FILE)) {
      return readFileSync(SECRET_FILE);
    }

    if (!existsSync(SECRET_DIR)) {
      mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
    }

    const secret = randomBytes(SECRET_LENGTH);
    writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    chmodSync(SECRET_FILE, 0o600);
    logger.info('Created new cloud token encryption secret');
    return secret;
  }

  private encrypt(plaintext: string): string {
    const key = this.getEncryptionKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, encrypted]).toString('base64');
  }

  private decrypt(ciphertext: string): string {
    const key = this.getEncryptionKey();
    const data = Buffer.from(ciphertext, 'base64');
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv('aes-256-gcm', key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }

  store(tokens: CloudTokens): void {
    const plaintext = JSON.stringify(tokens);
    const encrypted = this.encrypt(plaintext);
    const now = new Date().toISOString();

    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, encrypted, now, now);

    logger.info({ userId: tokens.userId }, 'Cloud tokens stored');
  }

  retrieve(): CloudTokens | null {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;

    if (!row) {
      return null;
    }

    try {
      const plaintext = this.decrypt(row.value);
      return JSON.parse(plaintext) as CloudTokens;
    } catch (error) {
      logger.warn({ error }, 'Failed to decrypt cloud tokens — clearing stale data');
      this.clear();
      return null;
    }
  }

  clear(): void {
    this.sqlite.prepare('DELETE FROM settings WHERE key = ?').run(SETTINGS_KEY);
    logger.info('Cloud tokens cleared');
  }
}
