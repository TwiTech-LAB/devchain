/**
 * Production DOM binding seam for xterm scroll intent and scrollbar-drag lifecycle.
 *
 * xterm 6 replaced the native `.xterm-viewport` scrollbar with VS Code's
 * `SmoothScrollableElement`: the wheel and the real vertical scrollbar
 * (`.xterm-scrollable-element > .scrollbar.vertical`, track + `.slider`) are consumed
 * inside that inner element, which OWNS viewport movement. DevChain must not move the
 * viewport itself (doing so double-scrolls), so this seam only OBSERVES trusted input to
 * stamp host-history scroll intent for `scroll-history-detector`, and never prevents, stops,
 * or moves.
 *
 * Everything is bound in the CAPTURE phase on the STABLE terminal container (the React-owned
 * element passed to `terminal.open`), never on `.xterm-viewport` — xterm recreates its inner
 * DOM, and capture on the stable ancestor observes events before xterm's own handlers
 * (which `preventDefault`/`setPointerCapture`). A scrollbar drag routes through xterm's
 * `GlobalPointerMoveMonitor`, which uses pointer capture and can end via pointerup,
 * pointercancel, OR silent pointer-capture loss; the drag controller mirrors all three so the
 * later client-integration task can defer a history response until the drag has fully ended.
 *
 * The seam is framework-agnostic and self-contained so both `useXterm` and the real xterm 6
 * Chromium smoke import the identical production code path.
 */
import { supportsWheelMouseTracking } from './xterm-utils';

/** How the browser ended a scrollbar drag. `capture-loss` is a silent end (no pointerup). */
export type ScrollDragEndReason = 'pointerup' | 'pointercancel' | 'capture-loss';

export interface ScrollIntentBindingOptions {
  /**
   * The STABLE terminal container (the element passed to `terminal.open`), NOT the
   * xterm-recreated `.xterm-viewport`. All listeners bind here in the capture phase so they
   * survive xterm's inner-DOM churn and observe before xterm's own handlers.
   */
  container: HTMLElement;
  /** Stamp upward host-history scroll intent at `now`. Wire to `detector.stampScrollIntent`. */
  stampIntent: (now: number) => void;
  /** Live TTY mouse-tracking mode, read at event time (`terminal.modes.mouseTrackingMode`). */
  getMouseTrackingMode: () => string;
  /** Whether the terminal is in TTY input mode, where a TUI can own the wheel. */
  isTtyMode: () => boolean;
  /** Injected clock for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface ScrollIntentController {
  /** True from a real scrollbar pointerdown until the drag ends by any path. */
  isDragActive(): boolean;
  /**
   * Subscribe to scrollbar-drag end — clean pointerup, pointercancel, or silent
   * pointer-capture loss. Returns an unsubscribe function. The client-integration task
   * consumes this to apply a deferred `full_history` response only after the drag has fully
   * ended, so a destructive buffer rewrite cannot race the drag's cloned scrollbar state.
   */
  onDragEnd(listener: (reason: ScrollDragEndReason) => void): () => void;
  /** Remove every listener. Call on terminal recreation, session change, and unmount. */
  dispose(): void;
}

/** Whether an event path crosses the real vertical scrollbar (its track or slider). */
function crossesVerticalScrollbar(event: Event): boolean {
  const path =
    typeof event.composedPath === 'function' && event.composedPath().length
      ? event.composedPath()
      : ancestorsOf(event.target);
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    // The scrollbar element is `.scrollbar.vertical` whose direct parent is the scrollable
    // element; matching that exact pair keeps ordinary terminal-content selection (which never
    // crosses the scrollbar) from stamping intent. The track is this element; the slider is its
    // descendant, so either lands here via the path.
    if (
      node.classList.contains('scrollbar') &&
      node.classList.contains('vertical') &&
      node.parentElement?.classList.contains('xterm-scrollable-element')
    ) {
      return true;
    }
  }
  return false;
}

