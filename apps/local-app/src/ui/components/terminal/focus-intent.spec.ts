import { createFocusIntentTracker, FOCUS_INTENT_STALE_MS } from './focus-intent';

describe('createFocusIntentTracker', () => {
  it('reports no intent before any gesture is stamped', () => {
    const tracker = createFocusIntentTracker();
    expect(tracker.hasRecentIntent(0)).toBe(false);
    expect(tracker.hasRecentIntent(1_000_000)).toBe(false);
  });

  it('reports recent intent immediately after a stamp', () => {
    const tracker = createFocusIntentTracker();
    tracker.stamp(1000);
    expect(tracker.hasRecentIntent(1000)).toBe(true);
  });

  it('treats intent as recent right up to the stale boundary and stale at/after it', () => {
    const tracker = createFocusIntentTracker();
    tracker.stamp(1000);

    expect(tracker.hasRecentIntent(1000 + FOCUS_INTENT_STALE_MS - 1)).toBe(true);
    expect(tracker.hasRecentIntent(1000 + FOCUS_INTENT_STALE_MS)).toBe(false);
    expect(tracker.hasRecentIntent(1000 + FOCUS_INTENT_STALE_MS + 500)).toBe(false);
  });

  it('a later stamp refreshes the window', () => {
    const tracker = createFocusIntentTracker();
    tracker.stamp(1000);
    // Would be stale relative to the first stamp...
    tracker.stamp(1000 + FOCUS_INTENT_STALE_MS + 100);
    // ...but the fresh stamp re-authorizes.
    expect(tracker.hasRecentIntent(1000 + FOCUS_INTENT_STALE_MS + 100)).toBe(true);
  });

  it('honors a custom staleMs window', () => {
    const tracker = createFocusIntentTracker({ staleMs: 50 });
    tracker.stamp(1000);
    expect(tracker.hasRecentIntent(1049)).toBe(true);
    expect(tracker.hasRecentIntent(1050)).toBe(false);
  });

  it('treats a stamp at t=0 as "never stamped" (sentinel), which real Date.now() never hits', () => {
    const tracker = createFocusIntentTracker();
    tracker.stamp(0);
    expect(tracker.hasRecentIntent(0)).toBe(false);
  });
});
