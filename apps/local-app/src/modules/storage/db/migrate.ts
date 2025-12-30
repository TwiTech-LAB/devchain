import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { getDbConfig } from './db.config';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('Migrate');

export async function runMigrations(): Promise<void> {
  const config = getDbConfig();

  logger.info({ dbPath: config.dbPath }, 'Running database migrations');

  const sqlite = new Database(config.dbPath);
  const db = drizzle(sqlite);

  // Use absolute path to migrations folder
  // This file is at: src/modules/storage/db/migrate.ts
  // Migrations are at: drizzle/
  const migrationsFolder = join(__dirname, '../../../../drizzle');

  try {
    migrate(db, { migrationsFolder });
    logger.info('Database migrations completed successfully');
  } catch (error) {
    logger.error({ error }, 'Database migration failed');
    throw error;
  } finally {
    sqlite.close();
  }
}