/** composedPath fallback for environments/events that do not populate it. */
function ancestorsOf(target: EventTarget | null): EventTarget[] {
  const chain: EventTarget[] = [];
  let node = target instanceof Node ? target : null;
  while (node) {
    chain.push(node);
    node = node.parentNode;
  }
  return chain;
}

export function createScrollIntentBinding(
  options: ScrollIntentBindingOptions,
): ScrollIntentController {
  const { container, stampIntent, getMouseTrackingMode, isTtyMode } = options;
  const now = options.now ?? (() => Date.now());
  const targetWindow = container.ownerDocument.defaultView ?? window;
  const targetDocument = container.ownerDocument;

  // Passive capture so we observe without ever blocking or moving. Reused for every binding.
  const passiveCapture = { capture: true, passive: true } as const;

  let dragActive = false;
  const dragEndListeners = new Set<(reason: ScrollDragEndReason) => void>();

  const onWheel = (event: WheelEvent) => {
    // A wheel forwarded to a wheel-capable TUI is that app's input, not a scrollback gesture.
    if (isTtyMode() && supportsWheelMouseTracking(getMouseTrackingMode())) return;
    // Only the upward direction loads host history.
    if (event.deltaY < 0) stampIntent(now());
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Shift+PageUp/PageDown are the only keys xterm uses to scroll its own viewport; unmodified
    // PageUp/PageDown and Home/End are sent to the shell as key sequences and are not scrollback
    // gestures.
    if (event.shiftKey && (event.code === 'PageUp' || event.code === 'PageDown')) {
      stampIntent(now());
    }
  };

  const onDragMove = () => {
    // Refresh intent while the drag stays active so a slow scrollbar drag longer than the decay
    // window does not expire mid-drag; the capture-phase listener runs before xterm moves.
    if (dragActive) stampIntent(now());
  };
  const endDrag = (reason: ScrollDragEndReason) => {
    if (!dragActive) return;
    dragActive = false;
    removeDragListeners();
    for (const listener of dragEndListeners) listener(reason);
  };
  const onDragUp = () => endDrag('pointerup');
  const onDragCancel = () => endDrag('pointercancel');
  const onDragCaptureLoss = () => endDrag('capture-loss');

  function addDragListeners() {
    targetWindow.addEventListener('pointermove', onDragMove, passiveCapture);
    targetWindow.addEventListener('pointerup', onDragUp, passiveCapture);
    targetWindow.addEventListener('pointercancel', onDragCancel, passiveCapture);
    // xterm's slider drag uses `setPointerCapture`; a lost capture ends the drag with NO
    // pointerup, so this is the only signal for that path.
    targetDocument.addEventListener('lostpointercapture', onDragCaptureLoss, passiveCapture);
  }
  function removeDragListeners() {
    targetWindow.removeEventListener('pointermove', onDragMove, passiveCapture);
    targetWindow.removeEventListener('pointerup', onDragUp, passiveCapture);
    targetWindow.removeEventListener('pointercancel', onDragCancel, passiveCapture);
    targetDocument.removeEventListener('lostpointercapture', onDragCaptureLoss, passiveCapture);
  }

  const onPointerDown = (event: PointerEvent) => {
    if (!crossesVerticalScrollbar(event)) return;
    stampIntent(now());
    if (dragActive) return;
    dragActive = true;
    addDragListeners();
  };

  container.addEventListener('wheel', onWheel as EventListener, passiveCapture);
  container.addEventListener('keydown', onKeyDown as EventListener, passiveCapture);
  container.addEventListener('pointerdown', onPointerDown as EventListener, passiveCapture);

  return {
    isDragActive: () => dragActive,
    onDragEnd(listener) {
      dragEndListeners.add(listener);
      return () => dragEndListeners.delete(listener);
    },
    dispose() {
      container.removeEventListener('wheel', onWheel as EventListener, passiveCapture);
      container.removeEventListener('keydown', onKeyDown as EventListener, passiveCapture);
      container.removeEventListener('pointerdown', onPointerDown as EventListener, passiveCapture);
      removeDragListeners();
      dragActive = false;
      dragEndListeners.clear();
    },
  };
}
