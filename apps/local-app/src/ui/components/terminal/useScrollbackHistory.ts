import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { termLog } from '@/ui/lib/debug';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '@/common/constants/terminal';
import { resolveTerminalSocket } from './socket';

/**
 * Custom hook for managing scrollback history requests.
 * Requests full history when user scrolls to top.
 *
 * @param terminalRef - Ref to terminal container element
 * @param sessionId - Terminal session ID
 * @param hasHistoryRef - Ref tracking if history is available
 * @param isHistoryInFlightRef - Ref tracking if history request is in-flight
 * @param scrollbackLines - Number of scrollback lines (from settings)
 */
export function useScrollbackHistory(
  terminalRef: React.RefObject<HTMLDivElement>,
  sessionId: string,
  hasHistoryRef: React.MutableRefObject<boolean>,
  isHistoryInFlightRef?: React.MutableRefObject<boolean>,
  scrollbackLines: number = DEFAULT_TERMINAL_SCROLLBACK,
  socket?: Socket | null,
) {
  const requestedHistoryRef = useRef<boolean>(false);
  const wasNearBottomRef = useRef<boolean>(true);

  useEffect(() => {
    // C1: Clamp scrollbackLines to valid range before using
    // This prevents accidental huge values even if server also clamps
    const clampedScrollback = Math.min(
      Math.max(scrollbackLines, MIN_TERMINAL_SCROLLBACK),
      MAX_TERMINAL_SCROLLBACK,
    );

    const host = terminalRef.current;
    if (!host) return;

    // Reset per-session so a new terminal session can request history again
    requestedHistoryRef.current = false;

    // Helper: consider "near bottom" when we're within ~half a viewport of the end.
    const isNearBottom = () => {
      const distanceFromBottom = host.scrollHeight - host.clientHeight - host.scrollTop;
      return distanceFromBottom <= host.clientHeight / 2;
    };

    wasNearBottomRef.current = isNearBottom();
    termLog('history_scroll_init', {
      sessionId,
      scrollTop: host.scrollTop,
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      nearBottom: wasNearBottomRef.current,
    });

    const onScroll = () => {
      const nearBottom = isNearBottom();

      // Check if history request is already in-flight
      const inFlight = isHistoryInFlightRef?.current ?? false;

      // On-demand full history sync:
      // When user first scrolls meaningfully away from the bottom (to browse
      // history), request a full history snapshot once for this session.
      // GUARDS: Check hasHistoryRef and inFlight to prevent unnecessary/duplicate requests
      if (
        wasNearBottomRef.current &&
        !nearBottom &&
        !requestedHistoryRef.current &&
        hasHistoryRef.current && // Only request if history is available
        !inFlight // Don't request if already in-flight
      ) {
        termLog('history_full_sync_request', {
          sessionId,
          scrollTop: host.scrollTop,
          scrollHeight: host.scrollHeight,
          clientHeight: host.clientHeight,
          hasHistory: hasHistoryRef.current,
        });
        const activeSocket = resolveTerminalSocket(socket);
        activeSocket.emit('terminal:request_full_history', {
          sessionId,
          maxLines: clampedScrollback,
        });
        requestedHistoryRef.current = true;
      }

      wasNearBottomRef.current = nearBottom;
    };

    host.addEventListener('scroll', onScroll);
    return () => host.removeEventListener('scroll', onScroll);
  }, [sessionId, terminalRef, hasHistoryRef, isHistoryInFlightRef, scrollbackLines, socket]);

  // Note: For terminals where the container does not scroll (overflow hidden),
  // full-history sync is handled via xterm's own scroll events in useXterm.
}
