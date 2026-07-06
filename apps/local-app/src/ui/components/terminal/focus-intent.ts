/**
 * Focus-intent stamp: a tiny primitive that records whether a real user gesture just happened,
 * so the terminal focus path can tell a genuine click/keyboard entry apart from a programmatic
 * `.focus()`. The server cannot make this distinction (both arrive as `terminal:focus`), so the
 * gate lives here on the client.
 *
 * Pattern-only kin to `scroll-history-detector.ts`'s `stampScrollIntent`/`hasRecentScrollIntent`
 * — that one is scroll-up-specific (wheel/PageUp/drag); this one keys on focus-entry gestures
 * (pointerdown/keydown). Kept as its own primitive rather than reused.
 */

/**
 * How long a user gesture (pointerdown/keydown) authorizes a subsequent focusin authority claim.
 *
 * Gesture → focusin is synchronous for both entry vectors (mouse focus moves on pointerdown;
 * keyboard focus moves on the Tab keydown), so the stamp always lands before focusin. The window
 * is kept generous enough to also cover a `.focus()` deferred a tick/RAF off the gesture — the
 * panel re-show and floating-window focus effects re-focus via `setTimeout` 0–50ms — while short
 * enough that an unrelated earlier gesture cannot authorize a much later programmatic focus.
 */
export const FOCUS_INTENT_STALE_MS = 1000;

export interface FocusIntentTracker {
  /** Record a genuine user gesture. Fed only by document-level pointerdown/keydown listeners. */
  stamp(now?: number): void;
  /** Whether a gesture was stamped within {@link FOCUS_INTENT_STALE_MS} of `now`. */
  hasRecentIntent(now?: number): boolean;
}

export function createFocusIntentTracker(options?: { staleMs?: number }): FocusIntentTracker {
  const staleMs = options?.staleMs ?? FOCUS_INTENT_STALE_MS;
  // 0 means "never stamped"; hasRecentIntent treats it as no intent.
  let lastIntentAt = 0;

  return {
    stamp(now = Date.now()) {
      lastIntentAt = now;
    },
    hasRecentIntent(now = Date.now()) {
      return lastIntentAt > 0 && now - lastIntentAt < staleMs;
    },
  };
}
