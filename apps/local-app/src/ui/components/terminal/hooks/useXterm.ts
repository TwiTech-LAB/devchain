import { useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Socket } from 'socket.io-client';
import { termLog } from '@/ui/lib/debug';
import { toast } from '@/ui/hooks/use-toast';
import {
  decodeOsc52ClipboardPayload,
  isTerminalContainerVisible,
  isTerminalInternalSequence,
  supportsWheelMouseTracking,
} from '../xterm-utils';
import { createScrollHistoryDetector } from '../scroll-history-detector';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '@/common/constants/terminal';
import { resolveTerminalSocket } from '../socket';
import { resolveTerminalTheme } from '../terminal-themes';
import type { ThemeValue } from '@/ui/components/ThemeSelect';

/**
 * Buffered frame for sequence-based history deduplication
 */
interface BufferedFrame {
  sequence: number;
  data: string;
}

/**
 * Delay between detecting re-show and running the deterministic viewport restore.
 * Mirrors the post-resize settle in `useTerminalResize` (300ms): the restore MUST run
 * after fit + xterm reflow settles, or xterm's own `ydisp` rewrite can re-corrupt the
 * position we just set.
 */
const RESHOW_RESTORE_SETTLE_MS = 300;

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
  isHistoryInFlightRef?: React.MutableRefObject<boolean>,
  pendingHistoryFramesRef?: React.MutableRefObject<BufferedFrame[]>,
  scrollbackLines: number = DEFAULT_TERMINAL_SCROLLBACK,
  socket?: Socket | null,
  appTheme: ThemeValue = 'dark',
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
      convertEol: false,
      scrollback: clampedScrollback,
      cursorBlink: false, // Disable cursor blink
      disableStdin: inputMode === 'form', // Enable stdin for TTY mode
      // Dampen scroll aggressiveness
      fastScrollSensitivity: 1,
      scrollSensitivity: 1,
      theme: resolveTerminalTheme(appTheme).xtermTheme,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(terminalRef.current);

    // OSC 52 clipboard relay. Inner apps (e.g. Claude TUI) emit ESC]52;c;<base64>BEL.
    // tmux 3.x default (`set-clipboard external` + `terminal-features xterm*:clipboard`)
    // forwards these unchanged to xterm.js.
    terminal.parser.registerOscHandler(52, (data: string) => {
      const semi = data.indexOf(';');
      if (semi < 0) return false;
      const payload = data.slice(semi + 1);
      // "?" is a clipboard read query — refuse silently for security.
      if (payload === '?') return true;
      try {
        const text = decodeOsc52ClipboardPayload(payload);
        if (text && navigator.clipboard?.writeText) {
          void navigator.clipboard
            .writeText(text)
            .then(() => {
              const characterCount = Array.from(text).length;
              toast({
                title: 'Copied to clipboard',
                description: `${characterCount} character${characterCount === 1 ? '' : 's'} from the terminal`,
              });
            })
            .catch((err: unknown) => {
              const reason = err instanceof Error ? err.message : String(err);
              termLog('osc52_writeText_failed', { sessionId, reason, textLen: text.length });
              toast({
                title: 'Clipboard write blocked',
                description: `${reason} — focus the terminal and try again`,
                variant: 'destructive',
              });
            });
        }
      } catch {
        // malformed base64 — ignore
      }
      return true;
    });

    // Auto-copy on selection. xterm.js exposes only a highlight by default, and
    // Ctrl+C is forwarded to the TUI as an interrupt in TTY mode, so without
    // this the user's highlighted text never reaches the OS clipboard. The
    // debounce coalesces the many onSelectionChange events fired during a drag
    // so we write once when the selection settles.
    let selectionCopyTimer: ReturnType<typeof setTimeout> | undefined;
    let lastCopiedSelection = '';
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (selectionCopyTimer) clearTimeout(selectionCopyTimer);
      selectionCopyTimer = setTimeout(() => {
        const text = terminal.getSelection();
        if (!text || text === lastCopiedSelection) return;
        if (!navigator.clipboard?.writeText) return;
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            lastCopiedSelection = text;
          })
          .catch((err: unknown) => {
            const reason = err instanceof Error ? err.message : String(err);
            termLog('selection_copy_failed', { sessionId, reason, textLen: text.length });
          });
      }, 150);
    });

    // Detector state (was-at-bottom, in-cycle request latch, cooldown, last-visible position,
    // scroll-gesture intent) lives in this seam so both the onScroll and poll paths share one
    // decision and the re-show restore can reset it. See `scroll-history-detector.ts`.
    const detector = createScrollHistoryDetector();

    // Attach a custom wheel handler that respects TUI mouse tracking and dampens scrolling
    terminal.attachCustomWheelEventHandler((event) => {
      // When the TUI has mouse-tracking enabled, let xterm.js forward the wheel event
      // to the running application (e.g., vim, htop) instead of scrolling the buffer.
      // A wheel forwarded to a TUI is NOT a scrollback gesture and must not stamp intent.
      if (inputMode === 'tty' && supportsWheelMouseTracking(terminal.modes.mouseTrackingMode)) {
        return true;
      }
      if (!event.deltaY) return false;
      // Host-scroll path: a genuine wheel gesture on our scrollback. Stamp intent for the
      // upward direction (deltaY < 0) — that is the history-load direction — BEFORE
      // scrollLines, so the synchronous onScroll sees fresh intent.
      if (event.deltaY < 0) {
        detector.stampScrollIntent(Date.now());
      }
      event.preventDefault();
      // ~1–2 lines per notch depending on device delta
      const magnitude = Math.max(1, Math.round((Math.abs(event.deltaY) / 120) * 1.5));
      const lines = Math.sign(event.deltaY) * magnitude; // preserve direction, avoid rounding to 0
      terminal.scrollLines(lines);
      return false;
    });

    // Keyboard scroll intent: Shift+PageUp / Shift+PageDown are the only keys xterm uses to
    // scroll its own viewport (unmodified PageUp/PageDown and Home/End are sent to the shell as
    // key sequences). Capture phase is required — xterm scrolls synchronously in its own keydown
    // handler, so intent must exist before that scroll flips `wasAtBottom`. Passive + capture so
    // we observe without blocking xterm's handling.
    const container = terminalRef.current;
    const onScrollKeyDown = (event: KeyboardEvent) => {
      if (event.shiftKey && (event.code === 'PageUp' || event.code === 'PageDown')) {
        detector.stampScrollIntent(Date.now());
      }
    };
    container?.addEventListener('keydown', onScrollKeyDown, { capture: true, passive: true });

    // Scrollbar / touch drag intent. pointerdown on the viewport stamps intent; pointermove
    // refreshes it while the drag stays active so a slow scrollbar drag longer than the decay
    // window does not expire mid-drag. pointerup/cancel (listened on window to catch a release
    // anywhere) clear the active flag.
    const viewport = container?.querySelector<HTMLElement>('.xterm-viewport');
    let pointerDragActive = false;
    const onViewportPointerDown = () => {
      pointerDragActive = true;
      detector.stampScrollIntent(Date.now());
    };
    const onViewportPointerMove = () => {
      if (pointerDragActive) {
        detector.stampScrollIntent(Date.now());
      }
    };
    const onPointerUp = () => {
      pointerDragActive = false;
    };
    viewport?.addEventListener('pointerdown', onViewportPointerDown);
    viewport?.addEventListener('pointermove', onViewportPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

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

    // Add scroll handler for history loading.
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
        const visible = isTerminalContainerVisible(terminalRef.current);
        const inFlight = isHistoryInFlightRef?.current ?? false;

        const decision = detector.shouldRequestHistory({
          viewportY,
          baseY,
          visible,
          hasHistory: hasHistoryRef.current,
          inFlight,
          now: Date.now(),
        });

        // Only log interesting events (not every scroll tick during loading)
        if (decision.isLeavingBottom || decision.didResetOnReturn || decision.suppressed) {
          termLog('xterm_scroll_detected', {
            sessionId,
            viewportY,
            baseY,
            visible,
            isAtBottom: decision.isAtBottom,
            isLeavingBottom: decision.isLeavingBottom,
            suppressed: decision.suppressed,
            hasHistory: hasHistoryRef.current,
            cooldownActive: decision.cooldownActive,
            inFlight,
            source, // 'event' or 'poll'
          });
        }

        if (decision.shouldRequest) {
          // CRITICAL: Set in-flight flag BEFORE emitting request.
          // This ensures frames arriving after emit are buffered for deduplication.
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
        }

        if (decision.didResetOnReturn) {
          termLog('history_request_reset', {
            sessionId,
            reason: 'scrolled_to_bottom',
          });
        }
      };

      // Polling fallback: Detect viewport changes that onScroll misses.
      // This reliably catches all scroll changes from mouse wheel, scrollbar, etc.
      // It is also the continuous visibility observer: it feeds the detector every tick
      // (arming the pending-restore latch while hidden) and detects the hidden→visible edge
      // to schedule the deterministic re-show restore. NOT a new observer — the poll already
      // existed; we only widened what it reads.
      let lastViewportY = terminal.buffer.active.viewportY;
      let lastVisible: boolean | null = null;
      let reshowRestoreTimer: ReturnType<typeof setTimeout> | undefined;

      // Deterministic re-show restore. Ordering: InlineTerminalPanel re-show effect →
      // setTimeout(0) → fit() → settle (~300ms) → THIS restore. Running after fit + reflow
      // settle is load-bearing: xterm rewrites `.xterm-viewport` scrollTop from `ydisp` during
      // its refresh, so scrolling earlier can be clobbered. The restore overwrites any stale /
      // raced scrollTop corruption regardless of browser event ordering, then resets detector
      // state so a subsequent genuine scroll-up still loads history.
      const scheduleReshowRestore = () => {
        if (reshowRestoreTimer) return; // one restore per re-show
        reshowRestoreTimer = setTimeout(() => {
          reshowRestoreTimer = undefined;
          const xterm = xtermRef.current;
          if (!xterm) return;
          // If hidden again before the settle elapsed, leave the latch armed and let the next
          // re-show edge reschedule.
          if (!isTerminalContainerVisible(terminalRef.current)) return;

          fitAddonRef.current?.fit();

          const { wasAtBottom: restoreAtBottom, offsetFromBottom } = detector.getLastVisible();
          const activeBuffer = xterm.buffer.active;
          if (restoreAtBottom) {
            xterm.scrollToBottom();
          } else {
            xterm.scrollToLine(Math.max(0, activeBuffer.baseY - offsetFromBottom));
          }

          // Reset detector + poll baseline to the restored position so the restore scroll
          // itself is not mistaken for a user gesture on the next tick.
          detector.reset();
          lastViewportY = xterm.buffer.active.viewportY;

          termLog('reshow_viewport_restored', {
            sessionId,
            wasAtBottom: restoreAtBottom,
            offsetFromBottom,
            baseY: xterm.buffer.active.baseY,
            viewportY: lastViewportY,
          });
        }, RESHOW_RESTORE_SETTLE_MS);
      };

      // Try to use onScroll event (doesn't always fire reliably)
      scrollDisposable = terminal.onScroll(() => {
        const buffer = terminal.buffer.active;
        handleScrollChange(buffer.viewportY, buffer.baseY, 'event');
      });

      const pollInterval = setInterval(() => {
        const buffer = terminal.buffer.active;
        const currentViewportY = buffer.viewportY;

        // Feed visibility every tick (independent of viewport movement) and detect the
        // hidden→visible edge to schedule the restore.
        const visible = isTerminalContainerVisible(terminalRef.current);
        detector.observeVisibility(visible);
        if (visible && lastVisible === false) {
          scheduleReshowRestore();
        }
        lastVisible = visible;

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

      // Wrap disposal to clean up scroll listener, polling, and any pending restore.
      const originalDisposable = scrollDisposable;
      scrollDisposable = {
        dispose: () => {
          clearInterval(pollInterval);
          if (reshowRestoreTimer) clearTimeout(reshowRestoreTimer);
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
      if (selectionCopyTimer) clearTimeout(selectionCopyTimer);
      selectionDisposable.dispose();
      scrollDisposable?.dispose();
      container?.removeEventListener('keydown', onScrollKeyDown, { capture: true });
      viewport?.removeEventListener('pointerdown', onViewportPointerDown);
      viewport?.removeEventListener('pointermove', onViewportPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      termLog('terminal_dispose', { sessionId });
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
    isHistoryInFlightRef,
    pendingHistoryFramesRef,
    scrollbackLines,
    socket,
  ]);

  // Live theme update — runs independently of the initialization effect so
  // that switching the app theme does not dispose/recreate the terminal.
  useEffect(() => {
    if (!xtermRef.current) return;
    xtermRef.current.options.theme = resolveTerminalTheme(appTheme).xtermTheme;
  }, [appTheme, xtermRef]);
}
