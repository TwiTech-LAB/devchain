import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getRawSqliteClient } from '../../db/sqlite-raw';

export interface StorageDelegateContext {
  db: BetterSQLite3Database;
  rawClient: Database.Database;
}

export function createStorageDelegateContext(db: BetterSQLite3Database): StorageDelegateContext {
  return {
    db,
    rawClient: getRawSqliteClient(db),
  };
}

export abstract class BaseStorageDelegate {
  protected readonly db: BetterSQLite3Database;
  protected readonly rawClient: Database.Database;

  protected constructor(context: StorageDelegateContext) {
    this.db = context.db;
    this.rawClient = context.rawClient;
  }
}
