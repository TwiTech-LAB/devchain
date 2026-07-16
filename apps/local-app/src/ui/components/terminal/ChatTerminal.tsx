import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { cn } from '@/ui/lib/utils';
import { Input } from '@/ui/components/ui/input';
import { Button } from '@/ui/components/ui/button';
import '@xterm/xterm/css/xterm.css';
import { termLog } from '@/ui/lib/debug';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppTheme } from '@/ui/hooks/useAppTheme';
import { DEFAULT_TERMINAL_SCROLLBACK } from '@/common/constants/terminal';
import {
  useXterm,
  useTerminalResize,
  useTerminalSubscription,
  useSeedManager,
  useTerminalMessageHandlers,
  useTerminalFocus,
  useTerminalThemeSync,
  useTerminalWritePump,
} from './hooks';
import { connectionReducer } from './connectionReducer';
import { createTerminalHistorySync } from './terminal-history-sync';
import type { TerminalHistorySync } from './terminal-history-sync';
import type { ScrollIntentController } from './scroll-intent-binding';
import { resolveTerminalTheme } from './terminal-themes';
import { normalizeTerminalEnvelopeForTheme } from './terminal-output-theme';
import type { ChatTerminalProps } from './types';
import type {
  TerminalResyncAbortPayload,
  TerminalResyncCompletePayload,
  TerminalResyncRequestPayload,
} from '@/modules/terminal/dtos/ws-envelope.dto';

const RECOVERY_ABORT_ACK_TIMEOUT_MS = 5000;

export interface ChatTerminalHandle {
  clear: () => void;
  focus: () => void;
  fit: () => void;
}

