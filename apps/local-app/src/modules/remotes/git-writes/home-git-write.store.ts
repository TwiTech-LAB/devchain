import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';

const WRITES_KEY = 'remotes.homeGitWrites';

export const HomeGitWriteSchema = z.object({
  writeId: z.string(),
  projectId: z.string(),
  remoteId: z.string(),
  /** The real git child; the write stays in flight until this process is proven gone. */
  pid: z.number().int().positive(),
  processStartTime: z.string(),
  generation: z.number().int().nonnegative(),
  createdAt: z.number(),
});
export type HomeGitWrite = z.infer<typeof HomeGitWriteSchema>;
const WritesSchema = z.record(HomeGitWriteSchema);

/** Home writes that the VM has not confirmed yet; they survive a restart. */
@Injectable()
export class HomeGitWriteStore {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  list(): HomeGitWrite[] {
    return Object.values(this.readWrites());
  }

  get(writeId: string): HomeGitWrite | null {
    return this.readWrites()[writeId] ?? null;
  }

  put(write: HomeGitWrite): void {
    this.update((writes) => {
      writes[write.writeId] = HomeGitWriteSchema.parse(write);
    });
  }

  delete(writeId: string): void {
    this.update((writes) => {
      delete writes[writeId];
    });
  }

  private readWrites(): Record<string, HomeGitWrite> {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(WRITES_KEY) as
      | { value: string }
      | undefined;
    return row ? WritesSchema.parse(JSON.parse(row.value)) : {};
  }

  private update(change: (writes: Record<string, HomeGitWrite>) => void): void {
    this.transactions.runImmediate(() => {
      const writes = this.readWrites();
      change(writes);
      const at = new Date().toISOString();
      // Local coordination metadata: it must drain even while project writes are frozen.
      this.sqlite
        .prepare(
          `INSERT INTO settings (id, key, value, created_at, updated_at)
           VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(WRITES_KEY, JSON.stringify(writes), at, at);
    });
  }
}
