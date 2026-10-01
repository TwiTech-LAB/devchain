import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { createLogger } from '../../common/logging/logger';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';

const logger = createLogger('SyncthingSettingsStore');

const SETTINGS_KEY = 'fileSync.syncthing';

const StoredSchema = z.object({
  apiKey: z.string().min(1),
  apiPort: z.number().int().positive(),
  listenPort: z.number().int().positive(),
});

/**
 * The instance's loopback ports and API key. The key only guards a loopback
 * API, so it is stored in plain text, but it is never logged.
 */
export type SyncthingSettings = z.infer<typeof StoredSchema>;

@Injectable()
export class SyncthingSettingsStore {
  private readonly sqlite: Database.Database;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
  }

  read(): SyncthingSettings | null {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      return StoredSchema.parse(JSON.parse(row.value));
    } catch {
      logger.warn('Stored Syncthing settings are invalid; new ones will be generated');
      return null;
    }
  }

  write(settings: SyncthingSettings): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(StoredSchema.parse(settings)), now, now);
  }
}
