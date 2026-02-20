import { forwardRef, useEffect, useImperativeHandle, useReducer, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Socket } from 'socket.io-client';
import { cn } from '@/ui/lib/utils';
import { Input } from '@/ui/components/ui/input';
import { Button } from '@/ui/components/ui/button';
import '@xterm/xterm/css/xterm.css';
import { termLog } from '@/ui/lib/debug';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { DEFAULT_TERMINAL_SCROLLBACK } from '@/common/constants/terminal';
import {
  useXterm,
  useTerminalResize,
  useTerminalSubscription,
  useSeedManager,
  useTerminalMessageHandlers,
  useTerminalFocus,
} from './hooks';
import { useScrollbackHistory } from './useScrollbackHistory';
import { connectionReducer } from './connectionReducer';
import { resolveTerminalSocket } from './socket';
import type { ChatTerminalProps } from './types';

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
  const fallbackSocketRef = useRef<Socket | null>(null);
  const isAuthorityRef = useRef<boolean>(false);
  const hasHistoryRef = useRef<boolean>(false);
  const isLoadingHistoryRef = useRef<boolean>(false);
  const isHistoryInFlightRef = useRef<boolean>(false);
  const pendingHistoryFramesRef = useRef<{ sequence: number; data: string }[]>([]);
  const lastCapturedSequenceRef = useRef<number>(0);
  const containerClassName = cn(
    'relative flex h-full min-h-0 w-full flex-col overflow-hidden text-terminal-foreground',
    chrome === 'none' ? 'bg-transparent' : 'rounded-xl border border-border bg-terminal shadow-sm',
    className,
  );
  const socket = _providedSocket
    ? _providedSocket
    : (() => {
        if (!fallbackSocketRef.current) {
          fallbackSocketRef.current = resolveTerminalSocket();
        }
        return fallbackSocketRef.current;
      })();

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
  const historyViewportOffsetRef = useRef<number | null>(null);

  // Subscription management
  const { lastSequenceRef, isSubscribedRef, expectingSeedRef, attemptSubscription } =
    useTerminalSubscription(sessionId, xtermRef, dispatchConn, socket);

  // Initialize xterm terminal with onReady callback that triggers subscription.
  // Defer creation until inputMode is loaded so we can honor the configured mode.
  useXterm(
    terminalRef,
    sessionId,
    xtermRef,
    fitAddonRef,
    attemptSubscription,
    inputMode,
    hasHistoryRef,
    isLoadingHistoryRef,
    historyViewportOffsetRef,
    isHistoryInFlightRef,
    pendingHistoryFramesRef,
    scrollbackLines,
    socket,
  );

  // Seed management
  const {
    seedStateRef,
    seedTimeoutRef,
    pendingWritesRef,
    queueOrWrite,
    handleSeedChunk,
    flushPendingWrites,
    setIgnoreWindow,
  } = useSeedManager(
    sessionId,
    xtermRef,
    fitAddonRef,
    dispatchConn,
    expectingSeedRef,
    hasHistoryRef,
    () => {
      setIsTerminalReady(true);
      // Auto-focus terminal after seed is ready
      xtermRef.current?.focus?.();
    },
    scrollbackLines,
    socket,
  );

  // Resize handling - pass expectingSeedRef to skip resize events during seed loading
  // Also pass hasHistoryRef to reset it after resize so user can reload history
  useTerminalResize(
    terminalRef,
    xtermRef,
    fitAddonRef,
    sessionId,
    expectingSeedRef,
    hasHistoryRef,
    socket,
  );

  // Scrollback history (container scroll fallback; xterm's internal scroll is handled in useXterm)
  useScrollbackHistory(
    terminalRef,
    sessionId,
    hasHistoryRef,
    isHistoryInFlightRef,
    scrollbackLines,
    socket,
  );

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
    hasHistoryRef,
    isLoadingHistoryRef,
    historyViewportOffsetRef,
    isHistoryInFlightRef,
    pendingHistoryFramesRef,
    lastCapturedSequenceRef,
    expectingSeedRef,
    seedStateRef,
    pendingWritesRef,
    queueOrWrite,
    handleSeedChunk,
    flushPendingWrites,
    setIgnoreWindow,
    onSessionEnded,
    scrollbackLines,
    socket,
  );

  // Socket connection and message handling
  useAppSocket(
    {
      connect: () => {
        dispatchConn({ type: 'SOCKET_CONNECT' });
        attemptSubscription();
      },
      disconnect: () => {
        termLog('socket_disconnect_event', { sessionId });
        dispatchConn({ type: 'SOCKET_DISCONNECT' });
        isSubscribedRef.current = false;
      },
      message: handleMessage,
    },
    [attemptSubscription, handleMessage, sessionId, isSubscribedRef],
    _providedSocket,
  );

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
      seedStateRef.current = null;
      pendingWritesRef.current = [];
      lastSequenceRef.current = 0;
      isAuthorityRef.current = false;
      expectingSeedRef.current = false;
      // Clean up history in-flight state
      isHistoryInFlightRef.current = false;
      pendingHistoryFramesRef.current = [];
      lastCapturedSequenceRef.current = 0;
    };
  }, [
    sessionId,
    isSubscribedRef,
    seedTimeoutRef,
    seedStateRef,
    pendingWritesRef,
    lastSequenceRef,
    expectingSeedRef,
    socket,
  ]);

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
            style={{ backgroundColor: '#1a1a1a' }}
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
