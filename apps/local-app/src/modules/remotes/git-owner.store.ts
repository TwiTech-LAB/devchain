import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import { TransactionRunner } from '../storage/db/transaction-runner';

const SETTINGS_KEY = 'remotes.gitOwner';
const GitOwnersSchema = z.record(z.literal('home'));
export type GitOwner = 'home' | 'vm';

@Injectable()
export class GitOwnerStore {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;
  private readonly generations = new Map<string, number>();

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  get(projectId: string): GitOwner {
    return this.readMap()[projectId] ?? 'vm';
  }

  /** Changes on every owner write, so a reader can tell that Git control moved since it looked. */
  generation(projectId: string): number {
    return this.generations.get(projectId) ?? 0;
  }

  set(projectId: string, owner: GitOwner): void {
    this.transactions.runImmediate(() => {
      const map = this.readMap();
      if (owner === 'home') map[projectId] = owner;
      else delete map[projectId];
      const now = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO settings (id, key, value, created_at, updated_at)
           VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(SETTINGS_KEY, JSON.stringify(map), now, now);
    });
    this.generations.set(projectId, this.generation(projectId) + 1);
  }

  clear(projectId: string): void {
    this.set(projectId, 'vm');
  }

  private readMap(): Record<string, 'home'> {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    return row ? GitOwnersSchema.parse(JSON.parse(row.value)) : {};
  }
}
