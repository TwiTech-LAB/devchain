import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';

/**
 * Encapsulated helper to obtain the underlying better-sqlite3 client
 * from a Drizzle BetterSQLite3Database. Use sparingly when Drizzle is
 * insufficient; prefer Drizzle queries otherwise.
 */
export function getRawSqliteClient(db: BetterSQLite3Database): Database.Database {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  return anyDb.session?.client ?? (db as unknown as Database.Database);
}
