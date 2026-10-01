import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AppError } from '../../common/errors/error-types';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import { IgnorePatternsSchema } from './file-sync.dto';

export class InvalidManagedExclusionsError extends AppError {
  constructor() {
    super(
      'Stored managed file-sync exclusions are invalid. Repair them before syncing.',
      'FILE_SYNC_MANAGED_EXCLUSIONS_INVALID',
      409,
    );
  }
}

/**
 * The `fileSync.managedExclusions` setting: a JSON map of project id to the
 * Syncthing ignore patterns DevChain owns — in-project Docker data folders a
 * remote must keep out of sync. Only the sync handoff composes them into the
 * folder ignores; the user's editable ignore list and the host-install size
 * estimate read the user's patterns alone and must never see these.
 */
const SETTINGS_KEY = 'fileSync.managedExclusions';

@Injectable()
export class FileSyncManagedExclusionsStore {
  private readonly sqlite: Database.Database;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
  }

  /** The project's managed patterns; empty when DevChain owns none. */
  get(projectId: string): string[] {
    const map = this.readMap();
    return Object.hasOwn(map, projectId) ? map[projectId] : [];
  }

  /**
   * Replaces the project's managed patterns, so a changed or empty selection
   * recomputes what the next handoff installs. `null` or an empty selection
   * clears the entry.
   */
  set(projectId: string, patterns: string[] | null): string[] {
    const map = this.readMap();
    if (patterns === null || patterns.length === 0) delete map[projectId];
    else map[projectId] = IgnorePatternsSchema.parse(patterns);
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
      const parsed: unknown = JSON.parse(row.value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new InvalidManagedExclusionsError();
      }
      const entries = Object.entries(parsed).map(([projectId, value]) => {
        const patterns = IgnorePatternsSchema.safeParse(value);
        if (!patterns.success) throw new InvalidManagedExclusionsError();
        return [projectId, patterns.data] as const;
      });
      return Object.fromEntries(entries);
    } catch {
      // Corruption must block sync and writes, never erase protective or unrelated entries.
      throw new InvalidManagedExclusionsError();
    }
  }
}
