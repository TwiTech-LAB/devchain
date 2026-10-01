import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createLogger } from '../../common/logging/logger';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import { DEFAULT_FILE_SYNC_IGNORES, IgnorePatternsSchema } from './file-sync.dto';

const logger = createLogger('FileSyncIgnoresStore');

/** The `file_sync_ignores` setting: a JSON map of project id to Syncthing ignore patterns. */
const SETTINGS_KEY = 'fileSync.ignores';

export { DEFAULT_FILE_SYNC_IGNORES };

@Injectable()
export class FileSyncIgnoresStore {
  private readonly sqlite: Database.Database;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
  }

  /** The project's patterns, or the defaults when it has none of its own. */
  get(projectId: string): string[] {
    return this.readMap()[projectId] ?? [...DEFAULT_FILE_SYNC_IGNORES];
  }

  /** Stores the project's patterns; null returns it to the defaults. */
  set(projectId: string, ignores: string[] | null): string[] {
    const map = this.readMap();
    if (ignores === null) delete map[projectId];
    else map[projectId] = IgnorePatternsSchema.parse(ignores);
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(map), now, now);
    return this.get(projectId);
  }

  private readMap(): Record<string, string[]> {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      const map: Record<string, string[]> = {};
      for (const [projectId, value] of Object.entries(parsed)) {
        const ignores = IgnorePatternsSchema.safeParse(value);
        if (ignores.success) map[projectId] = ignores.data;
      }
      return map;
    } catch {
      logger.warn('Stored file sync ignore patterns are invalid; using the defaults');
      return {};
    }
  }
}
