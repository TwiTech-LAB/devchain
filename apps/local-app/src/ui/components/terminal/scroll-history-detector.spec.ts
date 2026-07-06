import {
  createScrollHistoryDetector,
  HISTORY_REQUEST_COOLDOWN_MS,
  SCROLL_GESTURE_STALE_MS,
  type ScrollDetectorInput,
} from './scroll-history-detector';

/**
 * Test layer: pure unit (cheapest). The detector is the extracted seam that owns every
 * scroll-up→history policy decision; testing it directly with synthetic viewport moves proves
 * the visibility guard, cooldown, in-flight gating, and re-show reset without standing up xterm,
 * jsdom layout, or a socket. It makes NO claim about real-browser event ordering — it proves the
 * policy the hooks feed it.
 */
describe('createScrollHistoryDetector', () => {
  const base = (over: Partial<ScrollDetectorInput> = {}): ScrollDetectorInput => ({
    viewportY: 100,
    baseY: 100,
    visible: true,
    hasHistory: true,
    inFlight: false,
    now: 10_000,
    ...over,
  });

  describe('visible scroll-up trigger', () => {
    it('requests history when leaving the bottom with history available and a recent gesture', () => {
      const d = createScrollHistoryDetector();
      // Seed at-bottom state.
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100 }));
      // A genuine user scroll gesture authorizes the request.
      d.stampScrollIntent(10_000);
      // Scroll up: viewportY < baseY.
      const decision = d.shouldRequestHistory(base({ viewportY: 40, baseY: 100 }));

      expect(decision.shouldRequest).toBe(true);
      expect(decision.isLeavingBottom).toBe(true);
      expect(decision.offsetFromBottom).toBe(60);
      expect(decision.suppressed).toBe(false);
      expect(decision.gestureRecent).toBe(true);
    });

    it('does not request on a programmatic leaving-bottom with no user gesture', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100 }));
      // No stampScrollIntent — emulates a resize reflow / stale-scrollTop sync moving the
      // viewport without any user input.
      const decision = d.shouldRequestHistory(base({ viewportY: 40, baseY: 100 }));
      expect(decision.shouldRequest).toBe(false);
      expect(decision.isLeavingBottom).toBe(true);
      expect(decision.gestureRecent).toBe(false);
    });

    it('does not request when history is unavailable', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100 }));
      d.stampScrollIntent(10_000);
      const decision = d.shouldRequestHistory(
        base({ viewportY: 40, baseY: 100, hasHistory: false }),
      );
      expect(decision.shouldRequest).toBe(false);
    });

    it('does not request a second time within the same scroll cycle', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100 }));
      d.stampScrollIntent(10_000);
      expect(d.shouldRequestHistory(base({ viewportY: 40, baseY: 100 })).shouldRequest).toBe(true);
      // Further scroll-up in the same cycle (still not at bottom, latch set).
      expect(d.shouldRequestHistory(base({ viewportY: 20, baseY: 100 })).shouldRequest).toBe(false);
    });

    it('suppresses while a request is in-flight', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100 }));
      d.stampScrollIntent(10_000);
      const decision = d.shouldRequestHistory(base({ viewportY: 40, baseY: 100, inFlight: true }));
      expect(decision.shouldRequest).toBe(false);
    });

    it('holds off within the cooldown window and fires again after it', () => {
      const t0 = 1_000_000; // realistic Date.now()-scale base
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, now: t0 }));
      d.stampScrollIntent(t0);
      expect(
        d.shouldRequestHistory(base({ viewportY: 40, baseY: 100, now: t0 })).shouldRequest,
      ).toBe(true);
      // Return to bottom (clears in-cycle latch) then leave again inside cooldown.
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, now: t0 + 500 }));
      expect(
        d.shouldRequestHistory(base({ viewportY: 40, baseY: 100, now: t0 + 1_000 })).cooldownActive,
      ).toBe(true);
      expect(
        d.shouldRequestHistory(base({ viewportY: 30, baseY: 100, now: t0 + 1_000 })).shouldRequest,
      ).toBe(false);

      // After cooldown elapses, a fresh leave-bottom with a fresh gesture fires.
      d.shouldRequestHistory(
        base({ viewportY: 100, baseY: 100, now: t0 + HISTORY_REQUEST_COOLDOWN_MS }),
      );
      d.stampScrollIntent(t0 + HISTORY_REQUEST_COOLDOWN_MS);
      expect(
        d.shouldRequestHistory(
          base({ viewportY: 40, baseY: 100, now: t0 + HISTORY_REQUEST_COOLDOWN_MS + 1 }),
        ).shouldRequest,
      ).toBe(true);
    });

    it('clears the in-cycle latch when the user returns to the bottom', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100 }));
      d.stampScrollIntent(10_000);
      // The scroll-up fires and sets the in-cycle latch.
      d.shouldRequestHistory(base({ viewportY: 40, baseY: 100 }));
      const back = d.shouldRequestHistory(base({ viewportY: 100, baseY: 100 }));
      expect(back.didResetOnReturn).toBe(true);
    });
  });

  describe('hidden container', () => {
    it('never requests history while hidden, regardless of viewport movement', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, visible: true }));
      // Hidden: buffer viewport races to the top (the exact corruption we defend against).
      const decision = d.shouldRequestHistory(base({ viewportY: 0, baseY: 100, visible: false }));
      expect(decision.shouldRequest).toBe(false);
      expect(decision.suppressed).toBe(true);
    });

    it('freezes was-at-bottom bookkeeping while hidden', () => {
      const d = createScrollHistoryDetector();
      // Establish at-bottom while visible.
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, visible: true }));
      // Hidden viewport jumps to top — must NOT overwrite wasAtBottom.
      d.shouldRequestHistory(base({ viewportY: 0, baseY: 100, visible: false }));
      // The last visible state is still "at bottom".
      expect(d.getLastVisible()).toEqual({ wasAtBottom: true, offsetFromBottom: 0 });
    });

    it('tracks last-visible offset continuously while visible', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100 }));
      d.shouldRequestHistory(base({ viewportY: 70, baseY: 100 }));
      expect(d.getLastVisible()).toEqual({ wasAtBottom: false, offsetFromBottom: 30 });
    });
  });

  describe('pending-restore latch (re-show settle window)', () => {
    it('arms on hidden observation and keeps suppressing after the container is visible again', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, visible: true }));

      // Container hidden (observed by the poll while viewport did not move).
      d.observeVisibility(false);
      expect(d.isRestorePending()).toBe(true);

      // Re-shown, but the deterministic restore has not run yet: a raced scroll-up must still
      // be suppressed even though visible === true.
      const raced = d.shouldRequestHistory(base({ viewportY: 0, baseY: 100, visible: true }));
      expect(raced.shouldRequest).toBe(false);
      expect(raced.suppressed).toBe(true);
    });

    it('reset() re-baselines to the restored position and re-enables genuine scroll-up', () => {
      const d = createScrollHistoryDetector();
      // User was at bottom before hiding.
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, visible: true }));
      d.observeVisibility(false);

      // Deterministic restore ran (scrolled to bottom) → reset.
      d.reset();
      expect(d.isRestorePending()).toBe(false);

      // reset() cleared scroll intent: a programmatic post-restore move must NOT fire even
      // though wasAtBottom was re-baselined to true.
      const noGesture = d.shouldRequestHistory(base({ viewportY: 40, baseY: 100, visible: true }));
      expect(noGesture.shouldRequest).toBe(false);

      // Return to bottom re-arms wasAtBottom (the probe above left it false).
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, visible: true }));

      // A genuine scroll-up (fresh gesture) now triggers again (cooldown was cleared too).
      d.stampScrollIntent(10_000);
      const decision = d.shouldRequestHistory(base({ viewportY: 30, baseY: 100, visible: true }));
      expect(decision.shouldRequest).toBe(true);
    });

    it('reset() to a non-bottom restore position does not misfire on the next tick', () => {
      const d = createScrollHistoryDetector();
      // User was browsing history (offset 30) before hiding.
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, visible: true }));
      d.shouldRequestHistory(base({ viewportY: 70, baseY: 100, visible: true }));
      d.observeVisibility(false);
      d.reset();

      // Poll observes the restored non-bottom position: wasAtBottom was re-baselined to false,
      // so this is not a "leaving bottom" edge and must not request.
      const decision = d.shouldRequestHistory(base({ viewportY: 70, baseY: 100, visible: true }));
      expect(decision.shouldRequest).toBe(false);
      expect(decision.isLeavingBottom).toBe(false);
    });
  });

  describe('scroll-gesture intent', () => {
    it('a gesture stamped within the decay window authorizes a request', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, now: 10_000 }));
      d.stampScrollIntent(10_000);
      // One ms later — well inside the window.
      const decision = d.shouldRequestHistory(base({ viewportY: 40, baseY: 100, now: 10_001 }));
      expect(decision.shouldRequest).toBe(true);
      expect(decision.gestureRecent).toBe(true);
    });

    it('a gesture older than SCROLL_GESTURE_STALE_MS does not authorize a request', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, now: 10_000 }));
      d.stampScrollIntent(10_000);
      // Exactly one ms past the decay window.
      const decision = d.shouldRequestHistory(
        base({ viewportY: 40, baseY: 100, now: 10_000 + SCROLL_GESTURE_STALE_MS + 1 }),
      );
      expect(decision.shouldRequest).toBe(false);
      expect(decision.gestureRecent).toBe(false);
    });

    it('a boundary gesture exactly at the window edge still counts as recent', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, now: 10_000 }));
      d.stampScrollIntent(10_000);
      // now - lastIntent === SCROLL_GESTURE_STALE_MS is NOT recent (< is strict).
      const atEdge = d.shouldRequestHistory(
        base({ viewportY: 40, baseY: 100, now: 10_000 + SCROLL_GESTURE_STALE_MS }),
      );
      expect(atEdge.gestureRecent).toBe(false);
      expect(atEdge.shouldRequest).toBe(false);
    });

    it('respects a custom gestureStaleMs option', () => {
      // Short cooldown so the default 2s cooldown does not mask the gesture-window behavior.
      const d = createScrollHistoryDetector({ gestureStaleMs: 500, cooldownMs: 100 });
      const t0 = 100_000; // large base so the initial cooldown window [0, cooldownMs) is in the past
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, now: t0 }));
      d.stampScrollIntent(t0);
      // Inside the custom 500ms window → fires.
      expect(
        d.shouldRequestHistory(base({ viewportY: 40, baseY: 100, now: t0 + 499 })).shouldRequest,
      ).toBe(true);

      // Re-arm at bottom + fresh gesture, then leave again just past the custom window.
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, now: t0 + 600 }));
      d.stampScrollIntent(t0 + 600);
      const stale = d.shouldRequestHistory(
        base({ viewportY: 40, baseY: 100, now: t0 + 600 + 501 }),
      );
      expect(stale.gestureRecent).toBe(false);
      expect(stale.shouldRequest).toBe(false);
    });

    it('the latest stamp wins (refreshing a drag keeps intent fresh)', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, now: 0 }));
      d.stampScrollIntent(0);
      // A slow drag refreshes intent near the end of the window.
      d.stampScrollIntent(1_900);
      const decision = d.shouldRequestHistory(base({ viewportY: 40, baseY: 100, now: 2_100 }));
      // The fresh stamp (1_900) is only 200ms old.
      expect(decision.gestureRecent).toBe(true);
      expect(decision.shouldRequest).toBe(true);
    });

    it('reset() clears intent so a pre-hide gesture cannot authorize a post-restore misfire', () => {
      const d = createScrollHistoryDetector();
      d.shouldRequestHistory(base({ viewportY: 100, baseY: 100, now: 0 }));
      d.stampScrollIntent(0);
      d.observeVisibility(false);
      d.reset();
      // Immediately after restore, the pre-hide gesture is gone.
      const decision = d.shouldRequestHistory(base({ viewportY: 40, baseY: 100, now: 100 }));
      expect(decision.gestureRecent).toBe(false);
      expect(decision.shouldRequest).toBe(false);
    });
  });
});
