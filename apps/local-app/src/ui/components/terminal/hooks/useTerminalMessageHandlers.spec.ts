import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { useTerminalMessageHandlers } from './useTerminalMessageHandlers';
import { createTerminalHistorySync, type TerminalHistorySync } from '../terminal-history-sync';
import type { ScrollIntentController, ScrollDragEndReason } from '../scroll-intent-binding';

/** Minimal scriptable drag controller: toggle `active`, then fire `end` to run drag-end listeners. */
function makeDragController(): ScrollIntentController & {
  active: boolean;
  end: (reason?: ScrollDragEndReason) => void;
} {
  const listeners = new Set<(reason: ScrollDragEndReason) => void>();
  return {
    active: false,
    isDragActive() {
      return this.active;
    },
    onDragEnd(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
    },
    end(reason: ScrollDragEndReason = 'pointerup') {
      this.active = false;
      for (const listener of [...listeners]) listener(reason);
    },
  };
}

jest.mock('@/ui/lib/debug', () => ({
  termLog: jest.fn(),
}));

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: () => ({ emit: jest.fn(), id: 'test-socket-id' }),
}));

interface HarnessOptions {
  pendingFrames?: { sequence: number; data: string }[];
  cols?: number;
  rows?: number;
  inFlight?: boolean;
  expectingSeed?: boolean;
  /** Seed the owner into a settled, refreshable, given-baseline state before the test acts. */
  primeOwner?: (sync: TerminalHistorySync) => void;
  /** Open an active attempt so full_history is accepted; the token is returned as `token`. */
  withActiveAttempt?: boolean;
  /** Provide a scriptable scrollbar-drag controller (for drag-deferred history tests). */
  dragController?: ScrollIntentController | null;
  /** Initial session id; change it via the returned `rerender` to exercise session-change cleanup. */
  sessionId?: string;
}

function makeMockTerminal(options?: HarnessOptions): jest.Mocked<Terminal> {
  return {
    write: jest.fn((data: string, cb?: () => void) => {
      if (cb) setTimeout(cb, 0);
    }),
    reset: jest.fn(),
    clear: jest.fn(),
    scrollToLine: jest.fn(),
    rows: options?.rows ?? 24,
    cols: options?.cols ?? 80,
    options: { scrollback: 1000 },
    buffer: { active: { baseY: 50, viewportY: 40 } },
  } as unknown as jest.Mocked<Terminal>;
}

function renderHarness(options?: HarnessOptions) {
  const initialSessionId = options?.sessionId ?? 'test-session';
  const handleSeedEmpty = jest.fn();
  const queueOrWrite = jest.fn();
  const { result, unmount, rerender } = renderHook(
    ({ sessionId }: { sessionId: string }) => {
      const terminalRef = { current: null } as React.RefObject<HTMLDivElement>;
      const mockTerminal = makeMockTerminal(options);

      const xtermRef = useRef<Terminal | null>(mockTerminal);
      const fitAddonRef = useRef<FitAddon | null>(null);
      const lastSequenceRef = useRef(0);
      const isAuthorityRef = useRef(false);
      const isSubscribedRef = useRef(true);
      const isLoadingHistoryRef = useRef(false);
      const isHistoryInFlightRef = useRef(options?.inFlight ?? false);
      const pendingHistoryFramesRef = useRef<{ sequence: number; data: string }[]>(
        options?.pendingFrames ?? [],
      );
      const expectingSeedRef = useRef(options?.expectingSeed ?? false);
      const pendingResyncSequenceRef = useRef<number | null>(null);
      const seedStateRef = useRef<{
        totalChunks: number;
        chunks: string[];
        receivedChunks: Set<number>;
      } | null>(null);
      const historySyncRef = useRef<TerminalHistorySync | null>(null);
      if (!historySyncRef.current) {
        historySyncRef.current = createTerminalHistorySync();
        options?.primeOwner?.(historySyncRef.current);
      }
      const historySync = historySyncRef.current;
      const tokenRef = useRef<string | undefined>(undefined);
      if (options?.withActiveAttempt && tokenRef.current === undefined) {
        tokenRef.current = historySync.beginAttempt();
      }

      const prepareForResync = jest.fn();
      const resetRecoveryDomain = jest.fn();
      const scrollIntentControllerRef = useRef<ScrollIntentController | null>(
        options?.dragController ?? null,
      );
      const deferredHistoryInvalidateRef = useRef<(() => void) | null>(null);
      const handler = useTerminalMessageHandlers(
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
        jest.fn(),
        handleSeedEmpty,
        jest.fn(),
        jest.fn(),
        undefined,
        1000,
        undefined, // socket
        undefined, // onSubscribed
        undefined, // providedWritePump
        resetRecoveryDomain,
        scrollIntentControllerRef,
        deferredHistoryInvalidateRef,
      );

      return {
        handler,
        mockTerminal,
        lastSequenceRef,
        isLoadingHistoryRef,
        isHistoryInFlightRef,
        pendingHistoryFramesRef,
        pendingResyncSequenceRef,
        prepareForResync,
        historySync,
        handleSeedEmpty,
        queueOrWrite,
        resetRecoveryDomain,
        scrollIntentControllerRef,
        deferredHistoryInvalidateRef,
        token: tokenRef.current,
      };
    },
    { initialProps: { sessionId: initialSessionId } },
  );

  return { sessionId: initialSessionId, result, unmount, rerender };
}

