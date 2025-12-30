import { test, expect } from '@playwright/test';

/**
 * Smoke test to verify Playwright setup and basic app functionality
 */

test.describe('Local App - Smoke Tests', () => {
  test('should load the home page', async ({ page }) => {
    // Navigate to the base URL
    await page.goto('/');

    // Wait for the page to be loaded
    await page.waitForLoadState('domcontentloaded');

    // Verify the page loaded successfully
    // This is a minimal smoke test - just checking we get a valid response
    expect(page.url()).toContain('127.0.0.1:5175');
  });

  test('should have working API health endpoint', async ({ page }) => {
    // Access the API health endpoint through the UI's proxy
    const response = await page.request.get('/api/health');

    // Verify API is responding
    expect(response.ok()).toBeTruthy();

    // Verify response structure
    const body = await response.json();
    expect(body).toHaveProperty('status', 'ok');
    expect(body).toHaveProperty('timestamp');
  });

  // Note: Terminal engine selector removed (Chat Mode is now the only option)
});
