import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import { TransactionRunner } from '../storage/db/transaction-runner';
import { GitCoordinatorRecordSchema, type GitFence } from './git-coordinator/git-coordinator.dto';

const SETTINGS_KEY = 'remotes.gitOwner';
export type GitOwner = 'home' | 'vm';
const CachedOwnerSchema = GitCoordinatorRecordSchema.pick({ owner: true, generation: true });
type CachedOwner = z.infer<typeof CachedOwnerSchema>;
// A bare 'home' is the format saved before the VM record had generations.
const GitOwnersSchema = z.record(
  z.union([
    z.literal('home').transform((): CachedOwner => ({ owner: 'home', generation: 0 })),
    CachedOwnerSchema,
  ]),
);
const VM_OWNED: CachedOwner = { owner: 'vm', generation: 0 };

/**
 * This PC's persisted cache of the VM Git record's owner and generation. The VM record is the
 * authority; VM Git-folder calls carry `fence()` so the VM refuses a cache it has moved past.
 */
@Injectable()
export class GitOwnerStore {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;
  private readonly revisions = new Map<string, number>();

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  get(projectId: string): GitOwner {
    return this.cached(projectId).owner;
  }

  /** The VM record generation this cache was last taken from. */
  generation(projectId: string): number {
    return this.cached(projectId).generation;
  }

  fence(projectId: string): GitFence {
    return { expectedGeneration: this.generation(projectId), transitionId: null };
  }

  /** Changes whenever the cached owner or generation changes, including in-memory only. */
  revision(projectId: string): number {
    return this.revisions.get(projectId) ?? 0;
  }

  /** Keeps the generation: for a switch that does not go through the VM record. */
  set(projectId: string, owner: GitOwner): void {
    this.write(projectId, (current) => ({ owner, generation: current.generation }));
  }

  /** Caches the owner and generation of a VM record this PC has accepted. */
  remember(projectId: string, record: CachedOwner): void {
    this.write(projectId, () => ({ owner: record.owner, generation: record.generation }));
  }

  clear(projectId: string): void {
    this.write(projectId, () => VM_OWNED);
  }

  private cached(projectId: string): CachedOwner {
    return this.readMap()[projectId] ?? VM_OWNED;
  }

  private write(projectId: string, next: (current: CachedOwner) => CachedOwner): void {
    let changed = false;
    this.transactions.runImmediate(() => {
      const map = this.readMap();
      const current = map[projectId] ?? VM_OWNED;
      const value = next(current);
      changed = value.owner !== current.owner || value.generation !== current.generation;
      if (value.owner === 'vm' && value.generation === 0) delete map[projectId];
      else map[projectId] = value;
      const now = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO settings (id, key, value, created_at, updated_at)
           VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(SETTINGS_KEY, JSON.stringify(map), now, now);
    });
    if (changed) this.revisions.set(projectId, this.revision(projectId) + 1);
  }

  private readMap(): Record<string, CachedOwner> {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    return row ? GitOwnersSchema.parse(JSON.parse(row.value)) : {};
  }
}
