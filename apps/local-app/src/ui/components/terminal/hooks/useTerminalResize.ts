import { useCallback, useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { Socket } from 'socket.io-client';
import { termLog } from '@/ui/lib/debug';
import { resolveTerminalSocket } from '../socket';

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
 * @param hasHistoryRef - Ref tracking if history is available (reset to true after resize)
 */
export function useTerminalResize(
  terminalRef: React.RefObject<HTMLDivElement>,
  xtermRef: React.RefObject<Terminal | null>,
  fitAddonRef: React.RefObject<FitAddon | null>,
  sessionId: string,
  expectingSeedRef?: React.MutableRefObject<boolean>,
  hasHistoryRef?: React.MutableRefObject<boolean>,
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

          // After resize, TUI might output more than viewport size, creating scrollback
          // We can't clear only scrollback (clear() wipes viewport too)
          // Instead, just scroll to bottom. If user scrolls up, history reload will replace any garbage
          if (!isInitialResize) {
            // Reset hasHistoryRef so user can reload clean history from tmux after resize
            if (hasHistoryRef) {
              hasHistoryRef.current = true;
            }

            const xterm = xtermRef.current;
            setTimeout(() => {
              if (xterm) {
                xterm.scrollToBottom();
                termLog('resize_scroll_bottom', { sessionId, cols, rows, hasHistoryReset: true });
              }
            }, 300);
          }
        }
      }
    }, 250), // Debounce: wait 250ms after last resize
    [sessionId, xtermRef, fitAddonRef, expectingSeedRef, hasHistoryRef, socket],
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
