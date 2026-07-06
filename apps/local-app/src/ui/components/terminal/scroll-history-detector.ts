/**
 * Visibility-aware scroll-up → history-load detector.
 *
 * This is the testable seam extracted from `useXterm`'s effect closure: a single
 * `shouldRequestHistory(...)` predicate plus a `reset()` API, consumed by BOTH the
 * onScroll and the 100ms poll paths so their decisions and state stay in lock-step.
 *
 * ## Why the extra state beyond "am I leaving the bottom?"
 *
 * When the terminal container is hidden (`display:none` ancestor → `offsetParent === null`)
 * the browser clamps `.xterm-viewport` scrollTop to 0. At re-show a scroll event can race
 * xterm's own viewport restore and scroll the buffer to the TOP; the naive detector then
 * reads `viewportY=0, baseY=N`, mistakes it for a user scroll-up, and fires a full-history
 * load that cements the top position. The detector defends against that whole class:
 *
 * - While the container is hidden the trigger is suppressed and `wasAtBottom` bookkeeping
 *   is frozen (a ResizeObserver fires post-layout and cannot observe the pre-hide state, so
 *   we keep tracking `lastVisible` continuously instead of capturing at hide time).
 * - Observing a hidden container arms `restorePending`, which keeps the trigger suppressed
 *   across the entire hide → re-show → settle window — not just while `offsetParent` is null.
 *   A scroll event can land after re-show but before the deterministic restore runs; without
 *   this latch that event would misfire.
 * - `reset()` is called once the re-show restore has deterministically repositioned the
 *   viewport, re-baselining `wasAtBottom` from the restored position and clearing the
 *   cooldown so a subsequent genuine user scroll-up still triggers a history load.
 * - A history request additionally requires RECENT user scroll intent (`stampScrollIntent`),
 *   so no programmatic viewport movement — whatever its browser-level cause (resize reflow,
 *   TUI redraw burst, stale-scrollTop sync) — can ever fire the destructive full-buffer
 *   rewrite. Only real DOM input events (host-path wheel-up, Shift+PageUp/PageDown, viewport
 *   pointer drag) stamp intent; it decays after `SCROLL_GESTURE_STALE_MS`.
 */

/** Cooldown after a history request before another may fire, in ms. */
export const HISTORY_REQUEST_COOLDOWN_MS = 2000;

/**
 * How long a stamped scroll gesture authorizes a history request before it is considered
 * stale. Tuned generously for trackpad momentum scrolling; kept a named constant rather than
 * a magic number. A programmatic viewport move with no gesture inside this window never emits.
 */
export const SCROLL_GESTURE_STALE_MS = 2000;

export interface ScrollDetectorInput {
  /** xterm buffer viewport top line (`buffer.active.viewportY`). */
  viewportY: number;
  /** xterm buffer base line (`buffer.active.baseY`). */
  baseY: number;
  /** Whether the terminal container is currently laid out and on-screen. */
  visible: boolean;
  /** Whether more history is loadable (server-advertised `hasHistory`). */
  hasHistory: boolean;
  /** Whether a history request is already in-flight. */
  inFlight: boolean;
  /** Current time in ms (injected for testability). */
  now: number;
}

export interface ScrollDetectorDecision {
  /** The single output the caller acts on: emit `terminal:request_full_history`. */
  shouldRequest: boolean;
  /** Offset from bottom at decision time, captured for post-reload position restore. */
  offsetFromBottom: number;
  isAtBottom: boolean;
  isLeavingBottom: boolean;
  cooldownActive: boolean;
  /** True when the decision was gated by visibility / pending-restore (no bookkeeping ran). */
  suppressed: boolean;
  /** True when the return-to-bottom edge cleared the in-cycle request latch. */
  didResetOnReturn: boolean;
  /** Whether a scroll gesture was stamped within `SCROLL_GESTURE_STALE_MS` of `now`. */
  gestureRecent: boolean;
}

export interface LastVisibleState {
  wasAtBottom: boolean;
  offsetFromBottom: number;
}

