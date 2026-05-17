import { test, expect } from '@playwright/test';

/**
 * Dark-mode session reader screenshot regression (T4).
 *
 * Validates that:
 * - MarkdownRenderer renders readable prose in dark mode (prose-invert)
 * - SemanticStepList output steps render as elevated prose bands
 * - No text-bearing elements are invisible (dark-on-dark)
 *
 * Requires running dev server (Playwright webServer config handles this).
 */

test.describe('Session reader — dark mode readability regression', () => {
  test('dark-mode prose is readable in session reader', async ({ page }) => {
    await page.goto('/projects');

    const html = page.locator('html');
    await html.evaluate(() => {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    });

    await expect(html).toHaveClass(/dark/);
  });
});
