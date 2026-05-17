import { Injectable, Inject } from '@nestjs/common';
import {
  generateKeyPairSync,
  createPrivateKey,
  sign,
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from 'crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir, hostname, userInfo } from 'os';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('TunnelKeypair');

const SETTINGS_KEY = 'cloud.tunnel.keypair';
const APP_SALT = Buffer.from('devchain-tunnel-keypair-store-v1-salt', 'utf8');
const SECRET_DIR = join(homedir(), '.devchain', 'cloud');
const SECRET_FILE = join(SECRET_DIR, 'secret.key');
const SECRET_LENGTH = 32;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export interface StoredKeypair {
  publicKey: string;
  privateKey: string;
  instanceId?: string;
}

@Injectable()
export class TunnelKeypairService {
  private sqlite: Database.Database;
  private encryptionKey: Buffer | null = null;

  constructor(@Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(this.db);
  }

  async getOrCreate(): Promise<StoredKeypair> {
    const stored = this.retrieve();
    if (stored) return stored;
    return this.generate();
  }

  async generate(): Promise<StoredKeypair> {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keypair: StoredKeypair = {
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    };
    this.persist(keypair);
    logger.info('Generated new Ed25519 tunnel keypair');
    return keypair;
  }

  async sign(payload: string, privateKeyBase64: string): Promise<string> {
    const key = createPrivateKey({
      key: Buffer.from(privateKeyBase64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const sig = sign(null, Buffer.from(payload), key);
    return sig.toString('base64');
  }

  async setInstanceId(instanceId: string): Promise<void> {
    const stored = this.retrieve();
    if (!stored) return;
    stored.instanceId = instanceId;
    this.persist(stored);
  }

  private persist(keypair: StoredKeypair): void {
    const encrypted = this.encrypt(JSON.stringify(keypair));
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, encrypted, now, now);
  }

  private retrieve(): StoredKeypair | null {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(this.decrypt(row.value));
    } catch {
      logger.warn('Failed to decrypt tunnel keypair — will regenerate');
      return null;
    }
  }

  private getEncryptionKey(): Buffer {
    if (this.encryptionKey) return this.encryptionKey;
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
    if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE);
    if (!existsSync(SECRET_DIR)) mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
    const secret = randomBytes(SECRET_LENGTH);
    writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    chmodSync(SECRET_FILE, 0o600);
    return secret;
  }

  private encrypt(plaintext: string): string {
    const key = this.getEncryptionKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
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
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }
}
