import { useCallback, useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { Socket } from 'socket.io-client';
import { termLog } from '@/ui/lib/debug';
import { resolveTerminalSocket } from '../socket';
import { isTerminalContainerVisible } from '../xterm-utils';

/**
 * Simple debounce helper for resize events
 */
function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * Custom hook for handling terminal resize with debouncing and dimension change detection.
 * Only emits resize events when dimensions actually change.
 *
 * @param terminalRef - React ref to the terminal container DOM element
 * @param xtermRef - React ref to the xterm Terminal instance
 * @param fitAddonRef - React ref to the FitAddon instance
 * @param sessionId - Terminal session ID for logging and WebSocket emissions
 * @param expectingSeedRef - Ref tracking if we're expecting a seed (skip resize during seed)
 */
export function useTerminalResize(
  terminalRef: React.RefObject<HTMLDivElement>,
  xtermRef: React.MutableRefObject<Terminal | null>,
  fitAddonRef: React.MutableRefObject<FitAddon | null>,
  sessionId: string,
  expectingSeedRef?: React.MutableRefObject<boolean>,
  socket?: Socket | null,
) {
  // Track last dimensions to avoid duplicate resize events
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  // Track when to skip resize events (during seed loading)
  const skipResizeUntilRef = useRef<number>(0);

  // Create debounced resize handler (must be outside useEffect to avoid Rules of Hooks violation)
  const handleResize = useCallback(
    debounce(() => {
      // Skip resize during seed loading to avoid triggering TUI redraw
      // that would be ignored by the ignore window
      if (expectingSeedRef?.current) {
        termLog('resize_skipped', { sessionId, reason: 'expecting_seed' });
        return;
      }
      if (skipResizeUntilRef.current > 0 && Date.now() < skipResizeUntilRef.current) {
        termLog('resize_skipped', { sessionId, reason: 'skip_window_active' });
        return;
      }

      // Defer fit + resize emission while the container is hidden. A hidden container reports
      // computed height 0px; FitAddon can then propose a garbage 2×1 geometry and we would emit
      // a bogus PTY resize. Skipping here defers both fit and the `terminal:resize` emit until a
      // resize fires again once visible (re-show triggers the observer), where correct dims exist.
      if (!isTerminalContainerVisible(terminalRef.current)) {
        termLog('resize_skipped', { sessionId, reason: 'hidden' });
        return;
      }

      fitAddonRef.current?.fit();
      if (xtermRef.current) {
        const activeSocket = resolveTerminalSocket(socket);
        const { cols, rows } = xtermRef.current;
        const last = lastDimensionsRef.current;

        // Only emit if dimensions actually changed
        if (!last || last.cols !== cols || last.rows !== rows) {
          const isInitialResize = !last;
          lastDimensionsRef.current = { cols, rows };
          termLog('resize', { sessionId, cols, rows, isInitialResize });

          // Only emit if socket is connected
          if (activeSocket.connected) {
            activeSocket.emit('terminal:resize', { sessionId, cols, rows });
          }

          // After a non-initial resize, snap back to the bottom so newly-wrapped lines don't
          // leave the viewport parked above the prompt.
          //
          // Deliberate behavioral change: this hook no longer force-sets `hasHistoryRef = true`
          // after a resize. The seed handler and the full_history handler are the sole owners of
          // that flag. Force-arming it here re-authorized scroll-up reloads for sessions whose
          // seed advertised `hasHistory: false` (notably alternate-screen TUIs), which was a
          // side effect, not a feature contract. Proper per-session refresh vs hasMore semantics
          // is tracked as a backlog item; do not re-add the force-set.
          if (!isInitialResize) {
            const xterm = xtermRef.current;
            setTimeout(() => {
              if (xterm) {
                xterm.scrollToBottom();
                termLog('resize_scroll_bottom', { sessionId, cols, rows });
              }
            }, 300);
          }
        }
      }
    }, 250), // Debounce: wait 250ms after last resize
    [sessionId, terminalRef, xtermRef, fitAddonRef, expectingSeedRef, socket],
  );

  // Handle window resize with debouncing and dimension change detection
  useEffect(() => {
    const resizeObserver = new ResizeObserver(handleResize);
    if (terminalRef.current) {
      resizeObserver.observe(terminalRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [handleResize, terminalRef]);
}
