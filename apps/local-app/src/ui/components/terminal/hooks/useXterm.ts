import { useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Socket } from 'socket.io-client';
import { termLog } from '@/ui/lib/debug';
import { isTerminalInternalSequence } from '../xterm-utils';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '@/common/constants/terminal';
import { resolveTerminalSocket } from '../socket';

/**
 * Buffered frame for sequence-based history deduplication
 */
interface BufferedFrame {
  sequence: number;
  data: string;
}

/**
 * Custom hook for xterm.js terminal initialization and lifecycle management.
 * Handles terminal creation, fit addon setup, and cleanup.
 *
 * ## Scrollback Settings Behavior (Q2)
 *
 * The `scrollbackLines` value is **fixed at mount**. If settings change after
 * the terminal is initialized, the new value will not be applied to the existing
 * terminal instance. This is by design because:
 *
 * 1. xterm.js does not reliably support changing `scrollback` on a live terminal
 * 2. Reducing scrollback could discard user's visible history unexpectedly
 * 3. The terminal would need to be recreated to apply new scrollback settings
 *
 * **User Impact**: If users change the scrollback setting in preferences, they
 * must restart the terminal session (close and reopen) for the new value to
 * take effect. This should be communicated in the settings UI.
 *
 * @param terminalRef - React ref to the container DOM element
 * @param sessionId - Terminal session ID for logging
 * @param xtermRef - React ref to store the terminal instance
 * @param fitAddonRef - React ref to store the fit addon instance
 * @param onReady - Optional callback invoked after terminal is ready (fitted)
 * @param inputMode - Terminal input mode: 'form' | 'tty' | null
 * @param hasHistoryRef - Ref tracking if more history is available for loading
 * @param isLoadingHistoryRef - Ref tracking if history is currently being loaded
 * @param historyViewportOffsetRef - Ref tracking viewport offset for history loading
 * @param isHistoryInFlightRef - Ref tracking if history request is in-flight (for buffering)
 * @param pendingHistoryFramesRef - Ref to buffer frames during in-flight for sequence-based dedup
 * @param scrollbackLines - Number of scrollback lines (from settings, fixed at mount)
 */
