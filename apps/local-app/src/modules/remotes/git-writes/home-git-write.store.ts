import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';

const WRITES_KEY = 'remotes.homeGitWrites';
const HANDOVERS_KEY = 'remotes.homeGitHandovers';
const STEP_DOWNS_KEY = 'remotes.homeGitStepDowns';

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
const HandoversSchema = z.record(z.object({ id: z.string(), remoteId: z.string() }));
const StepDownsSchema = z.record(
  z.object({ remoteId: z.string(), generation: z.number(), startedAt: z.number() }),
);

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
    return Object.values(this.read(WRITES_KEY, WritesSchema));
  }

  get(writeId: string): HomeGitWrite | null {
    return this.read(WRITES_KEY, WritesSchema)[writeId] ?? null;
  }

  put(write: HomeGitWrite): void {
    this.update(WRITES_KEY, WritesSchema, (writes) => {
      writes[write.writeId] = HomeGitWriteSchema.parse(write);
    });
  }

  delete(writeId: string): void {
    this.update(WRITES_KEY, WritesSchema, (writes) => {
      delete writes[writeId];
    });
  }

  handover(projectId: string): { id: string; remoteId: string } | null {
    return this.read(HANDOVERS_KEY, HandoversSchema)[projectId] ?? null;
  }

  rememberHandover(projectId: string, remoteId: string, id: string): void {
    this.update(HANDOVERS_KEY, HandoversSchema, (handovers) => {
      handovers[projectId] = { id, remoteId };
    });
  }

  clearHandover(projectId: string, remoteId: string): void {
    this.update(HANDOVERS_KEY, HandoversSchema, (handovers) => {
      if (handovers[projectId]?.remoteId === remoteId) delete handovers[projectId];
    });
  }

  stepDownStartedAt(projectId: string, remoteId: string, generation: number): number | null {
    const saved = this.read(STEP_DOWNS_KEY, StepDownsSchema)[projectId];
    return saved?.remoteId === remoteId && saved.generation === generation ? saved.startedAt : null;
  }

  rememberStepDown(
    projectId: string,
    remoteId: string,
    generation: number,
    startedAt: number,
  ): void {
    this.update(STEP_DOWNS_KEY, StepDownsSchema, (stepDowns) => {
      stepDowns[projectId] = { remoteId, generation, startedAt };
    });
  }

  clearStepDown(projectId: string, remoteId: string): void {
    this.update(STEP_DOWNS_KEY, StepDownsSchema, (stepDowns) => {
      if (stepDowns[projectId]?.remoteId === remoteId) delete stepDowns[projectId];
    });
  }

  private read<T>(key: string, schema: z.ZodType<Record<string, T>>): Record<string, T> {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? schema.parse(JSON.parse(row.value)) : {};
  }

  private update<T>(
    key: string,
    schema: z.ZodType<Record<string, T>>,
    change: (entries: Record<string, T>) => void,
  ): void {
    this.transactions.runImmediate(() => {
      const entries = this.read(key, schema);
      change(entries);
      const at = new Date().toISOString();
      // Local coordination metadata: it must drain even while project writes are frozen.
      this.sqlite
        .prepare(
          `INSERT INTO settings (id, key, value, created_at, updated_at)
           VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, JSON.stringify(entries), at, at);
    });
  }
}
