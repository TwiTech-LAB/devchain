import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { useTerminalMessageHandlers } from './useTerminalMessageHandlers';

jest.mock('@/ui/lib/debug', () => ({
  termLog: jest.fn(),
}));

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: () => ({ emit: jest.fn(), id: 'test-socket-id' }),
}));

describe('useTerminalMessageHandlers', () => {
  it('queues data frames while full history is loading', () => {
    const sessionId = 'test-session';
    const queueOrWrite = jest.fn();
    const flushPendingWrites = jest.fn();
    const handleSeedChunk = jest.fn();
    const setIgnoreWindow = jest.fn();

    const { result } = renderHook(() => {
      const terminalRef = { current: null } as React.RefObject<HTMLDivElement>;
      const xtermRef = useRef<Terminal | null>(null);
      const fitAddonRef = useRef<FitAddon | null>(null);
      const lastSequenceRef = useRef(0);
      const isAuthorityRef = useRef(false);
      const isSubscribedRef = useRef(true);
      const hasHistoryRef = useRef(false);
      const isLoadingHistoryRef = useRef(true);
      const historyViewportOffsetRef = useRef<number | null>(null);
      const isHistoryInFlightRef = useRef(false); // Not in-flight, but loading
      const pendingHistoryFramesRef = useRef<{ sequence: number; data: string }[]>([]);
      const lastCapturedSequenceRef = useRef(0);
      const expectingSeedRef = useRef(false);
      const seedStateRef = useRef<{
        totalChunks: number;
        chunks: string[];
        receivedChunks: Set<number>;
        cols?: number;
        rows?: number;
        cursorX?: number;
        cursorY?: number;
      } | null>(null);
      const pendingWritesRef = useRef<string[]>([]);

      const handler = useTerminalMessageHandlers(
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
        undefined,
        1000,
      );

      return { handler, pendingWritesRef, lastSequenceRef };
    });

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'data',
        payload: { data: 'live', sequence: 5 },
        ts: new Date().toISOString(),
      });
    });

    expect(queueOrWrite).not.toHaveBeenCalled();
    expect(result.current.pendingWritesRef.current).toEqual(['live']);
    expect(result.current.lastSequenceRef.current).toBe(5);
  });

  it('clears queued frames after full history write completes (does not flush to avoid duplicates)', () => {
    jest.useFakeTimers();

    const sessionId = 'test-session';
    const setIgnoreWindow = jest.fn();

    const { result } = renderHook(() => {
      const terminalRef = { current: null } as React.RefObject<HTMLDivElement>;
      const pendingWritesRef = useRef<string[]>([]);

      const mockTerminal: jest.Mocked<Terminal> = {
        write: jest.fn((data: string, cb?: () => void) => {
          if (cb) {
            setTimeout(cb, 0);
          }
        }),
        reset: jest.fn(),
        clear: jest.fn(),
        scrollToLine: jest.fn(),
        rows: 24,
        cols: 80,
        options: { scrollback: 1000 },
        buffer: { active: { baseY: 50, viewportY: 40 } },
      } as unknown as jest.Mocked<Terminal>;

      const xtermRef = useRef<Terminal | null>(mockTerminal);
      const fitAddonRef = useRef<FitAddon | null>(null);
      const lastSequenceRef = useRef(0);
      const isAuthorityRef = useRef(false);
      const isSubscribedRef = useRef(true);
      const hasHistoryRef = useRef(false);
      const isLoadingHistoryRef = useRef(false);
      const historyViewportOffsetRef = useRef<number | null>(10);
      const isHistoryInFlightRef = useRef(false);
      const pendingHistoryFramesRef = useRef<{ sequence: number; data: string }[]>([]);
      const lastCapturedSequenceRef = useRef(0);
      const expectingSeedRef = useRef(false);
      const seedStateRef = useRef<{
        totalChunks: number;
        chunks: string[];
        receivedChunks: Set<number>;
        cols?: number;
        rows?: number;
        cursorX?: number;
        cursorY?: number;
      } | null>(null);

      const queueOrWrite = jest.fn();
      const handleSeedChunk = jest.fn();
      const flushPendingWrites = jest.fn(() => {
        if (pendingWritesRef.current.length === 0) return;
        const combined = pendingWritesRef.current.join('');
        mockTerminal.write(combined);
        pendingWritesRef.current = [];
      });

      const handler = useTerminalMessageHandlers(
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
        undefined,
        1000,
      );

      return {
        handler,
        mockTerminal,
        pendingWritesRef,
        isLoadingHistoryRef,
        isHistoryInFlightRef,
        pendingHistoryFramesRef,
        queueOrWrite,
        flushPendingWrites,
        setIgnoreWindow,
      };
    });

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: { history: 'HISTORY' },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.isLoadingHistoryRef.current).toBe(true);
    expect(result.current.mockTerminal.reset).toHaveBeenCalled();
    expect(result.current.mockTerminal.clear).toHaveBeenCalled();
    expect(result.current.mockTerminal.write).toHaveBeenCalledWith('HISTORY', expect.any(Function));

    // While history write is in-flight, live frames should be queued.
    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'data',
        payload: { data: 'LIVE' },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.queueOrWrite).not.toHaveBeenCalled();
    expect(result.current.pendingWritesRef.current).toEqual(['LIVE']);

    // Complete the history write callback.
    act(() => {
      jest.runOnlyPendingTimers();
    });

    // Pending writes are CLEARED but NOT flushed (to avoid duplicates).
    // The tmux history already contains all data up to capture time.
    expect(result.current.flushPendingWrites).not.toHaveBeenCalled();
    expect(result.current.pendingWritesRef.current).toEqual([]);
    expect(result.current.isLoadingHistoryRef.current).toBe(false);

    // Verify 'LIVE' was NOT written (only 'HISTORY' was written)
    expect(result.current.mockTerminal.write).toHaveBeenCalledTimes(1);
    expect(result.current.mockTerminal.write).toHaveBeenCalledWith('HISTORY', expect.any(Function));

    // With Option A, we don't set ignore window after history load
    // (we want TUI to continue receiving data)

    jest.useRealTimers();
  });
});