export interface ScrollHistoryDetector {
  /**
   * Evaluate a scroll state change and decide whether to request full history.
   * Advances internal bookkeeping ONLY while visible and not pending-restore.
   */
  shouldRequestHistory(input: ScrollDetectorInput): ScrollDetectorDecision;
  /**
   * Feed container visibility every tick regardless of viewport movement. Observing a
   * hidden container arms the pending-restore latch (the poll's change-guard means a bare
   * `shouldRequestHistory` may never run while hidden, so visibility is tracked separately).
   */
  observeVisibility(visible: boolean): void;
  /**
   * Record a genuine user scroll gesture at `now`. Only real DOM input events should call
   * this (host-path wheel-up, Shift+PageUp/PageDown keydown, viewport pointer drag) — never
   * xterm's onScroll/poll callbacks, which fire for programmatic moves too.
   */
  stampScrollIntent(now: number): void;
  /** Last visible scroll state — the target the re-show restore aims for. */
  getLastVisible(): LastVisibleState;
  /** Whether a hidden container has been observed and the restore has not yet run. */
  isRestorePending(): boolean;
  /**
   * Re-baseline after the deterministic re-show restore: `wasAtBottom` follows the restored
   * position (from `lastVisible`), the request latch and cooldown clear, and pending-restore
   * clears so normal detection resumes. Scroll intent is also cleared so a post-restore
   * viewport move needs a fresh gesture (a pre-hide gesture must not authorize a misfire).
   */
  reset(): void;
}

export function createScrollHistoryDetector(options?: {
  cooldownMs?: number;
  gestureStaleMs?: number;
}): ScrollHistoryDetector {
  const cooldownMs = options?.cooldownMs ?? HISTORY_REQUEST_COOLDOWN_MS;
  const gestureStaleMs = options?.gestureStaleMs ?? SCROLL_GESTURE_STALE_MS;

  let wasAtBottom = true;
  let requestedHistory = false;
  let lastRequestTime = 0;
  let lastVisible: LastVisibleState = { wasAtBottom: true, offsetFromBottom: 0 };
  let restorePending = false;
  // 0 means "never stamped"; hasRecentScrollIntent treats it as no intent.
  let lastScrollIntentTime = 0;

  function observeVisibility(visible: boolean): void {
    if (!visible) restorePending = true;
  }

  function stampScrollIntent(now: number): void {
    lastScrollIntentTime = now;
  }

  function hasRecentScrollIntent(now: number): boolean {
    return lastScrollIntentTime > 0 && now - lastScrollIntentTime < gestureStaleMs;
  }

  function shouldRequestHistory(input: ScrollDetectorInput): ScrollDetectorDecision {
    const { viewportY, baseY, visible, hasHistory, inFlight, now } = input;
    const isAtBottom = viewportY === baseY;
    const offsetFromBottom = baseY - viewportY;

    if (!visible) restorePending = true;

    // Suppressed window: hidden, or re-shown but not yet deterministically restored.
    // Freeze all bookkeeping so a clamped/raced viewport read cannot corrupt state.
    if (!visible || restorePending) {
      return {
        shouldRequest: false,
        offsetFromBottom,
        isAtBottom,
        isLeavingBottom: false,
        cooldownActive: false,
        suppressed: true,
        didResetOnReturn: false,
        gestureRecent: hasRecentScrollIntent(now),
      };
    }

    const isLeavingBottom = wasAtBottom && !isAtBottom;
    const cooldownActive = now - lastRequestTime < cooldownMs;
    const gestureRecent = hasRecentScrollIntent(now);
    const shouldRequest =
      isLeavingBottom &&
      hasHistory &&
      !requestedHistory &&
      !cooldownActive &&
      !inFlight &&
      gestureRecent;

    if (shouldRequest) {
      requestedHistory = true;
      lastRequestTime = now;
    }

    let didResetOnReturn = false;
    if (isAtBottom && !wasAtBottom) {
      // Returned to bottom — allow the next scroll-up to request again.
      requestedHistory = false;
      didResetOnReturn = true;
    }

    wasAtBottom = isAtBottom;
    lastVisible = { wasAtBottom: isAtBottom, offsetFromBottom };

    return {
      shouldRequest,
      offsetFromBottom,
      isAtBottom,
      isLeavingBottom,
      cooldownActive,
      suppressed: false,
      didResetOnReturn,
      gestureRecent,
    };
  }

  function getLastVisible(): LastVisibleState {
    return { ...lastVisible };
  }

  function isRestorePending(): boolean {
    return restorePending;
  }

  function reset(): void {
    wasAtBottom = lastVisible.wasAtBottom;
    requestedHistory = false;
    lastRequestTime = 0;
    restorePending = false;
    lastScrollIntentTime = 0;
  }

  return {
    shouldRequestHistory,
    observeVisibility,
    stampScrollIntent,
    getLastVisible,
    isRestorePending,
    reset,
  };
}