export function useXterm(
  terminalRef: React.RefObject<HTMLDivElement>,
  sessionId: string,
  xtermRef: React.MutableRefObject<Terminal | null>,
  fitAddonRef: React.MutableRefObject<FitAddon | null>,
  onReady?: () => void,
  inputMode: 'form' | 'tty' | null = 'form',
  hasHistoryRef?: React.MutableRefObject<boolean>,
  isLoadingHistoryRef?: React.MutableRefObject<boolean>,
  historyViewportOffsetRef?: React.MutableRefObject<number | null>,
  isHistoryInFlightRef?: React.MutableRefObject<boolean>,
  pendingHistoryFramesRef?: React.MutableRefObject<BufferedFrame[]>,
  scrollbackLines: number = DEFAULT_TERMINAL_SCROLLBACK,
  socket?: Socket | null,
) {
  useEffect(() => {
    // C1: Clamp scrollbackLines to valid range before using
    // This prevents accidental huge values even if server also clamps
    const clampedScrollback = Math.min(
      Math.max(scrollbackLines, MIN_TERMINAL_SCROLLBACK),
      MAX_TERMINAL_SCROLLBACK,
    );

    // Defer initialization until input mode is resolved
    if (inputMode == null) {
      termLog('terminal_init_blocked', { sessionId, reason: 'input_mode_loading' });
      return;
    }

    if (!terminalRef.current) {
      termLog('terminal_init_blocked', { sessionId, reason: 'no_container' });
      return;
    }

    if (xtermRef.current) {
      // Q2: Terminal already exists - do not reinitialize.
      // This means scrollbackLines changes after mount are intentionally ignored.
      // See JSDoc "Scrollback Settings Behavior" section for rationale.
      termLog('terminal_init_blocked', { sessionId, reason: 'terminal_exists' });
      return;
    }

    termLog('terminal_init_start', { sessionId });
    const activeSocket = resolveTerminalSocket(socket);

    const terminal = new Terminal({
      convertEol: true,
      scrollback: clampedScrollback,
      cursorBlink: false, // Disable cursor blink
      disableStdin: inputMode === 'form', // Enable stdin for TTY mode
      // Dampen scroll aggressiveness
      fastScrollSensitivity: 1,
      scrollSensitivity: 1,
      theme: {
        // Dark terminal theme - works well with ANSI colors
        background: '#1a1a1a',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#1f6feb',
        selectionForeground: '#ffffff',

        // Standard ANSI colors - adjusted for better readability on dark background
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',

        // Bright ANSI colors
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(terminalRef.current);
    // Dampen wheel scrolling directly on the xterm viewport and stop native wheel handling
    const viewport =
      (terminal.element?.querySelector('.xterm-viewport') as HTMLDivElement | null) ?? null;
    const wheelHandler = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      // ~1–2 lines per notch depending on device delta
      const magnitude = Math.max(1, Math.round((Math.abs(event.deltaY) / 120) * 1.5));
      const lines = Math.sign(event.deltaY) * magnitude; // preserve direction, avoid rounding to 0
      terminal.scrollLines(lines);
    };
    // Capture phase to pre-empt xterm's own wheel handler
    viewport?.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
    terminalRef.current.addEventListener('wheel', wheelHandler, { passive: false, capture: true });

    // Add direct TTY input handler for TTY mode
    if (inputMode === 'tty') {
      termLog('terminal_tty_mode_enabled', { sessionId });

      terminal.onData((data) => {
        // Filter out terminal-internal control sequences (OSC, DCS, etc.)
        // These are generated by xterm.js internally and should not be sent to the shell
        if (isTerminalInternalSequence(data)) {
          termLog('terminal_filtered_internal_sequence', {
            sessionId,
            sequenceLength: data.length,
          });
          return;
        }

        if (activeSocket.connected) {
          activeSocket.emit('terminal:input', { sessionId, data, ttyMode: true });
        }
      });
    }

    // Add scroll handler for history loading
    // Track whether we've requested history in this scroll cycle
    const requestedHistoryRef = { current: false };
    // Track last request time to prevent rapid re-triggering
    let lastRequestTime = 0;
    let wasAtBottom = true;
    let scrollDisposable: { dispose: () => void } | undefined;

    if (hasHistoryRef) {
      // Log initial buffer state to understand scroll capacity
      const buffer = terminal.buffer.active;
      termLog('xterm_scroll_listener_registered', {
        sessionId,
        hasHistoryRefDefined: !!hasHistoryRef,
        initialHasHistory: hasHistoryRef.current,
        initialBufferState: {
          viewportY: buffer.viewportY,
          baseY: buffer.baseY,
          cursorY: buffer.cursorY,
          length: buffer.length,
          scrollback: terminal.options.scrollback,
        },
      });

      // Helper function to handle scroll state changes
      const handleScrollChange = (viewportY: number, baseY: number, source: string) => {
        // User is at the bottom (current prompt area)
        const isAtBottom = viewportY === baseY;

        // User is scrolling up away from the bottom (entering history browsing mode)
        // This is safe from TUI redraw because during TUI redraw, viewportY === baseY
        // (content is added at bottom and viewport follows), so isLeavingBottom is false.
        const isLeavingBottom = wasAtBottom && !isAtBottom;

        const now = Date.now();
        const timeSinceLastRequest = now - lastRequestTime;
        const cooldownActive = timeSinceLastRequest < 2000; // 2 second cooldown

        // Check if history request is already in-flight
        const inFlight = isHistoryInFlightRef?.current ?? false;

        // Only log interesting events (not every scroll tick during loading)
        if (isLeavingBottom || (isAtBottom && !wasAtBottom)) {
          termLog('xterm_scroll_detected', {
            sessionId,
            viewportY,
            baseY,
            isAtBottom,
            isLeavingBottom,
            hasHistory: hasHistoryRef.current,
            requestedHistory: requestedHistoryRef.current,
            cooldownActive,
            inFlight,
            timeSinceLastRequest,
            source, // 'event' or 'poll'
          });
        }

        // When user starts scrolling up from bottom and history is available,
        // request full history reload so they can see older content.
        // Safe from TUI redraw: during TUI redraw viewportY === baseY, so isLeavingBottom is false.
        // The sequence-based buffering will preserve any new frames during history load.
        if (
          isLeavingBottom &&
          hasHistoryRef.current &&
          !requestedHistoryRef.current &&
          !cooldownActive &&
          !inFlight
        ) {
          // Capture current offset from bottom so we can restore position after reload
          try {
            const buffer = terminal.buffer.active;
            const offsetFromBottom = buffer.baseY - buffer.viewportY;
            if (historyViewportOffsetRef) {
              historyViewportOffsetRef.current = offsetFromBottom;
            }
            termLog('history_offset_captured', {
              sessionId,
              offsetFromBottom,
              baseY,
              viewportY,
            });
          } catch (error) {
            termLog('history_offset_capture_failed', { sessionId, error });
          }

          // CRITICAL: Set in-flight flag BEFORE emitting request
          // This ensures frames arriving after emit are buffered for deduplication
          if (isHistoryInFlightRef) {
            isHistoryInFlightRef.current = true;
          }
          if (pendingHistoryFramesRef) {
            pendingHistoryFramesRef.current = [];
          }

          termLog('history_full_sync_request', {
            sessionId,
            viewportY,
            baseY,
            trigger: 'leaving_bottom',
          });

          activeSocket.emit('terminal:request_full_history', {
            sessionId,
            maxLines: clampedScrollback,
          });
          requestedHistoryRef.current = true;
          lastRequestTime = now; // Start cooldown period
        }

        // When user scrolls back to bottom, reset flag
        if (isAtBottom && !wasAtBottom) {
          termLog('history_request_reset', {
            sessionId,
            reason: 'scrolled_to_bottom',
          });
          requestedHistoryRef.current = false;
          // Don't reset lastRequestTime - keep cooldown active
        }

        wasAtBottom = isAtBottom;
      };

      // Try to use onScroll event (doesn't always fire reliably)
      scrollDisposable = terminal.onScroll(() => {
        const buffer = terminal.buffer.active;
        handleScrollChange(buffer.viewportY, buffer.baseY, 'event');
      });

      // Polling fallback: Detect viewport changes that onScroll misses
      // This reliably catches all scroll changes from mouse wheel, scrollbar, etc.
      let lastViewportY = terminal.buffer.active.viewportY;
      const pollInterval = setInterval(() => {
        const buffer = terminal.buffer.active;
        const currentViewportY = buffer.viewportY;

        // Skip scroll detection while history is loading to avoid spam
        if (isLoadingHistoryRef?.current) {
          // Update last position without logging
          lastViewportY = currentViewportY;
          return;
        }

        if (currentViewportY !== lastViewportY) {
          handleScrollChange(currentViewportY, buffer.baseY, 'poll');
          lastViewportY = currentViewportY;
        }
      }, 100);

      // Wrap disposal to clean up both scroll listener and polling
      const originalDisposable = scrollDisposable;
      scrollDisposable = {
        dispose: () => {
          clearInterval(pollInterval);
          originalDisposable?.dispose();
        },
      };
    } else {
      termLog('xterm_scroll_listener_skipped', {
        sessionId,
        reason: 'hasHistoryRef_undefined',
      });
    }

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Wait for terminal to be fully rendered before fitting
    const timeoutId = setTimeout(() => {
      fitAddon.fit();
      onReady?.();
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      scrollDisposable?.dispose();
      termLog('terminal_dispose', { sessionId });
      terminalRef.current?.removeEventListener('wheel', wheelHandler, {
        capture: true,
      } as EventListenerOptions);
      viewport?.removeEventListener('wheel', wheelHandler, {
        capture: true,
      } as EventListenerOptions);
      terminal.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [
    sessionId,
    terminalRef,
    onReady,
    inputMode,
    hasHistoryRef,
    isLoadingHistoryRef,
    historyViewportOffsetRef,
    isHistoryInFlightRef,
    pendingHistoryFramesRef,
    scrollbackLines,
    socket,
  ]);
}
