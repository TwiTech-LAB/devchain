import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resetTestDb, getTestDbPath, setupTestDb, teardownTestDb } from '../helpers/test-db';

const nowIso = () => new Date().toISOString();

// DocsFreeze: Documents UI is intentionally hidden; ensure the disabled splash renders instead of the full experience.
test.describe('Documents route (disabled)', () => {
  test.beforeAll(() => {
    setupTestDb();
  });

  test.afterAll(() => {
    teardownTestDb();
  });

  test.beforeEach(() => {
    resetTestDb();

    const dbPath = getTestDbPath();
    if (!dbPath) {
      throw new Error('Test database not initialized');
    }

    const db = new Database(dbPath);
    const now = nowIso();

    db.prepare(
      `INSERT INTO projects (id, name, description, root_path, is_private, owner_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('project-docs', 'Documents Project', 'Docs project', '/tmp/docs', 0, null, now, now);

    db.close();
  });

  test('shows a disabled notice and hides the Documents nav link', async ({ page }) => {
    await page.goto('/documents');
    await page.waitForLoadState('domcontentloaded');

    await expect(
      page.getByRole('heading', { name: 'Documents is currently disabled' }),
    ).toBeVisible();
    await expect(
      page.getByText(/temporarily hidden while we prepare the release/i, { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to Projects' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go Back' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Documents' })).toHaveCount(0);
  });
});
