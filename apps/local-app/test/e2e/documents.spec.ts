import { test, expect } from '@playwright/test';

// Documents was retired; /documents must fall through to the shared not-found surface.
test.describe('Documents route (retired)', () => {
  test('renders the not-found page and keeps the Documents nav link absent', async ({
    page,
  }) => {
    await page.goto('/documents');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByRole('heading', { name: 'Page Not Found' })).toBeVisible();
    await expect(page.getByText(/doesn't exist or has been moved/i)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Documents' })).toHaveCount(0);
  });
});
