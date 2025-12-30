import { teardownTestDb } from './helpers/test-db';

/**
 * Playwright global teardown
 * Cleans up the temporary test database
 */
async function globalTeardown() {
  console.log('🧹 Cleaning up test database...');
  teardownTestDb();
  console.log('✅ Test database cleaned up');
}

export default globalTeardown;
