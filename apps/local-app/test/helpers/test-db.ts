import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as schema from '../../src/modules/storage/db/schema';

let testDbPath: string | null = null;
let testDbDir: string | null = null;

/**
 * Create a temporary test database and run migrations
 */
export function setupTestDb(): string {
  // Create a temp directory for the test database
  testDbDir = mkdtempSync(join(tmpdir(), 'devchain-test-'));
  testDbPath = join(testDbDir, 'test.db');

  // Override the DB_PATH and DB_FILENAME environment variables for tests
  process.env.DB_PATH = testDbDir;
  process.env.DB_FILENAME = 'test.db';

  // Create the database and run migrations
  const sqlite = new Database(testDbPath);
  const db = drizzle(sqlite);

  // Disable foreign key enforcement during migration to avoid order dependency issues
  sqlite.pragma('foreign_keys = OFF');

  // Run migrations
  migrate(db, { migrationsFolder: './drizzle' });

  sqlite.pragma('foreign_keys = ON');

  sqlite.close();

  return testDbPath;
}

/**
 * Clean up the test database
 */
export function teardownTestDb(): void {
  if (testDbDir) {
    try {
      rmSync(testDbDir, { recursive: true, force: true });
      testDbDir = null;
      testDbPath = null;
      delete process.env.DB_PATH;
      delete process.env.DB_FILENAME;
    } catch (error) {
      console.error('Failed to clean up test database:', error);
    }
  }
}

/**
 * Get the current test database path
 */
export function getTestDbPath(): string | null {
  return testDbPath;
}

/**
 * Reset the test database by deleting all data but keeping the schema
 */
export function resetTestDb(): void {
  if (!testDbPath) {
    throw new Error('Test database not initialized. Call setupTestDb() first.');
  }

  const sqlite = new Database(testDbPath);

  try {
    // Get all table names
    const tables = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
      )
      .all() as Array<{ name: string }>;

    // Delete all data from each table (in reverse order to handle foreign keys)
    sqlite.prepare('PRAGMA foreign_keys = OFF').run();

    for (const { name } of tables) {
      sqlite.prepare(`DELETE FROM ${name}`).run();
    }

    sqlite.prepare('PRAGMA foreign_keys = ON').run();
  } finally {
    sqlite.close();
  }
}

/**
 * Seed minimal test data
 * Useful for tests that need a basic project/status setup
 */
export interface TestFixtures {
  projectId: string;
  statusId: string;
  agentProfileId: string;
  providerId: string;
}

export function seedTestData(): TestFixtures {
  if (!testDbPath) {
    throw new Error('Test database not initialized. Call setupTestDb() first.');
  }

  const sqlite = new Database(testDbPath);
  const db = drizzle(sqlite, { schema });

  try {
    const now = new Date().toISOString();

    // Create a test project
    const projectId = '11111111-1111-4111-8111-111111111111';
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, description, root_path, is_private, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(projectId, 'Test Project', 'A test project', '/tmp/test', 0, now, now);

    // Create a default status
    const statusId = '22222222-2222-4222-8222-222222222222';
    sqlite
      .prepare(
        `INSERT INTO statuses (id, project_id, label, color, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(statusId, projectId, 'To Do', '#3b82f6', 0, now, now);

    // Create a test agent profile
    const providerId = '33333333-3333-4333-8333-333333333333';
    const agentProfileId = '44444444-4444-4444-8444-444444444444';
    sqlite
      .prepare(
        `INSERT INTO providers (id, name, bin_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING`,
      )
      .run(providerId, 'claude', null, now, now);

    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, name, provider_id, options, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agentProfileId, 'Test Agent', providerId, '--model claude-3-5-sonnet', now, now);

    return { projectId, statusId, agentProfileId, providerId };
  } finally {
    sqlite.close();
  }
}
