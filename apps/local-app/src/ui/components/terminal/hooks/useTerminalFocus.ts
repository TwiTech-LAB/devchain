import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { resolveTerminalSocket } from '../socket';
import { createFocusIntentTracker } from '../focus-intent';

/**
 * Custom hook for managing terminal focus event handling.
 *
 * Emits `terminal:focus` (an authority claim) when the terminal container receives focus — but
 * ONLY when the focusin was driven by a recent user gesture. Programmatic `.focus()` (inline
 * panel re-show `fit()+focus()`, floating-window `handle.focus()`) has no preceding gesture and
 * therefore no longer steals authority, so it cannot flip shared pty geometry and mint duplicated
 * scrollback. Genuine click / keyboard entry still claims before the first typed byte.
 *
 * @param containerRef - Ref to the terminal container element
 * @param sessionId - Terminal session ID
 * @param isSubscribedRef - Ref tracking subscription status
 */
export function useTerminalFocus(
  containerRef: React.RefObject<HTMLDivElement>,
  sessionId: string,
  isSubscribedRef: React.MutableRefObject<boolean>,
  socket?: Socket | null,
) {
  useEffect(() => {
    const activeSocket = resolveTerminalSocket(socket);
    const host = containerRef.current;
    if (!host) return;

    const intent = createFocusIntentTracker();

    // Capture user intent at DOCUMENT level, not on the host: a Tab keydown that moves focus INTO
    // the terminal fires on the PREVIOUSLY focused element (outside the host), so a host-scoped
    // listener would miss keyboard entry. pointerdown AND keydown both stamp (keyboard entry is
    // mandatory for accessibility — Tab-into-terminal must still claim), and both fire before the
    // focusin they precede.
    const stampIntent = () => intent.stamp();
    document.addEventListener('pointerdown', stampIntent, { capture: true });
    document.addEventListener('keydown', stampIntent, { capture: true });

    const handleFocusIn = () => {
      if (!activeSocket.connected || !isSubscribedRef.current) return;
      // Gate the claim on a fresh gesture: programmatic focus (no preceding pointerdown/keydown)
      // never claims, so it cannot steal authority or flip geometry.
      if (!intent.hasRecentIntent()) return;
      activeSocket.emit('terminal:focus', { sessionId });
    };
    host.addEventListener('focusin', handleFocusIn, { capture: true });

    return () => {
      document.removeEventListener('pointerdown', stampIntent, { capture: true });
      document.removeEventListener('keydown', stampIntent, { capture: true });
      host.removeEventListener('focusin', handleFocusIn, { capture: true });
    };
  }, [sessionId, isSubscribedRef, containerRef, socket]);
}
