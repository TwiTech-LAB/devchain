# Test Helpers

This directory contains utilities for E2E and integration testing.

## Test Database Utilities

The `test-db.ts` module provides utilities for managing a temporary SQLite database for tests.

### Global Setup/Teardown

Playwright automatically sets up a clean test database before running tests and tears it down after:

- **`global-setup.ts`**: Creates a temporary database, runs migrations, and seeds minimal test data
- **`global-teardown.ts`**: Cleans up the temporary database

These are configured in `playwright.config.ts` and run once per test session.

### Available Functions

#### `setupTestDb(): string`

Creates a temporary test database and runs migrations. Returns the path to the test database.

```typescript
import { setupTestDb } from './helpers/test-db';

const dbPath = setupTestDb();
```

#### `teardownTestDb(): void`

Cleans up the temporary test database directory.

```typescript
import { teardownTestDb } from './helpers/test-db';

teardownTestDb();
```

#### `getTestDbPath(): string | null`

Returns the current test database path.

```typescript
import { getTestDbPath } from './helpers/test-db';

const dbPath = getTestDbPath();
```

#### `resetTestDb(): void`

Resets the test database by deleting all data while keeping the schema intact. Useful for isolating tests.

```typescript
import { resetTestDb } from './helpers/test-db';

test.beforeEach(() => {
  resetTestDb(); // Clean slate for each test
});
```

#### `seedTestData(): TestFixtures`

Seeds the database with minimal test data and returns the IDs of created fixtures.

Returns:
```typescript
{
  projectId: string;
  statusId: string;
  agentProfileId: string;
}
```

Usage:
```typescript
import { seedTestData } from './helpers/test-db';

const { projectId, statusId, agentProfileId } = seedTestData();
// Use these IDs in your tests
```

## Usage in Tests

### Example: Using test fixtures

```typescript
import { test, expect } from '@playwright/test';
import { resetTestDb, seedTestData } from '../helpers/test-db';

test.describe('Epic Management', () => {
  test.beforeEach(() => {
    // Reset DB to ensure test isolation
    resetTestDb();

    // Seed with fresh test data
    const fixtures = seedTestData();
    // fixtures contains: { projectId, statusId, agentProfileId }
  });

  test('should create a new epic', async ({ page }) => {
    await page.goto('/epics');
    // ... test implementation
  });
});
```

### Example: Testing with isolated data

```typescript
import { test, expect } from '@playwright/test';
import { getTestDbPath } from '../helpers/test-db';
import Database from 'better-sqlite3';

test('should insert custom test data', async ({ page }) => {
  const dbPath = getTestDbPath();
  const db = new Database(dbPath);

  // Insert custom test data
  db.prepare(`
    INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('custom-project', 'Custom Project', '/tmp/custom', new Date().toISOString(), new Date().toISOString());

  db.close();

  // Test against custom data
  await page.goto('/projects');
  await expect(page.getByText('Custom Project')).toBeVisible();
});
```

## Best Practices

1. **Use `resetTestDb()` in `beforeEach`** if tests need isolation
2. **Use `seedTestData()`** for tests that need a basic project/status setup
3. **Use isolated workers** (`fullyParallel: false`) if tests share database state
4. **Avoid hardcoded IDs** - use the IDs returned by `seedTestData()`
5. **Close database connections** after direct database operations

## Environment Variables

The test database utilities automatically override the `DB_PATH` environment variable to point to the temporary test directory. This ensures the application uses the test database during E2E tests.
