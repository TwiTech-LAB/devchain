import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import { GitCoordinatorRecordSchema } from './git-coordinator.dto';
import type { GitCoordinatorRecord } from './git-coordinator.dto';

const PREFIX = 'remotes.gitCoordinator:';

@Injectable()
export class GitCoordinatorStore {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  projects(): string[] {
    return (
      this.sqlite.prepare('SELECT key FROM settings WHERE key LIKE ?').all(`${PREFIX}%`) as {
        key: string;
      }[]
    ).map(({ key }) => key.slice(PREFIX.length));
  }

  read(projectId: string): GitCoordinatorRecord {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(PREFIX + projectId) as { value: string } | undefined;
    // Invalid persisted state must close admission, never reset ownership to VM.
    return row
      ? GitCoordinatorRecordSchema.parse(JSON.parse(row.value))
      : {
          owner: 'vm',
          generation: 0,
          homeName: null,
          homeWrites: {},
          checkpoint: null,
          vmHolds: {},
          transition: null,
        };
  }

  delete(projectId: string): void {
    this.sqlite.prepare('DELETE FROM settings WHERE key = ?').run(PREFIX + projectId);
  }

  write(projectId: string, record: GitCoordinatorRecord): void {
    const value = JSON.stringify(GitCoordinatorRecordSchema.parse(record));
    this.transactions.runImmediate(() => {
      const at = new Date().toISOString();
      // This is local coordination metadata: it must drain even while project writes are frozen.
      this.sqlite
        .prepare(
          `INSERT INTO settings (id, key, value, created_at, updated_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(PREFIX + projectId, value, at, at);
    });
  }
}