export const ChatTerminal = forwardRef<ChatTerminalHandle, ChatTerminalProps>(function ChatTerminal(
  {
    sessionId,
    socket: _providedSocket,
    className,
    chrome = 'default',
    ariaLabel = 'Agent terminal',
    onSessionEnded,
  }: ChatTerminalProps,
  ref,
) {
  const appTheme = useAppTheme();
  const [input, setInput] = useState<string>('');
  const [inputMode, setInputMode] = useState<'form' | 'tty' | null>(null); // null = loading
  const [scrollbackLines, setScrollbackLines] = useState<number>(DEFAULT_TERMINAL_SCROLLBACK); // Default until loaded
  const [isTerminalReady, setIsTerminalReady] = useState(false);
  const [conn, dispatchConn] = useReducer(connectionReducer, {
    status: 'connecting',
    srAnnouncement: 'Connecting to terminal…',
  });

  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAuthorityRef = useRef<boolean>(false);
  const isLoadingHistoryRef = useRef<boolean>(false);
  const isHistoryInFlightRef = useRef<boolean>(false);
  const pendingHistoryFramesRef = useRef<{ sequence: number; data: string }[]>([]);
  // Single owner of the history-refresh lifecycle: provider refresh capability, phase/readiness,
  // per-snapshot has-more, nullable accepted baseline, latest-observed sequence, active attempt.
  const historySyncRef = useRef<TerminalHistorySync | null>(null);
  if (!historySyncRef.current) historySyncRef.current = createTerminalHistorySync();
  const historySync = historySyncRef.current;
  const containerClassName = cn(
    'relative flex h-full min-h-0 w-full flex-col overflow-hidden text-terminal-foreground',
    chrome === 'none' ? 'bg-transparent' : 'rounded-xl border border-border bg-terminal shadow-sm',
    className,
  );
  const socket = useAppSocket({}, [], _providedSocket);

  // Fetch terminal settings BEFORE mounting terminal
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((json) => {
        // Input mode
        const mode = json?.terminal?.inputMode;
        if (mode === 'form' || mode === 'tty') {
          setInputMode(mode);
        } else {
          setInputMode('form'); // Default
        }

        // Scrollback lines
        const scrollback = json?.terminal?.scrollbackLines;
        if (typeof scrollback === 'number' && scrollback > 0) {
          setScrollbackLines(scrollback);
        }
      })
      .catch((error) => {
        console.warn('Failed to fetch terminal settings:', error);
        setInputMode('form'); // Default on error
      });
  }, []);

  // Create refs that will be shared between hooks
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pendingResyncSequenceRef = useRef<number | null>(null);
  const recoveryAbortAckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Task 1 scrollbar-drag lifecycle controller (set by useXterm on terminal create/recreate). The
  // message handler reads it to defer a full_history apply until a drag has fully ended.
  const scrollIntentControllerRef = useRef<ScrollIntentController | null>(null);
  // Populated by the message handler; invalidates a history response deferred on a controller that
  // is about to be swapped/nulled (its drag-end can then never fire).
  const invalidateDeferredHistoryRef = useRef<(() => void) | null>(null);
  const setScrollIntentController = useCallback((controller: ScrollIntentController | null) => {
    const previous = scrollIntentControllerRef.current;
    scrollIntentControllerRef.current = controller;
    // A terminal recreate/dispose swaps or nulls the drag controller. Any response deferred on the
    // previous controller can no longer receive its drag-end, so invalidate it now instead of
    // stranding the active attempt + in-flight buffer.
    if (previous && previous !== controller) {
      invalidateDeferredHistoryRef.current?.();
    }
  }, []);

  // Subscription management
  const { lastSequenceRef, isSubscribedRef, expectingSeedRef, attemptSubscription } =
    useTerminalSubscription(sessionId, xtermRef, dispatchConn, historySync, socket);

  // Theme sync: emits terminal:theme after subscribe confirmation and on theme changes
  const { notifySubscribed } = useTerminalThemeSync(sessionId, appTheme, isSubscribedRef, socket);

  const handleWriteOverflow = useCallback(() => {
    expectingSeedRef.current = true;
    pendingResyncSequenceRef.current = null;
    dispatchConn({ type: 'SEED_START' });
    const payload = {
      sessionId,
      reason: 'client_write_overflow',
    } satisfies TerminalResyncRequestPayload;
    socket.emit('terminal:resync_request', payload);
  }, [expectingSeedRef, pendingResyncSequenceRef, sessionId, socket]);
  const writePump = useTerminalWritePump(xtermRef, handleWriteOverflow);

  const forceCleanRecoveryReconnect = useCallback(() => {
    if (recoveryAbortAckTimeoutRef.current) {
      clearTimeout(recoveryAbortAckTimeoutRef.current);
      recoveryAbortAckTimeoutRef.current = null;
    }
    pendingResyncSequenceRef.current = null;
    lastSequenceRef.current = 0;
    expectingSeedRef.current = true;
    isSubscribedRef.current = false;
    // Invalidate any active history attempt and drop its unapplied buffer before reconnect.
    historySync.invalidateAttempt();
    historySync.suspend();
    isHistoryInFlightRef.current = false;
    isLoadingHistoryRef.current = false;
    pendingHistoryFramesRef.current = [];
    setIsTerminalReady(false);
    writePump.setTerminal(null);
    writePump.setTerminal(xtermRef.current);
    socket.disconnect();
    socket.connect();
  }, [expectingSeedRef, historySync, isSubscribedRef, lastSequenceRef, socket, writePump]);

  const handleRecoveryTimeout = useCallback(
    (abort: TerminalResyncAbortPayload, retryAllowed: boolean) => {
      if (!retryAllowed || !socket.connected) {
        forceCleanRecoveryReconnect();
        return;
      }

      let settled = false;
      const settleAbort = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        if (recoveryAbortAckTimeoutRef.current) {
          clearTimeout(recoveryAbortAckTimeoutRef.current);
          recoveryAbortAckTimeoutRef.current = null;
        }
        if (accepted !== true) {
          forceCleanRecoveryReconnect();
          return;
        }
        const request = {
          sessionId,
          reason: 'client_write_overflow',
        } satisfies TerminalResyncRequestPayload;
        socket.emit('terminal:resync_request', request);
      };

      recoveryAbortAckTimeoutRef.current = setTimeout(
        () => settleAbort(false),
        RECOVERY_ABORT_ACK_TIMEOUT_MS,
      );
      socket.emit('terminal:resync_abort', abort, settleAbort);
    },
    [forceCleanRecoveryReconnect, sessionId, socket],
  );

  // Initialize xterm terminal with onReady callback that triggers subscription.
  // Defer creation until inputMode is loaded so we can honor the configured mode.
  useXterm(
    terminalRef,
    sessionId,
    xtermRef,
    fitAddonRef,
    attemptSubscription,
    inputMode,
    historySync,
    isSubscribedRef,
    isLoadingHistoryRef,
    isHistoryInFlightRef,
    pendingHistoryFramesRef,
    scrollbackLines,
    socket,
    appTheme,
    writePump.setTerminal,
    setScrollIntentController,
  );

  // Seed management
  const {
    seedStateRef,
    seedTimeoutRef,
    queueOrWrite,
    prepareForResync,
    handleSeedChunk,
    handleSeedEmpty,
    flushPendingWrites,
    setIgnoreWindow,
    resetRecoveryTimeoutEpisode,
    resetRecoveryDomain,
  } = useSeedManager(
    sessionId,
    xtermRef,
    fitAddonRef,
    dispatchConn,
    expectingSeedRef,
    historySync,
    () => {
      setIsTerminalReady(true);
      // Auto-focus terminal after seed is ready
      xtermRef.current?.focus?.();
      // Post-seed viewport-mode restore: the seed (capture-pane) replays cells but NOT DEC
      // private modes, and any redraw emitted DURING seed was discarded. Now that the seed
      // has settled (frames hit the normal write path), ask the server to re-emit alt-screen
      // + mouse modes. Server-gated on the provider's alt-screen policy → no-op for non-TUI
      // providers. Confined to the seed-ready hook; the wheel-forward gate is untouched.
      if (socket.connected) {
        socket.emit('terminal:restore_viewport_modes', { sessionId });
      }
    },
    scrollbackLines,
    writePump,
    (payload) => {
      lastSequenceRef.current = payload.capturedSequence;
      pendingResyncSequenceRef.current = null;
      const completion = {
        sessionId,
        sequenceEpoch: payload.sequenceEpoch,
        recoveryEpoch: payload.recoveryEpoch,
        capturedSequence: payload.capturedSequence,
      } satisfies TerminalResyncCompletePayload;
      socket.emit('terminal:resync_complete', completion);
    },
    handleRecoveryTimeout,
    (payload) => {
      // seed_empty is a successful non-writing replacement: its capture watermark is the
      // highest sequence already represented by the preserved terminal rows.
      lastSequenceRef.current = payload.capturedSequence;
    },
  );

  // Resize handling - pass expectingSeedRef to skip resize events during seed loading.
  // hasHistoryRef is intentionally NOT passed: the seed and full_history handlers own that flag.
  useTerminalResize(terminalRef, xtermRef, fitAddonRef, sessionId, expectingSeedRef, socket);

  // Focus handling
  useTerminalFocus(containerRef, sessionId, isSubscribedRef, socket);

  // Message handling
  const handleMessage = useTerminalMessageHandlers(
    sessionId,
    terminalRef,
    xtermRef,
    fitAddonRef,
    lastSequenceRef,
    isAuthorityRef,
    isSubscribedRef,
    historySync,
    isLoadingHistoryRef,
    isHistoryInFlightRef,
    pendingHistoryFramesRef,
    expectingSeedRef,
    pendingResyncSequenceRef,
    seedStateRef,
    prepareForResync,
    queueOrWrite,
    handleSeedChunk,
    handleSeedEmpty,
    flushPendingWrites,
    setIgnoreWindow,
    onSessionEnded,
    scrollbackLines,
    socket,
    notifySubscribed,
    writePump,
    resetRecoveryDomain,
    scrollIntentControllerRef,
    invalidateDeferredHistoryRef,
  );

  // Socket connection and message handling
  useEffect(() => {
    const handlers = {
      connect: () => {
        dispatchConn({ type: 'SOCKET_CONNECT' });
        attemptSubscription();
      },
      disconnect: () => {
        termLog('socket_disconnect_event', { sessionId });
        dispatchConn({ type: 'SOCKET_DISCONNECT' });
        isSubscribedRef.current = false;
        // Invalidate any active history attempt and drop its unapplied buffer before reconnect
        // work, so a late full_history from the dead socket cannot touch the pump or baseline.
        historySync.invalidateAttempt();
        historySync.suspend();
        isHistoryInFlightRef.current = false;
        isLoadingHistoryRef.current = false;
        pendingHistoryFramesRef.current = [];
        resetRecoveryTimeoutEpisode();
      },
      message: (envelope: WsEnvelope) =>
        handleMessage(normalizeTerminalEnvelopeForTheme(envelope, appTheme)),
    };
    for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
    return () => {
      for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
    };
  }, [
    attemptSubscription,
    handleMessage,
    sessionId,
    isSubscribedRef,
    appTheme,
    historySync,
    resetRecoveryTimeoutEpisode,
    socket,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      termLog('terminal_dispose_complete_cleanup', { sessionId });
      if (socket.connected && isSubscribedRef.current) {
        socket.emit('terminal:unsubscribe', { sessionId });
      }
      isSubscribedRef.current = false;
      if (seedTimeoutRef.current) {
        clearTimeout(seedTimeoutRef.current);
        seedTimeoutRef.current = null;
      }
      if (recoveryAbortAckTimeoutRef.current) {
        clearTimeout(recoveryAbortAckTimeoutRef.current);
        recoveryAbortAckTimeoutRef.current = null;
      }
      seedStateRef.current = null;
      lastSequenceRef.current = 0;
      isAuthorityRef.current = false;
      expectingSeedRef.current = false;
      pendingResyncSequenceRef.current = null;
      // Clean up history in-flight state
      isHistoryInFlightRef.current = false;
      pendingHistoryFramesRef.current = [];
      historySync.reset();
    };
  }, [
    sessionId,
    isSubscribedRef,
    seedTimeoutRef,
    seedStateRef,
    lastSequenceRef,
    expectingSeedRef,
    pendingResyncSequenceRef,
    historySync,
    socket,
  ]);

  // Reset the history-refresh owner when the session changes so a prior session's capability,
  // baseline, and active attempt never leak into a new one. Runs before the new subscribe/seed.
  useEffect(() => {
    historySync.reset();
  }, [sessionId, historySync]);

  // Expose imperative handle for terminal operations
  useImperativeHandle(
    ref,
    () => ({
      clear: () => {
        xtermRef.current?.reset();
        xtermRef.current?.clear();
      },
      focus: () => {
        xtermRef.current?.focus?.();
      },
      fit: () => {
        fitAddonRef.current?.fit();
      },
    }),
    [],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !socket.connected) return;
    socket.emit('terminal:input', { sessionId, data: input });
    setInput('');
    inputRef.current?.focus();
  };

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={ariaLabel}
      data-terminal-status={
        conn.status === 'subscribing' || conn.status === 'seeding' ? 'connected' : conn.status
      }
      className={containerClassName}
    >
      <span className="sr-only" aria-live="polite">
        {conn.srAnnouncement}
      </span>
      <div className="relative flex-1 min-h-0">
        <div
          ref={terminalRef}
          className="h-full overflow-auto"
          {...((inputMode ?? 'form') === 'form' && { 'data-radix-scroll-area-viewport': '' })}
        />
        {/* Overlay to hide terminal flickering during seed/jiggle */}
        {!isTerminalReady && (
          <div
            className="absolute inset-0 z-10"
            style={{ backgroundColor: resolveTerminalTheme(appTheme).xtermTheme.background }}
            aria-hidden="true"
          />
        )}
      </div>
      {inputMode === 'form' && (
        <div className="border-t border-border bg-terminal/80 px-2 py-1.5">
          <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
            <Input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type command..."
              autoFocus
              className="font-mono text-xs h-7 px-2"
            />
            <Button
              type="submit"
              disabled={!socket.connected || input.trim().length === 0}
              size="sm"
              className="h-7 px-3 text-xs"
            >
              Send
            </Button>
          </form>
        </div>
      )}
    </div>
  );
});
