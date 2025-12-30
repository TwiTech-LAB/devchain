import { setupTestDb, seedTestData } from './helpers/test-db';

/**
 * Playwright global setup
 * Creates a temporary test database, runs migrations, and seeds minimal data
 */
async function globalSetup() {
  console.log('🔧 Setting up test database...');

  // Create test database and run migrations
  const dbPath = setupTestDb();
  console.log(`✅ Test database created at: ${dbPath}`);

  // Seed minimal test data
  const fixtures = seedTestData();
  console.log('✅ Test data seeded:', fixtures);

  console.log('✅ Global setup complete');
}

export default globalSetup;
