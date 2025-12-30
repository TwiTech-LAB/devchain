import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import { resetTestDb, getTestDbPath } from '../helpers/test-db';

const nowIso = () => new Date().toISOString();

test.describe('Global project selection', () => {
  test.beforeEach(() => {
    resetTestDb();

    const dbPath = getTestDbPath();
    if (!dbPath) {
      throw new Error('Test database not initialized');
    }

    const db = new Database(dbPath);
    const now = nowIso();

    const insertProject = db.prepare(
      `INSERT INTO projects (id, name, description, root_path, is_private, owner_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insertProject.run(
      'project-alpha',
      'Alpha Project',
      'Alpha seed project',
      '/tmp/alpha',
      0,
      null,
      now,
      now,
    );

    insertProject.run(
      'project-beta',
      'Beta Project',
      'Beta seed project',
      '/tmp/beta',
      0,
      null,
      now,
      now,
    );

    const insertStatus = db.prepare(
      `INSERT INTO statuses (id, project_id, label, color, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    insertStatus.run('status-alpha', 'project-alpha', 'Alpha Ready', '#2563eb', 0, now, now);
    insertStatus.run('status-beta', 'project-beta', 'Beta Ready', '#db2777', 0, now, now);

    db.close();
  });

  test('persists selection across pages', async ({ page }) => {
    await page.goto('/projects');
    await page.waitForLoadState('domcontentloaded');

    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

    await page.getByRole('combobox', { name: 'Select a project' }).click();
    await page.getByRole('option', { name: 'Beta Project' }).click();

    await expect(page.getByRole('combobox', { name: 'Selected project' })).toHaveText('Beta Project');

    await page.goto('/statuses');
    await expect(page.getByText('Manage statuses for Beta Project')).toBeVisible();
    await expect(page.locator('text=Beta Ready')).toHaveCount(1);
    await expect(page.locator('text=Alpha Ready')).toHaveCount(0);

    await page.goto('/agents');
    await expect(page.getByText('Manage agents for Beta Project')).toBeVisible();

    await page.goto('/board');
    await expect(page.getByText('Organize epics for Beta Project')).toBeVisible();
    await expect(page.locator('text=Beta Ready')).toHaveCount(1);

    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Selected project' })).toHaveText('Beta Project');

    const storedSelection = await page.evaluate(() =>
      localStorage.getItem('devchain:selectedProjectId'),
    );
    expect(storedSelection).toBe('project-beta');
  });
});
