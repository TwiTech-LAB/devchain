import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import { TransactionRunner } from '../storage/db/transaction-runner';
import {
  FILE_SYNC_AUTO_FIX_ACTIONS_MAX,
  FileSyncAutoFixSchema,
  FileSyncAutoFixActionSchema,
  type FileSyncAutoFix,
  type FileSyncAutoFixAction,
} from './file-sync-auto-fix.dto';

const SETTINGS_KEY = 'fileSync.autoFix';
/** A project without a stored value: the switch is on and nothing was done yet. */
const defaults = (): FileSyncAutoFix => ({ enabled: true, actions: [] });

@Injectable()
export class FileSyncAutoFixStore {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  get(projectId: string): FileSyncAutoFix {
    return this.readMap()[projectId] ?? defaults();
  }

  setEnabled(projectId: string, enabled: boolean): FileSyncAutoFix {
    return this.update(projectId, (value) => ({ ...value, enabled }));
  }

  record(projectId: string, action: FileSyncAutoFixAction): FileSyncAutoFix {
    const parsed = FileSyncAutoFixActionSchema.parse(action);
    return this.update(projectId, (value) => ({
      ...value,
      actions: [...value.actions, parsed].slice(-FILE_SYNC_AUTO_FIX_ACTIONS_MAX),
    }));
  }

  private update(
    projectId: string,
    change: (value: FileSyncAutoFix) => FileSyncAutoFix,
  ): FileSyncAutoFix {
    return this.transactions.runImmediate(() => {
      const map = this.readMap();
      const value = change(map[projectId] ?? defaults());
      map[projectId] = value;
      const now = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(SETTINGS_KEY, JSON.stringify(map), now, now);
      return value;
    });
  }

  private readMap(): Record<string, FileSyncAutoFix> {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return {};
    return z.record(FileSyncAutoFixSchema).parse(JSON.parse(row.value));
  }
}
