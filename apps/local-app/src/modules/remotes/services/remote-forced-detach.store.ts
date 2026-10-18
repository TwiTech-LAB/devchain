import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { IOError } from '../../../common/errors/error-types';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';

const SETTINGS_KEY = 'remotes.forcedDetachTombstones';
const TombstonesSchema = z.array(
  z.object({ remoteId: z.string().uuid(), projectId: z.string().min(1) }),
);
export type ForcedDetachTombstone = z.infer<typeof TombstonesSchema>[number];

/** Instance-local reconciliation work; never exported with a project replica. */
@Injectable()
export class RemoteForcedDetachStore {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  pending(remoteId?: string): ForcedDetachTombstone[] {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return [];
    let tombstones: ForcedDetachTombstone[];
    try {
      tombstones = TombstonesSchema.parse(JSON.parse(row.value));
    } catch {
      throw new IOError('The forced Disconnect reconciliation settings are invalid.');
    }
    return remoteId ? tombstones.filter((entry) => entry.remoteId === remoteId) : tombstones;
  }

  async record(remoteId: string, projectId: string): Promise<void> {
    await this.transactions.runImmediateQueued(() => {
      const pending = this.pending();
      if (!pending.some((entry) => entry.remoteId === remoteId && entry.projectId === projectId))
        this.write([...pending, { remoteId, projectId }]);
    });
  }

  async remove(remoteId: string, projectId: string): Promise<void> {
    await this.transactions.runImmediateQueued(() => {
      this.write(
        this.pending().filter(
          (entry) => entry.remoteId !== remoteId || entry.projectId !== projectId,
        ),
      );
    });
  }

  private write(tombstones: ForcedDetachTombstone[]): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(TombstonesSchema.parse(tombstones)), now, now);
  }
}
