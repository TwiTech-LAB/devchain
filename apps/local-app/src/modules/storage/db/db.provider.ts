import { Provider } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getDbConfig } from './db.config';
import { createLogger } from '../../../common/logging/logger';
import { join } from 'path';
import { existsSync } from 'fs';

const logger = createLogger('DbProvider');

export const DB_CONNECTION = 'DB_CONNECTION';

export const dbProvider: Provider = {
  provide: DB_CONNECTION,
  useFactory: (): BetterSQLite3Database => {
    const config = getDbConfig();

    logger.info({ dbPath: config.dbPath }, 'Initializing SQLite database');

    const sqlite = new Database(config.dbPath);

    // Enable WAL mode for better concurrency
    sqlite.pragma('journal_mode = WAL');

    // Set busy timeout
    sqlite.pragma(`busy_timeout = ${config.busyTimeout}`);

    // Enable foreign keys
    sqlite.pragma('foreign_keys = ON');

    logger.info(
      {
        dbPath: config.dbPath,
        journalMode: sqlite.pragma('journal_mode', { simple: true }),
        foreignKeys: sqlite.pragma('foreign_keys', { simple: true }),
      },
      'SQLite database initialized',
    );

    const db = drizzle(sqlite);

    // Run migrations automatically
    try {
      // Try multiple possible migration paths (for different deployment scenarios)
      const possibleMigrationPaths = [
        join(__dirname, '../../../../drizzle'), // From built src/modules/storage/db
        join(__dirname, '../../../drizzle'), // From dist/modules/storage/db
        join(process.cwd(), 'apps/local-app/drizzle'), // From monorepo root
        join(process.cwd(), 'drizzle'), // From package root
      ];

      let migrationsFolder: string | undefined;
      for (const path of possibleMigrationPaths) {
        if (existsSync(path)) {
          migrationsFolder = path;
          break;
        }
      }

      if (migrationsFolder) {
        logger.info({ migrationsFolder }, 'Running database migrations');
        migrate(db, { migrationsFolder });
        logger.info('Database migrations completed successfully');
      } else {
        logger.warn('Migrations folder not found, skipping auto-migration');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to run migrations');
      throw error;
    }

    return db;
  },
};