describe('useTerminalMessageHandlers', () => {
  it('adopts historyRefreshable from the subscribed ack (first-non-undefined-wins)', () => {
    const { sessionId, result } = renderHarness();

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'subscribed',
        payload: { currentSequence: 3, replayStatus: 'seed', historyRefreshable: true },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.historySync.isRefreshable()).toBe(true);
  });

  it('settles the owner on a covered reconnect (not expecting seed)', () => {
    const { sessionId, result } = renderHarness({ expectingSeed: false });

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'subscribed',
        payload: { currentSequence: 9, replayStatus: 'covered', historyRefreshable: true },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.historySync.isSettled()).toBe(true);
  });

  it('does NOT settle on a gap reconnect (stays unsettled until recovery)', () => {
    const { sessionId, result } = renderHarness({ expectingSeed: false });

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'subscribed',
        payload: { currentSequence: 9, replayStatus: 'gap', historyRefreshable: true },
        ts: new Date().toISOString(),
      });
    });

    // A gapped reconnect is not history-ready; the following resync_required drives recovery.
    expect(result.current.historySync.isSettled()).toBe(false);
    expect(
      result.current.historySync.isRequestEligible({ connected: true, subscribed: true }),
    ).toBe(false);
  });

  it('does not adopt the server sequence on a replay gap', () => {
    const { sessionId, result } = renderHarness();
    result.current.lastSequenceRef.current = 42;

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'subscribed',
        payload: { currentSequence: 150, replayStatus: 'gap' },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.lastSequenceRef.current).toBe(42);
  });

  it('recovery invalidation preserves the pre-attempt applied watermark for reconnect replay', () => {
    const { sessionId, result } = renderHarness({ inFlight: true, withActiveAttempt: true });
    // The last APPLIED sequence before the history attempt.
    result.current.lastSequenceRef.current = 42;

    // A newer live frame arrives during the in-flight history load: it buffers (unapplied),
    // so it must not advance the applied watermark.
    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'data',
        payload: { data: 'newer', sequence: 55 },
        ts: new Date().toISOString(),
      });
    });
    expect(result.current.lastSequenceRef.current).toBe(42);
    expect(result.current.pendingHistoryFramesRef.current).toEqual([
      { sequence: 55, data: 'newer' },
    ]);

    // Recovery supersedes the active history attempt.
    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'resync_required',
        payload: { currentSequence: 150 },
        ts: new Date().toISOString(),
      });
    });

    // The active attempt and its unapplied buffer are invalidated…
    expect(result.current.historySync.hasActiveAttempt()).toBe(false);
    expect(result.current.isHistoryInFlightRef.current).toBe(false);
    expect(result.current.pendingHistoryFramesRef.current).toEqual([]);
    expect(result.current.pendingResyncSequenceRef.current).toBe(150);
    expect(result.current.prepareForResync).toHaveBeenCalledTimes(1);
    // …but the pre-attempt applied watermark is preserved (NOT rewound to 0 or to the
    // buffered-but-unapplied frame). A subsequent reconnect resumes replay from here; the
    // recovery completion path later replaces it with the applied capturedSequence.
    expect(result.current.lastSequenceRef.current).toBe(42);
  });

  it('routes seed_empty to the empty-completion handler', () => {
    const { sessionId, result } = renderHarness();

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'seed_empty',
        payload: { capturedSequence: 0 },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.handleSeedEmpty).toHaveBeenCalledWith({ capturedSequence: 0 });
  });

  it('buffers in-flight frames without advancing the reconnect watermark, but advances latest-observed', () => {
    const { sessionId, result } = renderHarness({ inFlight: true, withActiveAttempt: true });

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'data',
        payload: { data: 'live', sequence: 5 },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.queueOrWrite).not.toHaveBeenCalled();
    expect(result.current.pendingHistoryFramesRef.current).toEqual([{ sequence: 5, data: 'live' }]);
    // Buffered (unapplied) frame must NOT advance the reconnect watermark…
    expect(result.current.lastSequenceRef.current).toBe(0);
    // …but it MUST advance latest-observed so a dirty check can see newer output.
    expect(result.current.historySync.getLatestObservedSequence()).toBe(5);
  });

  it('advances latest-observed even while expecting a seed (watermark stays suppressed)', () => {
    const { sessionId, result } = renderHarness({ expectingSeed: true });

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'data',
        payload: { data: 'x', sequence: 8 },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.historySync.getLatestObservedSequence()).toBe(8);
    expect(result.current.lastSequenceRef.current).toBe(0);
  });

  it('drops a stale/unmatched full_history before any side effect', () => {
    jest.useFakeTimers();
    const { sessionId, result } = renderHarness({
      inFlight: true,
      pendingFrames: [{ sequence: 10, data: 'LIVE' }],
      withActiveAttempt: true,
    });

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        // Wrong token — belongs to no active attempt (or a superseded one).
        payload: { history: 'HISTORY', capturedSequence: 5, correlationId: 'not-the-token' },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.mockTerminal.write).not.toHaveBeenCalled();
    expect(result.current.mockTerminal.reset).not.toHaveBeenCalled();
    // The newer attempt's state is untouched.
    expect(result.current.isHistoryInFlightRef.current).toBe(true);
    expect(result.current.pendingHistoryFramesRef.current).toEqual([
      { sequence: 10, data: 'LIVE' },
    ]);
    expect(result.current.historySync.hasActiveAttempt()).toBe(true);

    jest.useRealTimers();
  });

  it('merges buffered frames, commits the baseline, and advances the watermark on completion', () => {
    jest.useFakeTimers();
    const { sessionId, result } = renderHarness({
      inFlight: true,
      pendingFrames: [{ sequence: 10, data: 'LIVE' }],
      withActiveAttempt: true,
    });
    const token = result.current.token;

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: { history: 'HISTORY', capturedSequence: 5, correlationId: token },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.isLoadingHistoryRef.current).toBe(true);
    expect(result.current.mockTerminal.reset).toHaveBeenCalled();
    expect(result.current.mockTerminal.write).toHaveBeenCalledWith('HISTORY', expect.any(Function));

    act(() => {
      jest.runAllTimers();
    });

    expect(result.current.mockTerminal.write).toHaveBeenCalledWith('LIVE', expect.any(Function));
    expect(result.current.pendingHistoryFramesRef.current).toEqual([]);
    expect(result.current.isHistoryInFlightRef.current).toBe(false);
    expect(result.current.isLoadingHistoryRef.current).toBe(false);
    // Baseline commits to the highest applied sequence (tail frame 10 > capture 5); the
    // reconnect watermark advances to the same highest-applied point; the attempt closes.
    expect(result.current.historySync.getAcceptedSnapshotSequence()).toBe(10);
    expect(result.current.lastSequenceRef.current).toBe(10);
    expect(result.current.historySync.hasActiveAttempt()).toBe(false);
    expect(result.current.historySync.isDirty()).toBe(false);

    jest.useRealTimers();
  });

  it('skips a matched response that carries no new data and no buffered tail', () => {
    jest.useFakeTimers();
    const { sessionId, result } = renderHarness({
      inFlight: true,
      withActiveAttempt: true,
      primeOwner: (sync) => sync.commitBaseline(20),
    });
    const token = result.current.token;

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: { history: 'HISTORY', capturedSequence: 15, correlationId: token },
        ts: new Date().toISOString(),
      });
    });

    // capturedSequence (15) <= baseline (20), no buffered frames → no destructive rewrite.
    expect(result.current.mockTerminal.write).not.toHaveBeenCalled();
    expect(result.current.isHistoryInFlightRef.current).toBe(false);
    expect(result.current.historySync.hasActiveAttempt()).toBe(false);

    jest.useRealTimers();
  });

  it('never pins snapshotHasMore true — it follows the payload', () => {
    jest.useFakeTimers();
    const { sessionId, result } = renderHarness({ inFlight: true, withActiveAttempt: true });
    const token = result.current.token;

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: {
          history: 'HISTORY',
          capturedSequence: 5,
          hasHistory: false,
          correlationId: token,
        },
        ts: new Date().toISOString(),
      });
    });

    expect(result.current.historySync.hasMore()).toBe(false);
    jest.useRealTimers();
  });

  it('restores captured cursor position after full history write before replaying buffered frames', () => {
    jest.useFakeTimers();
    const { sessionId, result } = renderHarness({
      inFlight: true,
      pendingFrames: [{ sequence: 10, data: 'LIVE' }],
      withActiveAttempt: true,
    });
    const token = result.current.token;

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: {
          history: 'HISTORY',
          capturedSequence: 5,
          cursorX: 3,
          cursorY: 4,
          correlationId: token,
        },
        ts: new Date().toISOString(),
      });
    });

    act(() => {
      jest.runOnlyPendingTimers();
    });

    const writes = result.current.mockTerminal.write.mock.calls.map(([data]) => data);
    expect(writes).toEqual(['HISTORY', '\x1b[5;4HLIVE']);

    jest.useRealTimers();
  });

  it('clamps captured cursor position to terminal bounds', () => {
    jest.useFakeTimers();
    const { sessionId, result } = renderHarness({ inFlight: true, withActiveAttempt: true });
    const token = result.current.token;

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: {
          history: 'HISTORY',
          capturedSequence: 5,
          cursorX: -5,
          cursorY: 999,
          correlationId: token,
        },
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
    const { sessionId, result } = renderHarness({
      inFlight: true,
      pendingFrames: [{ sequence: 10, data: 'LIVE' }],
      withActiveAttempt: true,
    });
    const token = result.current.token;

    act(() => {
      result.current.handler({
        topic: `terminal/${sessionId}`,
        type: 'full_history',
        payload: {
          history: 'HISTORY',
          capturedSequence: 5,
          cursorX: Number.NaN,
          cursorY: Infinity,
          correlationId: token,
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

  describe('sequence-domain reconciliation (Task 3)', () => {
    it('resets recovery guards + watermark and accepts a lower currentSequence on a domain switch', () => {
      const { sessionId, result } = renderHarness({
        expectingSeed: false,
        primeOwner: (sync) => {
          sync.reconcileEpoch('epoch-A');
          sync.commitBaseline(60);
        },
      });
      result.current.lastSequenceRef.current = 60;

      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'subscribed',
          payload: {
            currentSequence: 2,
            replayStatus: 'gap',
            historyRefreshable: true,
            sequenceEpoch: 'epoch-B',
          },
          ts: new Date().toISOString(),
        });
      });

      // A new domain: the old numeric baseline/watermark and recovery guards are retired, so the
      // lower epoch-B sequence is a fresh domain (dirty) rather than stale output.
      expect(result.current.resetRecoveryDomain).toHaveBeenCalledTimes(1);
      expect(result.current.lastSequenceRef.current).toBe(0);
      expect(result.current.historySync.getSequenceEpoch()).toBe('epoch-B');
      expect(result.current.historySync.getAcceptedSnapshotSequence()).toBeNull();
      expect(result.current.historySync.isDirty()).toBe(true);
    });

    it('keeps delta-only behavior on a same-epoch covered reconnect (no domain reset)', () => {
      const { sessionId, result } = renderHarness({
        expectingSeed: false,
        primeOwner: (sync) => {
          sync.reconcileEpoch('epoch-A');
          sync.commitBaseline(30);
        },
      });
      result.current.lastSequenceRef.current = 30;

      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'subscribed',
          payload: {
            currentSequence: 30,
            replayStatus: 'covered',
            historyRefreshable: true,
            sequenceEpoch: 'epoch-A',
          },
          ts: new Date().toISOString(),
        });
      });

      expect(result.current.resetRecoveryDomain).not.toHaveBeenCalled();
      expect(result.current.lastSequenceRef.current).toBe(30);
      expect(result.current.historySync.getAcceptedSnapshotSequence()).toBe(30);
    });

    it('rejects a wrong-domain full_history before xterm mutation and preserves buffered current-domain frames', () => {
      jest.useFakeTimers();
      const { sessionId, result } = renderHarness({
        inFlight: true,
        withActiveAttempt: true,
        pendingFrames: [{ sequence: 7, data: 'LIVE-B' }],
        primeOwner: (sync) => sync.reconcileEpoch('epoch-B'),
      });
      const token = result.current.token;

      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'full_history',
          payload: {
            history: 'HISTORY-A',
            capturedSequence: 99,
            correlationId: token,
            sequenceEpoch: 'epoch-A',
          },
          ts: new Date().toISOString(),
        });
      });

      // Wrong domain: never rewrites xterm; the attempt is dropped and the current-domain frames
      // buffered during the in-flight are flushed rather than discarded.
      expect(result.current.mockTerminal.write).not.toHaveBeenCalled();
      expect(result.current.mockTerminal.reset).not.toHaveBeenCalled();
      expect(result.current.queueOrWrite).toHaveBeenCalledWith('LIVE-B');
      expect(result.current.isHistoryInFlightRef.current).toBe(false);
      expect(result.current.pendingHistoryFramesRef.current).toEqual([]);
      expect(result.current.historySync.hasActiveAttempt()).toBe(false);

      jest.useRealTimers();
    });
  });

  describe('drag-deferred history apply (Task 3)', () => {
    it('defers a matching full_history during a scrollbar drag and applies it after the drag ends', async () => {
      const controller = makeDragController();
      controller.active = true;
      const { sessionId, result } = renderHarness({
        inFlight: true,
        withActiveAttempt: true,
        dragController: controller,
        primeOwner: (sync) => sync.reconcileEpoch('epoch-A'),
      });
      const token = result.current.token;

      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'full_history',
          payload: {
            history: 'HISTORY',
            capturedSequence: 5,
            correlationId: token,
            sequenceEpoch: 'epoch-A',
          },
          ts: new Date().toISOString(),
        });
      });

      // Deferred while the drag owns xterm's cloned scrollbar state: no destructive operation.
      expect(result.current.mockTerminal.write).not.toHaveBeenCalled();
      expect(result.current.mockTerminal.reset).not.toHaveBeenCalled();
      expect(result.current.isLoadingHistoryRef.current).toBe(false);

      // Drag ends → the retained response applies on the next microtask.
      await act(async () => {
        controller.end('pointerup');
        await Promise.resolve();
      });

      expect(result.current.mockTerminal.write).toHaveBeenCalledWith(
        'HISTORY',
        expect.any(Function),
      );
    });

    it('drops a drag-deferred response when recovery supersedes the attempt before the drag ends', async () => {
      const controller = makeDragController();
      controller.active = true;
      const { sessionId, result } = renderHarness({
        inFlight: true,
        withActiveAttempt: true,
        dragController: controller,
        primeOwner: (sync) => sync.reconcileEpoch('epoch-A'),
      });
      const token = result.current.token;

      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'full_history',
          payload: { history: 'HISTORY', capturedSequence: 5, correlationId: token },
          ts: new Date().toISOString(),
        });
      });
      expect(result.current.mockTerminal.write).not.toHaveBeenCalled();

      // Recovery supersedes the attempt mid-drag; the deferred response must not apply on drag end.
      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'resync_required',
          payload: { currentSequence: 40 },
          ts: new Date().toISOString(),
        });
      });

      await act(async () => {
        controller.end('capture-loss');
        await Promise.resolve();
      });

      expect(result.current.mockTerminal.write).not.toHaveBeenCalled();
    });

    it('re-subscribes to a replacement controller so a deferred response is not stranded by a disposed one', async () => {
      const controllerA = makeDragController();
      controllerA.active = true;
      const { sessionId, result } = renderHarness({
        inFlight: true,
        withActiveAttempt: true,
        dragController: controllerA,
        primeOwner: (sync) => sync.reconcileEpoch('epoch-A'),
      });
      const token = result.current.token;

      // Defer a response on controller A while its drag is active.
      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'full_history',
          payload: {
            history: 'A1',
            capturedSequence: 5,
            correlationId: token,
            sequenceEpoch: 'epoch-A',
          },
          ts: new Date().toISOString(),
        });
      });
      expect(result.current.mockTerminal.write).not.toHaveBeenCalled();

      // Controller A is disposed and replaced (its drag-end listeners are cleared silently, without
      // firing) — e.g. a terminal recreation mid-drag.
      controllerA.dispose();
      const controllerB = makeDragController();
      controllerB.active = true;
      act(() => {
        result.current.scrollIntentControllerRef.current = controllerB;
      });

      // A fresh response deferred on controller B must subscribe to B's drag end, not stay bound to A.
      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'full_history',
          payload: {
            history: 'B2',
            capturedSequence: 6,
            correlationId: token,
            sequenceEpoch: 'epoch-A',
          },
          ts: new Date().toISOString(),
        });
      });
      expect(result.current.mockTerminal.write).not.toHaveBeenCalled();

      // Ending controller B's drag applies the deferred response — it is not stranded.
      await act(async () => {
        controllerB.end('pointerup');
        await Promise.resolve();
      });
      expect(result.current.mockTerminal.write).toHaveBeenCalledWith('B2', expect.any(Function));
    });

    it('cancels a deferred response and its drag-end subscription on unmount', async () => {
      const controller = makeDragController();
      controller.active = true;
      const { sessionId, result, unmount } = renderHarness({
        inFlight: true,
        withActiveAttempt: true,
        dragController: controller,
        primeOwner: (sync) => sync.reconcileEpoch('epoch-A'),
      });
      const token = result.current.token;

      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'full_history',
          payload: {
            history: 'HISTORY',
            capturedSequence: 5,
            correlationId: token,
            sequenceEpoch: 'epoch-A',
          },
          ts: new Date().toISOString(),
        });
      });

      // Unmount cleans up the deferred response + unsubscribes; a later drag end must apply nothing.
      unmount();
      await act(async () => {
        controller.end('pointerup');
        await Promise.resolve();
      });
      expect(result.current.mockTerminal.write).not.toHaveBeenCalled();
    });

    it('invalidates a deferred response, its attempt, and the in-flight buffer when the controller is disposed with no successor response', async () => {
      const controller = makeDragController();
      controller.active = true;
      const { sessionId, result } = renderHarness({
        inFlight: true,
        withActiveAttempt: true,
        dragController: controller,
        primeOwner: (sync) => sync.reconcileEpoch('epoch-A'),
      });
      const token = result.current.token as string;

      // Defer exactly one response on controller A while its drag owns xterm's scrollbar state.
      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'full_history',
          payload: {
            history: 'HISTORY',
            capturedSequence: 5,
            correlationId: token,
            sequenceEpoch: 'epoch-A',
          },
          ts: new Date().toISOString(),
        });
      });
      expect(result.current.isHistoryInFlightRef.current).toBe(true);
      expect(result.current.historySync.isActiveAttempt(token)).toBe(true);

      // The controller is disposed (terminal recreation) with NO successor full_history — its drag-end
      // listeners are cleared silently. ChatTerminal's controller-change wiring calls the published
      // invalidation, which must retire the deferral, the attempt, and the in-flight buffer.
      controller.dispose();
      act(() => {
        result.current.deferredHistoryInvalidateRef.current?.();
      });
      expect(result.current.isHistoryInFlightRef.current).toBe(false);
      expect(result.current.isLoadingHistoryRef.current).toBe(false);
      expect(result.current.historySync.isActiveAttempt(token)).toBe(false);

      // A late drag end (were the controller still live) applies nothing — no stranded in-flight state.
      await act(async () => {
        controller.end('pointerup');
        await Promise.resolve();
      });
      expect(result.current.mockTerminal.write).not.toHaveBeenCalled();
    });

    it('invalidates a deferred response and its attempt on a session change', async () => {
      const controller = makeDragController();
      controller.active = true;
      const { sessionId, result, rerender } = renderHarness({
        inFlight: true,
        withActiveAttempt: true,
        dragController: controller,
        primeOwner: (sync) => sync.reconcileEpoch('epoch-A'),
      });
      const token = result.current.token as string;

      act(() => {
        result.current.handler({
          topic: `terminal/${sessionId}`,
          type: 'full_history',
          payload: {
            history: 'HISTORY',
            capturedSequence: 5,
            correlationId: token,
            sequenceEpoch: 'epoch-A',
          },
          ts: new Date().toISOString(),
        });
      });
      expect(result.current.isHistoryInFlightRef.current).toBe(true);

      // Switching sessions runs the lifecycle-cleanup effect keyed on sessionId, invalidating the
      // pending deferral so it can never apply against the new session.
      act(() => {
        rerender({ sessionId: 'other-session' });
      });
      expect(result.current.isHistoryInFlightRef.current).toBe(false);
      expect(result.current.historySync.isActiveAttempt(token)).toBe(false);

      await act(async () => {
        controller.end('pointerup');
        await Promise.resolve();
      });
      expect(result.current.mockTerminal.write).not.toHaveBeenCalled();
    });
  });
});
