import { test, expect, type Page } from '@playwright/test';

/**
 * Terminal theme E2E smoke tests.
 *
 * Validates that the xterm terminal follows the app dark/ocean theme and that
 * live theme switching preserves buffer content. Requires at least one running
 * agent session visible in the terminal dock.
 */

async function applyTheme(page: Page, theme: 'dark' | 'ocean') {
  await page.evaluate((t: string) => {
    const root = document.documentElement;
    root.classList.remove('dark', 'theme-ocean');
    root.classList.add(t === 'ocean' ? 'theme-ocean' : 'dark');
    localStorage.setItem('devchain:theme', t);
  }, theme);
  await page.waitForTimeout(500);
}

async function openTerminalSession(page: Page): Promise<boolean> {
  // Expand terminal dock
  const dockToggle = page.locator('button').filter({ hasText: /sessions/ }).first();
  if ((await dockToggle.count()) === 0) return false;
  await dockToggle.click();
  await page.waitForTimeout(1000);

  // Find and click a session to open a floating terminal
  const sessionBtns = page.locator('section').last().locator('button').filter({ hasNotText: /sessions|Refresh/ });
  if ((await sessionBtns.count()) === 0) return false;
  await sessionBtns.first().click();
  await page.waitForTimeout(3000);

  return (await page.locator('.xterm-viewport').count()) > 0;
}

test.describe('Terminal Theme', () => {
  test('ocean terminal background is light, not hardcoded dark', async ({ page }) => {
    await page.goto('/board');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    await applyTheme(page, 'ocean');

    const hasTerminal = await openTerminalSession(page);
    if (!hasTerminal) {
      test.skip('No active terminal session available');
      return;
    }

    const viewportBg = await page.locator('.xterm-viewport').first().evaluate(
      (el) => window.getComputedStyle(el).backgroundColor,
    );

    // Must NOT be the old hardcoded dark (#1a1a1a = rgb(26, 26, 26))
    expect(viewportBg).not.toBe('rgb(26, 26, 26)');

    // Must be light (luminance > 0.7)
    const match = viewportBg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    expect(match).toBeTruthy();
    if (match) {
      const luminance =
        (parseInt(match[1]) * 0.299 + parseInt(match[2]) * 0.587 + parseInt(match[3]) * 0.114) /
        255;
      expect(luminance).toBeGreaterThan(0.7);
    }
  });

  test('theme switch preserves visible buffer text', async ({ page }) => {
    await page.goto('/board');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    await applyTheme(page, 'dark');

    const hasTerminal = await openTerminalSession(page);
    if (!hasTerminal) {
      test.skip('No active terminal session available');
      return;
    }

    // Capture dark-mode state
    const darkBg = await page.locator('.xterm-viewport').first().evaluate(
      (el) => window.getComputedStyle(el).backgroundColor,
    );
    const textBefore = await page.locator('.xterm-rows').first().textContent();
    expect(textBefore).toBeTruthy();
    const lengthBefore = textBefore!.length;

    // Switch to ocean
    await applyTheme(page, 'ocean');

    const oceanBg = await page.locator('.xterm-viewport').first().evaluate(
      (el) => window.getComputedStyle(el).backgroundColor,
    );

    // Background must have changed
    expect(oceanBg).not.toEqual(darkBg);

    // Buffer must not be wiped — length should be at least as long as before
    // (agent may write new output during the switch, but content must not be lost)
    const textAfter = await page.locator('.xterm-rows').first().textContent();
    expect(textAfter).toBeTruthy();
    expect(textAfter!.length).toBeGreaterThanOrEqual(lengthBefore);

    // Round-trip back to dark
    await applyTheme(page, 'dark');

    const revertedBg = await page.locator('.xterm-viewport').first().evaluate(
      (el) => window.getComputedStyle(el).backgroundColor,
    );
    expect(revertedBg).toEqual(darkBg);

    // Buffer still present after round-trip
    const textFinal = await page.locator('.xterm-rows').first().textContent();
    expect(textFinal).toBeTruthy();
    expect(textFinal!.length).toBeGreaterThanOrEqual(lengthBefore);
  });

  test('no hardcoded dark loading overlay in ocean mode', async ({ page }) => {
    await page.goto('/board');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    await applyTheme(page, 'ocean');

    // In ocean mode, no element should have the old hardcoded #1a1a1a background
    const darkOverlays = await page.locator('[style*="background-color: rgb(26, 26, 26)"]').count();
    expect(darkOverlays).toBe(0);
  });
});
