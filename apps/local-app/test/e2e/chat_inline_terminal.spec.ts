import { test } from '@playwright/test';

/**
 * Inline terminal smoke tests placeholder.
 *
 * Full automation requires seeded chat threads, running agent sessions, and terminal streaming
 * fixtures which are not yet available in the Playwright environment. These tests are marked as
 * skipped so that the suite documents desired coverage without failing CI.
 */

const skipReason =
  'Inline terminal smoke scenarios require live session orchestration and seeded data.';

test.describe.skip('Chat inline terminal smoke', () => {
  test('opens context menu and toggles inline terminal', async () => {
    test.skip(skipReason);
  });

  test('launches inline terminal from DM CTA', async () => {
    test.skip(skipReason);
  });

  test('launches selected agents from group CTA', async () => {
    test.skip(skipReason);
  });

  test('preserves composer state while toggling inline terminal', async () => {
    test.skip(skipReason);
  });

  test('respects theme tokens inside inline terminal', async () => {
    test.skip(skipReason);
  });

  test('handles session crash and relaunch prompt', async () => {
    test.skip(skipReason);
  });
});

