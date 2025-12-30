import { test, expect } from '@playwright/test';

test.describe('Theme Toggle', () => {
  test('switches Light/Dark/Ocean and persists across reload', async ({ page }) => {
    await page.goto('/projects');

    // Ensure header is visible
    await page.getByRole('button', { name: 'Open keyboard shortcuts' }).waitFor();

    // Inline toggle is visible on desktop
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toBeVisible();

    const htmlHas = async (cls: string) =>
      await page.evaluate((c) => document.documentElement.classList.contains(c), cls);

    // Light
    await page.getByRole('button', { name: 'Light' }).click();
    expect(await htmlHas('dark')).toBeFalsy();
    expect(await htmlHas('theme-ocean')).toBeFalsy();

    // Dark
    await page.getByRole('button', { name: 'Dark' }).click();
    expect(await htmlHas('dark')).toBeTruthy();
    expect(await htmlHas('theme-ocean')).toBeFalsy();

    // Ocean
    await page.getByRole('button', { name: 'Ocean' }).click();
    expect(await htmlHas('dark')).toBeFalsy();
    expect(await htmlHas('theme-ocean')).toBeTruthy();

    // Reload preserves
    await page.reload();
    expect(await htmlHas('theme-ocean')).toBeTruthy();
  });
});

