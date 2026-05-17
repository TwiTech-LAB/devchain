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

function renderHistoryHarness(options?: {
  pendingFrames?: { sequence: number; data: string }[];
  cols?: number;
  rows?: number;
}) {
  const sessionId = 'test-session';
  const { result } = renderHook(() => {
    const terminalRef = { current: null } as React.RefObject<HTMLDivElement>;

    const mockTerminal: jest.Mocked<Terminal> = {
      write: jest.fn((data: string, cb?: () => void) => {
        if (cb) {
          setTimeout(cb, 0);
        }
      }),
      reset: jest.fn(),
      clear: jest.fn(),
      scrollToLine: jest.fn(),
      rows: options?.rows ?? 24,
      cols: options?.cols ?? 80,
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
    const isHistoryInFlightRef = useRef(true);
    const pendingHistoryFramesRef = useRef<{ sequence: number; data: string }[]>(
      options?.pendingFrames ?? [],
    );
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
      jest.fn(),
      jest.fn(),
      jest.fn(),
      jest.fn(),
      undefined,
      1000,
    );

    return { handler, mockTerminal };
  });

  return { sessionId, result };
}

describe('useTerminalMessageHandlers', () => {
  it('buffers data frames in pendingHistoryFramesRef while history request is in-flight', () => {
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
      const isLoadingHistoryRef = useRef(false);
      const historyViewportOffsetRef = useRef<number | null>(null);
      const isHistoryInFlightRef = useRef(true);
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
        queueOrWrite,
        handleSeedChunk,
        flushPendingWrites,
        setIgnoreWindow,
        undefined,
        1000,
      );

      return { handler, pendingHistoryFramesRef, lastSequenceRef };
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
    expect(result.current.pendingHistoryFramesRef.current).toEqual([{ sequence: 5, data: 'live' }]);
    expect(result.current.lastSequenceRef.current).toBe(5);
  });

  it('merges buffered frames after full history write completes (sequence-based dedup)', () => {
    jest.useFakeTimers();

    const sessionId = 'test-session';
    const setIgnoreWindow = jest.fn();

    const { result } = renderHook(() => {
      const terminalRef = { current: null } as React.RefObject<HTMLDivElement>;

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
      const isHistoryInFlightRef = useRef(true);
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
      const flushPendingWrites = jest.fn();

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
        isLoadingHistoryRef,
        isHistoryInFlightRef,
        pendingHistoryFramesRef,
        queueOrWrite,
        flushPendingWrites,
        setIgnoreWindow,
      };
    });

    // Simulate a buffered frame arriving before history response
    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'data',
        payload: { data: 'LIVE', sequence: 10 },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.pendingHistoryFramesRef.current).toEqual([
      { sequence: 10, data: 'LIVE' },
    ]);

    // History response arrives (capturedSequence: 5 means frames >5 are new)
    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: { history: 'HISTORY', capturedSequence: 5 },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.isLoadingHistoryRef.current).toBe(true);
    expect(result.current.mockTerminal.reset).toHaveBeenCalled();
    expect(result.current.mockTerminal.clear).toHaveBeenCalled();
    expect(result.current.mockTerminal.write).toHaveBeenCalledWith('HISTORY', expect.any(Function));

    // Complete the history write callback
    act(() => {
      jest.runOnlyPendingTimers();
    });

    // Buffered frame (sequence 10 > capturedSequence 5) should be merged
    expect(result.current.mockTerminal.write).toHaveBeenCalledWith('LIVE');
    expect(result.current.pendingHistoryFramesRef.current).toEqual([]);
    expect(result.current.isHistoryInFlightRef.current).toBe(false);
    expect(result.current.isLoadingHistoryRef.current).toBe(false);

    jest.useRealTimers();
  });

  it('restores captured cursor position after full history write before replaying buffered frames', () => {
    jest.useFakeTimers();

    const { sessionId, result } = renderHistoryHarness({
      pendingFrames: [{ sequence: 10, data: 'LIVE' }],
    });

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: { history: 'HISTORY', capturedSequence: 5, cursorX: 3, cursorY: 4 },
        ts: new Date().toISOString(),
      });
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    const writes = result.current.mockTerminal.write.mock.calls.map(([data]) => data);
    expect(writes).toEqual(['HISTORY', '\x1b[5;4H', 'LIVE']);

    jest.useRealTimers();
  });

  it('clamps captured cursor position to terminal bounds', () => {
    jest.useFakeTimers();

    const { sessionId, result } = renderHistoryHarness();

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: { history: 'HISTORY', capturedSequence: 5, cursorX: -5, cursorY: 999 },
        ts: new Date().toISOString(),
      });
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    const writes = result.current.mockTerminal.write.mock.calls.map(([data]) => data);
    expect(writes).toEqual(['HISTORY', '\x1b[24;1H']);

    jest.useRealTimers();
  });

  it('skips cursor restore when captured cursor position is invalid', () => {
    jest.useFakeTimers();

    const { sessionId, result } = renderHistoryHarness({
      pendingFrames: [{ sequence: 10, data: 'LIVE' }],
    });

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: {
          history: 'HISTORY',
          capturedSequence: 5,
          cursorX: Number.NaN,
          cursorY: Infinity,
        },
        ts: new Date().toISOString(),
      });
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    const writes = result.current.mockTerminal.write.mock.calls.map(([data]) => data);
    expect(writes).toEqual(['HISTORY', 'LIVE']);

    jest.useRealTimers();
  });
});
