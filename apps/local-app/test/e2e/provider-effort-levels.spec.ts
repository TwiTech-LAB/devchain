import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resetTestDb, getTestDbPath } from '../helpers/test-db';

const nowIso = () => new Date().toISOString();

const PROVIDER_ID = 'provider-effort-smoke-01';

// Smoke test for the Providers-page "Effort Levels" management section (Task 6).
// Mirrors the seeding pattern in provider-env-scope.spec.ts: a DB row is sufficient —
// no real CLI binary is required and no session is launched. The effort capability
// signal (`supportsEffort`) is derived from the claude adapter at
// GET /api/providers/:id/efforts, so seeding a claude provider is enough to surface
// the section. (See "Execution constraint" in the task comment re: running this spec.)
test.describe('Provider effort levels UI', () => {
  test.beforeEach(() => {
    resetTestDb();

    const dbPath = getTestDbPath();
    if (!dbPath) throw new Error('Test database not initialized');

    const db = new Database(dbPath);
    const now = nowIso();

    // Seed a claude provider — claude is effort-capable, so supportsEffort resolves
    // true and the Effort Levels section renders (even with an empty catalog).
    db.prepare(
      `INSERT INTO providers (id, name, bin_path, mcp_configured, env, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(PROVIDER_ID, 'claude', null, 0, JSON.stringify({}), now, now);

    db.close();
  });

  test('add an effort value, see it listed, delete it', async ({ page }) => {
    await page.goto('/providers');
    await page.waitForLoadState('domcontentloaded');

    // Expand the Effort Levels section (renders only after supportsEffort resolves).
    await page
      .getByRole('button', { name: /Effort Levels \(/i })
      .first()
      .click();

    const effortValue = 'high-smoke';

    // Add via the free-text input + button (provider-native free text; no vocabulary lock).
    await page.getByLabel('Add Effort Level').fill(effortValue);
    await page.getByRole('button', { name: 'Add Effort Level', exact: true }).click();

    // Assert it is listed: the per-row delete affordance (aria-label) proves presence.
    const deleteAffordance = page.getByRole('button', {
      name: `Delete effort level ${effortValue}`,
    });
    await expect(deleteAffordance).toBeVisible();

    // Delete via the themed confirm dialog (not window.confirm).
    await deleteAffordance.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Delete Effort Level')).toBeVisible();
    // Scope to the dialog so the provider-card "Delete" button is never matched.
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog).toBeHidden();

    // Assert it is gone.
    await expect(deleteAffordance).toBeHidden();
  });
});
