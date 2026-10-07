import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';

// Jest's module registry scopes this snapshot to one spec file.
let snapshot: Buffer | undefined;

export function createTestDatabase(): {
  sqlite: Database.Database;
  db: BetterSQLite3Database;
} {
  if (!snapshot) {
    const template = new Database(':memory:');
    try {
      template.pragma('foreign_keys = OFF');
      migrate(drizzle(template), { migrationsFolder: join(__dirname, '../../..', 'drizzle') });
      snapshot = template.serialize();
    } finally {
      template.close();
    }
  }

  const sqlite = new Database(snapshot);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return { sqlite, db: drizzle(sqlite) };
}
