import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { createLogger } from '../../common/logging/logger';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import { TransactionRunner } from '../storage/db/transaction-runner';
import { AppError } from '../../common/errors/error-types';
import {
  DEFAULT_FILE_SYNC_IGNORES,
  FILE_SYNC_IGNORES_CHANGED,
  IgnorePatternsSchema,
} from './file-sync.dto';

const logger = createLogger('FileSyncIgnoresStore');

/** The `fileSync.ignores` setting: a JSON map of project id to Syncthing ignore patterns. */
const SETTINGS_KEY = 'fileSync.ignores';
const REVISIONS_KEY = 'fileSync.ignoreRevisions';

export { DEFAULT_FILE_SYNC_IGNORES };

@Injectable()
export class FileSyncIgnoresStore {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  /** The project's patterns, or the defaults when it has none of its own. */
  get(projectId: string): string[] {
    return this.readMap()[projectId] ?? [...DEFAULT_FILE_SYNC_IGNORES];
  }

  /** Stores the project's patterns; null returns it to the defaults. */
  set(projectId: string, ignores: string[] | null, expectedRevision?: number): string[] {
    const validated = ignores === null ? null : IgnorePatternsSchema.parse(ignores);
    return this.transactions.runImmediate(() => {
      const revisions = this.readRevisions();
      const revision = revisions[projectId] ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== revision)
        throw new AppError(
          'The file list changed. Review it again.',
          FILE_SYNC_IGNORES_CHANGED,
          409,
        );
      const map = this.readMap();
      if (validated === null) delete map[projectId];
      else map[projectId] = validated;
      revisions[projectId] = revision + 1;
      this.write(SETTINGS_KEY, map);
      this.write(REVISIONS_KEY, revisions);
      return this.get(projectId);
    });
  }

  revision(projectId: string): number {
    return this.readRevisions()[projectId] ?? 0;
  }

  private readRevisions(): Record<string, number> {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(REVISIONS_KEY) as { value: string } | undefined;
    if (!row) return {};
    return z
      .record(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
      .parse(JSON.parse(row.value));
  }

  private write(key: string, value: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), now, now);
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
