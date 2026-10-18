import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import { SharedVmSavedRosterSchema } from '../dtos/shared-vm.dto';
import type { SharedVmSavedRoster } from '../dtos/shared-vm.dto';

const KEY = 'remotes.sharedVmRosters';
const RostersSchema = z.record(SharedVmSavedRosterSchema);

/**
 * The last roster per remote. This store is the only writer of its key, so it
 * keeps the parsed map in memory; the health poll and every proxied request read it.
 */
@Injectable()
export class RemoteSharedVmStore {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;
  private cached: Record<string, SharedVmSavedRoster> | null = null;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  read(remoteId: string): SharedVmSavedRoster | null {
    this.cached ??= this.rosters();
    return this.cached[remoteId] ?? null;
  }

  /** Skips the write when only `at` would change. */
  async write(remoteId: string, roster: SharedVmSavedRoster): Promise<void> {
    this.cached = await this.transactions.runImmediateQueued(() => {
      const rosters = this.rosters();
      const previous = rosters[remoteId];
      if (previous && sameRoster(previous, roster)) return rosters;
      rosters[remoteId] = SharedVmSavedRosterSchema.parse(roster);
      const now = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO settings (id,key,value,created_at,updated_at)
        VALUES(lower(hex(randomblob(16))),?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
        )
        .run(KEY, JSON.stringify(rosters), now, now);
      return rosters;
    });
  }

  private rosters(): Record<string, SharedVmSavedRoster> {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key=?').get(KEY) as
      | { value: string }
      | undefined;
    if (!row) return {};
    try {
      return RostersSchema.parse(JSON.parse(row.value));
    } catch {
      return {};
    }
  }
}

function sameRoster(a: SharedVmSavedRoster, b: SharedVmSavedRoster): boolean {
  return (
    a.ownUser === b.ownUser &&
    a.vmIdentity === b.vmIdentity &&
    JSON.stringify(a.roster) === JSON.stringify(b.roster)
  );
}
