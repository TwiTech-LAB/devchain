import type { Provider } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from './db.provider';
import { getRawSqliteClient } from './sqlite-raw';

/** File name of the open main database; `:memory:` or empty for an in-memory database. */
export const DB_FILE_PATH = Symbol('DB_FILE_PATH');

export const dbFilePathProvider: Provider = {
  provide: DB_FILE_PATH,
  inject: [DB_CONNECTION],
  useFactory: (db: BetterSQLite3Database): string => getRawSqliteClient(db).name,
};
