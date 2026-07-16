import { renderHook, act } from '@testing-library/react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { useSeedManager } from './useSeedManager';
import { termLog } from '@/ui/lib/debug';
import { TerminalWritePump } from './terminal-write-pump';
import { createTerminalHistorySync, type TerminalHistorySync } from '../terminal-history-sync';

jest.mock('@/ui/lib/debug');

// Mock socket
const mockSocket = {
  emit: jest.fn(),
  connected: true,
};

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: () => mockSocket,
}));

describe('useSeedManager', () => {
  let mockTerminal: jest.Mocked<Terminal>;
  let mockFitAddon: jest.Mocked<FitAddon>;
  let mockDispatch: jest.Mock;
  let expectingSeedRef: React.MutableRefObject<boolean>;
  let historySync: TerminalHistorySync;

  beforeEach(() => {
    mockTerminal = {
      write: jest.fn((data, callback) => {
        if (callback) callback();
      }),
      reset: jest.fn(),
      clear: jest.fn(),
      resize: jest.fn(),
      scrollToBottom: jest.fn(),
      options: { scrollback: 1000 },
      buffer: { active: { length: 24, baseY: 0, cursorY: 0 } },
      cols: 80,
      rows: 24,
    } as unknown as jest.Mocked<Terminal>;

    mockFitAddon = {
      fit: jest.fn(),
    } as unknown as jest.Mocked<FitAddon>;

    mockDispatch = jest.fn();
    expectingSeedRef = { current: false };
    historySync = createTerminalHistorySync();

    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should handle seed chunks and complete without resize jiggle', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    // Send seed chunks
    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 3,
        data: 'chunk0',
      });
      result.current.handleSeedChunk({
        chunk: 1,
        totalChunks: 3,
        data: 'chunk1',
      });
      result.current.handleSeedChunk({
        chunk: 2,
        totalChunks: 3,
        data: 'chunk2',
        hasHistory: true,
      });
    });

    expect(mockTerminal.reset).toHaveBeenCalled();
    expect(mockTerminal.clear).toHaveBeenCalled();
    expect(mockTerminal.write).toHaveBeenCalledWith('chunk0chunk1chunk2', expect.any(Function));
    expect(mockSocket.emit).not.toHaveBeenCalledWith('terminal:resize', expect.anything());
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SEED_COMPLETE' });
    // hasHistory enabled for scroll-up loading
    expect(historySync.hasMore()).toBe(true);
  });

  it('accepts a replacement seed on the same terminal after pump overflow', () => {
    const callbacks: Array<() => void> = [];
    const pump = new TerminalWritePump({ queueBytes: 10, batchBytes: 10, onOverflow: jest.fn() });
    pump.setTerminal(mockTerminal);
    const { result } = renderHook(() =>
      useSeedManager(
        'test-session',
        { current: mockTerminal },
        { current: mockFitAddon },
        mockDispatch,
        expectingSeedRef,
        historySync,
        undefined,
        1000,
        pump,
      ),
    );

    act(() => {
      result.current.handleSeedChunk({ chunk: 0, totalChunks: 1, data: 'initial' });
    });
    mockTerminal.write.mockImplementation((_data, callback) => {
      if (callback) callbacks.push(callback);
    });
    act(() => {
      pump.write('1234567890');
      pump.write('overflow');
      pump.write('overflow2');
      result.current.handleSeedChunk({ chunk: 0, totalChunks: 1, data: 'replace' });
    });

    expect(pump.getSnapshot().status).toBe('recovering');
    act(() => callbacks.shift()?.());
    expect(mockTerminal.write).toHaveBeenCalledWith('replace', expect.any(Function));
  });

  it('reopens seed acceptance when a replay gap requires resynchronization', () => {
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    const { result } = renderHook(() =>
      useSeedManager(
        'test-session',
        xtermRef,
        fitAddonRef,
        mockDispatch,
        expectingSeedRef,
        historySync,
      ),
    );

    act(() => {
      result.current.handleSeedChunk({ chunk: 0, totalChunks: 1, data: 'initial' });
      result.current.prepareForResync();
      result.current.handleSeedChunk({ chunk: 0, totalChunks: 1, data: 'fresh' });
    });

    expect(mockTerminal.write).toHaveBeenNthCalledWith(1, 'initial', expect.any(Function));
    expect(mockTerminal.write).toHaveBeenNthCalledWith(2, 'fresh', expect.any(Function));
    expect(expectingSeedRef.current).toBe(false);
  });

  it('should queue writes during seeding', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    // Start seed
    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 2,
        data: 'chunk0',
      });
    });

    // Queue some writes
    act(() => {
      result.current.queueOrWrite('write1');
      result.current.queueOrWrite('write2');
    });

    // Writes should be queued, not written
    expect(mockTerminal.write).not.toHaveBeenCalledWith('write1', undefined);
  });

  it('should clear pending writes after seed completes', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    // Start seed with chunk 0 of 2
    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 2,
        data: 'seed1',
      });
    });

    // Queue some writes while seeding
    act(() => {
      result.current.queueOrWrite('pending1');
    });

    // Pending writes should be queued, not written yet
    expect(mockTerminal.write).not.toHaveBeenCalledWith('pending1');

    // Complete seed with chunk 1 of 2
    act(() => {
      result.current.handleSeedChunk({
        chunk: 1,
        totalChunks: 2,
        data: 'seed2',
        hasHistory: true,
      });
    });

    expect(mockTerminal.reset).toHaveBeenCalled();
    expect(mockTerminal.clear).toHaveBeenCalled();
    expect(mockTerminal.write).toHaveBeenCalledWith('seed1seed2', expect.any(Function));
    // Verify snapshot has-more is recorded true after a truncated seed settles
    expect(historySync.hasMore()).toBe(true);
  });

  it('restores captured cursor position after seed write', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 1,
        data: 'seed',
        cursorX: 3,
        cursorY: 4,
        hasHistory: true,
      });
    });

    expect(mockTerminal.write).toHaveBeenNthCalledWith(1, 'seed', expect.any(Function));
    expect(mockTerminal.write).toHaveBeenNthCalledWith(2, '\x1b[5;4H', expect.any(Function));
  });

  it('keeps history disabled until seed replay settles', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    const writeCallbacks: Array<(() => void) | undefined> = [];
    mockTerminal.write.mockImplementation((_data, callback) => {
      writeCallbacks.push(callback);
    });

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 1,
        data: 'seed',
        cursorX: 3,
        cursorY: 4,
        hasHistory: true,
      });
    });

    expect(historySync.hasMore()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalledWith({ type: 'SEED_COMPLETE' });

    act(() => {
      writeCallbacks[0]?.();
    });

    expect(mockTerminal.scrollToBottom).toHaveBeenCalled();
    expect(mockTerminal.write).toHaveBeenNthCalledWith(2, '\x1b[5;4H', expect.any(Function));
    expect(historySync.hasMore()).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalledWith({ type: 'SEED_COMPLETE' });

    act(() => {
      writeCallbacks[1]?.();
    });

    expect(historySync.hasMore()).toBe(true);
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SEED_COMPLETE' });
  });

  it('honors hasHistory=false from the server (alt-screen seed advertises no history affordance)', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 1,
        data: 'alt-screen-seed',
        hasHistory: false,
      });
    });

    // Even after a settled seed, history stays disabled because the server said so.
    expect(historySync.hasMore()).toBe(false);
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SEED_COMPLETE' });
  });

  it('should timeout seed after 30 seconds', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    // Start seed but don't complete it
    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 5,
        data: 'chunk0',
      });
      result.current.handleSeedChunk({
        chunk: 1,
        totalChunks: 5,
        data: 'chunk1',
      });
    });

    // Advance time by 30 seconds
    act(() => {
      jest.advanceTimersByTime(30000);
    });

    // Should log timeout
    expect(termLog).toHaveBeenCalledWith(
      'seed_timeout',
      expect.objectContaining({
        sessionId,
        receivedChunks: 2,
        totalChunks: 5,
      }),
    );

    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SEED_TIMEOUT' });
  });

  it('should write partial seed on timeout if 80%+ chunks received', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    // Start seed and receive 4 out of 5 chunks (80%)
    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 5,
        data: 'chunk0',
      });
      result.current.handleSeedChunk({
        chunk: 1,
        totalChunks: 5,
        data: 'chunk1',
      });
      result.current.handleSeedChunk({
        chunk: 2,
        totalChunks: 5,
        data: 'chunk2',
      });
      result.current.handleSeedChunk({
        chunk: 3,
        totalChunks: 5,
        data: 'chunk3',
      });
    });

    // Advance time to trigger timeout
    act(() => {
      jest.advanceTimersByTime(30000);
    });

    // Should write partial seed
    expect(termLog).toHaveBeenCalledWith('seed_partial_write', {
      sessionId,
      received: 4,
      total: 5,
    });
    expect(mockTerminal.write).toHaveBeenCalledWith(
      'chunk0chunk1chunk2chunk3',
      expect.any(Function),
    );
  });

  describe('recovery seed timeout policy', () => {
    const renderRecoveryManager = () => {
      const onRecoveryComplete = jest.fn();
      const onRecoveryTimeout = jest.fn();
      const pump = new TerminalWritePump({ onOverflow: jest.fn() });
      pump.setTerminal(mockTerminal);
      const hook = renderHook(() =>
        useSeedManager(
          'recovery-timeout-session',
          { current: mockTerminal },
          { current: mockFitAddon },
          mockDispatch,
          expectingSeedRef,
          historySync,
          undefined,
          1000,
          pump,
          onRecoveryComplete,
          onRecoveryTimeout,
        ),
      );
      return { ...hook, onRecoveryComplete, onRecoveryTimeout, pump };
    };

    it('fails closed below 80% without writing or flushing the partial recovery', () => {
      const { result, onRecoveryTimeout, pump } = renderRecoveryManager();

      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 5,
          data: 'partial-0',
          recoveryEpoch: 4,
          capturedSequence: 17,
        });
        result.current.queueOrWrite('live-during-recovery');
        jest.advanceTimersByTime(30000);
      });

      expect(mockTerminal.write).not.toHaveBeenCalled();
      expect(pump.getSnapshot().status).toBe('recovering');
      expect(expectingSeedRef.current).toBe(true);
      expect(onRecoveryTimeout).toHaveBeenCalledWith(
        { sessionId: 'recovery-timeout-session', recoveryEpoch: 4 },
        true,
      );
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'SEED_TIMEOUT' });
    });

    it('fails closed at 80% without promoting a partial recovery snapshot', () => {
      const { result, onRecoveryTimeout, pump } = renderRecoveryManager();

      act(() => {
        for (let chunk = 0; chunk < 4; chunk += 1) {
          result.current.handleSeedChunk({
            chunk,
            totalChunks: 5,
            data: `partial-${chunk}`,
            recoveryEpoch: 4,
            capturedSequence: 17,
          });
        }
        jest.advanceTimersByTime(30000);
      });

      expect(mockTerminal.write).not.toHaveBeenCalled();
      expect(pump.getSnapshot().status).toBe('recovering');
      expect(onRecoveryTimeout).toHaveBeenCalledWith(
        { sessionId: 'recovery-timeout-session', recoveryEpoch: 4 },
        true,
      );
      expect(termLog).not.toHaveBeenCalledWith('seed_partial_write', expect.anything());
    });

    it('ignores late chunks from the aborted epoch and converges on the fresh epoch', () => {
      const { result, onRecoveryComplete, pump } = renderRecoveryManager();

      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 2,
          data: 'stale-0',
          recoveryEpoch: 4,
          capturedSequence: 17,
        });
        jest.advanceTimersByTime(30000);
        mockTerminal.reset.mockClear();
        mockDispatch.mockClear();
        result.current.handleSeedChunk({
          chunk: 1,
          totalChunks: 2,
          data: 'stale-1',
          recoveryEpoch: 4,
          capturedSequence: 17,
        });
      });

      expect(mockTerminal.reset).not.toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalledWith({ type: 'SEED_START' });

      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'fresh-snapshot',
          recoveryEpoch: 5,
          capturedSequence: 23,
        });
      });

      expect(mockTerminal.write).toHaveBeenCalledTimes(1);
      expect(mockTerminal.write).toHaveBeenCalledWith('fresh-snapshot', expect.any(Function));
      expect(onRecoveryComplete).toHaveBeenCalledTimes(1);
      expect(onRecoveryComplete).toHaveBeenCalledWith({
        sessionId: 'recovery-timeout-session',
        recoveryEpoch: 5,
        capturedSequence: 23,
      });
      expect(pump.getSnapshot().status).toBe('ready');
      // The recovery capture becomes the history baseline once the replacement write settles.
      expect(historySync.getAcceptedSnapshotSequence()).toBe(23);
      expect(historySync.isDirty()).toBe(false);
    });

    it('permits one retry and reports the second recovery timeout as terminal', () => {
      const { result, onRecoveryTimeout, pump } = renderRecoveryManager();

      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 2,
          data: 'first-attempt',
          recoveryEpoch: 4,
          capturedSequence: 17,
        });
        jest.advanceTimersByTime(30000);
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 2,
          data: 'retry-attempt',
          recoveryEpoch: 5,
          capturedSequence: 23,
        });
        jest.advanceTimersByTime(30000);
      });

      expect(onRecoveryTimeout.mock.calls).toEqual([
        [{ sessionId: 'recovery-timeout-session', recoveryEpoch: 4 }, true],
        [{ sessionId: 'recovery-timeout-session', recoveryEpoch: 5 }, false],
      ]);
      expect(mockTerminal.write).not.toHaveBeenCalled();
      expect(pump.getSnapshot().status).toBe('recovering');
    });

    it('carries the sequenceEpoch on recovery completion and accepts B/recovery1 after A/recovery6 once guards reset', () => {
      const { result, onRecoveryComplete } = renderRecoveryManager();
      historySync.reconcileEpoch('epoch-A');

      // Domain A completes recovery 6 → completed high-water mark = 6 in this domain.
      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'A6',
          sequenceEpoch: 'epoch-A',
          recoveryEpoch: 6,
          capturedSequence: 60,
        });
      });
      expect(onRecoveryComplete).toHaveBeenCalledWith({
        sessionId: 'recovery-timeout-session',
        sequenceEpoch: 'epoch-A',
        recoveryEpoch: 6,
        capturedSequence: 60,
      });

      // A server domain switch (subscribed reconciliation) retires the numeric guards.
      act(() => {
        historySync.reconcileEpoch('epoch-B');
        result.current.resetRecoveryDomain();
      });
      onRecoveryComplete.mockClear();

      // Domain B's first recovery (epoch 1) would be <= A's 6 and rejected without the reset.
      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'B1',
          sequenceEpoch: 'epoch-B',
          recoveryEpoch: 1,
          capturedSequence: 3,
        });
      });
      expect(onRecoveryComplete).toHaveBeenCalledWith({
        sessionId: 'recovery-timeout-session',
        sequenceEpoch: 'epoch-B',
        recoveryEpoch: 1,
        capturedSequence: 3,
      });
      expect(historySync.getAcceptedSnapshotSequence()).toBe(3);
    });

    it('drops a late recovery seed from a retired sequence-domain (cannot mutate the new domain)', () => {
      const { result, onRecoveryComplete } = renderRecoveryManager();
      // The live domain is now B; a late chunk stamped with the retired epoch A must be ignored.
      historySync.reconcileEpoch('epoch-B');

      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'LATE-A',
          sequenceEpoch: 'epoch-A',
          recoveryEpoch: 9,
          capturedSequence: 99,
        });
      });

      expect(mockTerminal.write).not.toHaveBeenCalled();
      expect(mockTerminal.reset).not.toHaveBeenCalled();
      expect(onRecoveryComplete).not.toHaveBeenCalled();
      // The retired-domain capture must NOT become the new domain's baseline.
      expect(historySync.getAcceptedSnapshotSequence()).toBeNull();
    });

    it('a held recovery-A write that settles after a domain switch cannot mutate the new domain; B/recovery1 still completes', () => {
      // A terminal that HOLDS its write callbacks so the recovery replacement write can be settled
      // deterministically after the domain has switched.
      const heldWrites: Array<() => void> = [];
      const holdingTerminal = {
        write: jest.fn((_data: string, cb?: () => void) => {
          if (cb) heldWrites.push(cb);
        }),
        reset: jest.fn(),
        clear: jest.fn(),
        resize: jest.fn(),
        scrollToBottom: jest.fn(),
        options: { scrollback: 1000 },
        buffer: { active: { length: 24, baseY: 0, cursorY: 0 } },
        cols: 80,
        rows: 24,
      } as unknown as jest.Mocked<Terminal>;
      const drainHeldWrites = () => {
        while (heldWrites.length) heldWrites.shift()?.();
      };

      const onRecoveryComplete = jest.fn();
      const onSeedReady = jest.fn();
      const pump = new TerminalWritePump({ onOverflow: jest.fn() });
      pump.setTerminal(holdingTerminal);
      const { result } = renderHook(() =>
        useSeedManager(
          'domain-switch-session',
          { current: holdingTerminal },
          { current: mockFitAddon },
          mockDispatch,
          expectingSeedRef,
          historySync,
          onSeedReady,
          1000,
          pump,
          onRecoveryComplete,
          jest.fn(),
        ),
      );
      historySync.reconcileEpoch('epoch-A');

      // Recovery A assembles fully; its replacement write is HELD (not yet settled). cursorX/cursorY
      // are present (the normal server payload), so a stale writeCursorOrFinish would scroll and queue
      // A's cursor-position sequence into the new domain unless the whole pipeline is invalidated.
      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'A-RECOVERED',
          sequenceEpoch: 'epoch-A',
          recoveryEpoch: 6,
          capturedSequence: 60,
          cursorX: 5,
          cursorY: 3,
        });
      });
      expect(heldWrites.length).toBeGreaterThan(0);
      expect(holdingTerminal.write).toHaveBeenCalledTimes(1);

      // The server sequence-domain switches to B before A's write settles.
      act(() => {
        historySync.reconcileEpoch('epoch-B');
        result.current.resetRecoveryDomain();
      });
      mockDispatch.mockClear();

      // Release A's held write callback(s): finishSeedWrite must fail closed — no pump completion,
      // no SEED_COMPLETE, no readiness, no baseline commit, no completion emit for the retired domain.
      act(() => {
        drainHeldWrites();
        jest.advanceTimersByTime(500);
      });
      expect(onRecoveryComplete).not.toHaveBeenCalled();
      expect(onSeedReady).not.toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalledWith({ type: 'SEED_COMPLETE' });
      expect(historySync.getAcceptedSnapshotSequence()).toBeNull();
      expect(pump.getSnapshot().status).not.toBe('ready');
      // The retired replacement write must not scroll the new domain's viewport, and it must not
      // queue A's cursor-position sequence: only the original held 'A-RECOVERED' write ever happened.
      expect(holdingTerminal.scrollToBottom).not.toHaveBeenCalled();
      expect(holdingTerminal.write).toHaveBeenCalledTimes(1);

      // Domain B's own recovery 1 completes normally.
      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'B1',
          sequenceEpoch: 'epoch-B',
          recoveryEpoch: 1,
          capturedSequence: 3,
        });
        drainHeldWrites();
        jest.advanceTimersByTime(500);
      });
      expect(onRecoveryComplete).toHaveBeenCalledWith({
        sessionId: 'domain-switch-session',
        sequenceEpoch: 'epoch-B',
        recoveryEpoch: 1,
        capturedSequence: 3,
      });
      expect(historySync.getAcceptedSnapshotSequence()).toBe(3);
      expect(onSeedReady).toHaveBeenCalled();
    });

    it('does not fire a stale onSeedReady when the domain switches during the post-write readiness delay', () => {
      const onSeedReady = jest.fn();
      const onRecoveryComplete = jest.fn();
      const pump = new TerminalWritePump({ onOverflow: jest.fn() });
      pump.setTerminal(mockTerminal);
      const { result } = renderHook(() =>
        useSeedManager(
          'domain-ready-session',
          { current: mockTerminal },
          { current: mockFitAddon },
          mockDispatch,
          expectingSeedRef,
          historySync,
          onSeedReady,
          1000,
          pump,
          onRecoveryComplete,
          jest.fn(),
        ),
      );
      historySync.reconcileEpoch('epoch-B');

      // B/recovery1 settles synchronously (mockTerminal writes call back immediately), so
      // finishSeedWrite runs in the live domain B and schedules the 400 ms readiness timer.
      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'B1',
          sequenceEpoch: 'epoch-B',
          recoveryEpoch: 1,
          capturedSequence: 3,
        });
      });
      expect(onRecoveryComplete).toHaveBeenCalled();
      expect(onSeedReady).not.toHaveBeenCalled();

      // The domain switches to C before the readiness timer fires.
      act(() => {
        historySync.reconcileEpoch('epoch-C');
        result.current.resetRecoveryDomain();
      });

      act(() => {
        jest.advanceTimersByTime(400);
      });
      // The stale readiness signal belongs to retired domain B and must not mark C ready.
      expect(onSeedReady).not.toHaveBeenCalled();
    });
  });

  it('delegates seed-time write staging to the bounded pump', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    // Start seed
    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 2,
        data: 'chunk0',
      });
    });

    // Queue 1100 writes (exceeds limit of 1000)
    act(() => {
      for (let i = 0; i < 1100; i++) {
        result.current.queueOrWrite(`write${i}`);
      }
    });

    expect(mockTerminal.write).not.toHaveBeenCalledWith('write1099', expect.any(Function));
  });

  it('does not retain a second seed-time byte queue outside the pump', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    // Start seed
    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 2,
        data: 'chunk0',
      });
    });

    // Queue large writes (3MB total)
    const largeChunk = 'x'.repeat(1024 * 1024); // 1MB
    act(() => {
      result.current.queueOrWrite(largeChunk);
      result.current.queueOrWrite(largeChunk);
      result.current.queueOrWrite(largeChunk);
    });

    expect(result.current.seedStateRef.current).not.toBeNull();
    expect(termLog).not.toHaveBeenCalledWith('pending_writes_bytes_overflow', expect.anything());
  });

  it('should write immediately when not seeding', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    // Write without starting seed
    act(() => {
      result.current.queueOrWrite('immediate');
    });

    // Should write immediately
    expect(mockTerminal.write).toHaveBeenCalledWith('immediate', expect.any(Function));
  });

  it('should clear expecting seed flag when seed starts', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    expectingSeedRef.current = true;

    const { result } = renderHook(() =>
      useSeedManager(sessionId, xtermRef, fitAddonRef, mockDispatch, expectingSeedRef, historySync),
    );

    // Start seed
    act(() => {
      result.current.handleSeedChunk({
        chunk: 0,
        totalChunks: 1,
        data: 'chunk0',
      });
    });

    expect(expectingSeedRef.current).toBe(false);
  });

  // SEED-RACE FIX — onSeedReady (which the client uses to fire the server-gated
  // `terminal:restore_viewport_modes` redraw request, see ChatTerminal.tsx:161)
  // MUST fire AFTER the seed write settles, not when the final seed_ansi chunk
  // arrives. A redraw during the seed-replay window is discarded (the client is
  // mid-reset), so firing on final-chunk-arrival would lose the alt-screen +
  // mouse-mode restore. This is the client half of the seed-race; the server
  // gating (maybeRestoreViewportModes) is covered in terminal.gateway.spec.ts.
  describe('seed-race — onSeedReady fires after seed write settles (not on final chunk)', () => {
    it('does NOT call onSeedReady when the final chunk arrives but the write has not settled', () => {
      const onSeedReady = jest.fn();
      // Hold the write callback open so we can observe the pre-settle state.
      const writeCallbacks: Array<(() => void) | undefined> = [];
      mockTerminal.write.mockImplementation((_data, callback) => {
        writeCallbacks.push(callback);
      });

      const { result } = renderHook(() =>
        useSeedManager(
          'race-sess',
          { current: mockTerminal },
          { current: mockFitAddon },
          mockDispatch,
          expectingSeedRef,
          historySync,
          onSeedReady,
        ),
      );

      // Send the (single) final chunk — write is queued but callback NOT yet invoked.
      // No cursor coords → single-write path (fullSeed write callback → finishSeedWrite).
      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'seed',
        });
      });

      // Final chunk has arrived, but neither the write nor the 400ms settle has completed.
      expect(onSeedReady).not.toHaveBeenCalled();

      // Even after the write callback fires, onSeedReady is still behind the
      // 400ms settle timeout (it must NOT fire synchronously off the write).
      act(() => {
        writeCallbacks[0]?.();
      });
      expect(onSeedReady).not.toHaveBeenCalled();

      // NOW the settle timeout elapses → onSeedReady fires (redraw request goes out).
      act(() => {
        jest.advanceTimersByTime(400);
      });
      expect(onSeedReady).toHaveBeenCalledTimes(1);
    });

    it('emits one recovery completion immediately after the final write callback', () => {
      const writeCallbacks: Array<(() => void) | undefined> = [];
      const onRecoveryComplete = jest.fn();
      mockTerminal.write.mockImplementation((_data, callback) => {
        writeCallbacks.push(callback);
      });
      const { result } = renderHook(() =>
        useSeedManager(
          'recovery-sess',
          { current: mockTerminal },
          { current: mockFitAddon },
          mockDispatch,
          expectingSeedRef,
          historySync,
          undefined,
          1000,
          undefined,
          onRecoveryComplete,
        ),
      );

      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'snapshot',
          recoveryEpoch: 4,
          capturedSequence: 17,
        });
      });
      expect(onRecoveryComplete).not.toHaveBeenCalled();

      act(() => writeCallbacks.shift()?.());
      expect(onRecoveryComplete).toHaveBeenCalledTimes(1);
      expect(onRecoveryComplete).toHaveBeenCalledWith({
        sessionId: 'recovery-sess',
        recoveryEpoch: 4,
        capturedSequence: 17,
      });

      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'duplicate',
          recoveryEpoch: 4,
          capturedSequence: 17,
        });
      });
      expect(mockTerminal.write).toHaveBeenCalledTimes(1);
      expect(onRecoveryComplete).toHaveBeenCalledTimes(1);
    });

    it('accepts a newer server recovery epoch on the same terminal instance', () => {
      const onRecoveryComplete = jest.fn();
      const { result } = renderHook(() =>
        useSeedManager(
          'replacement-sess',
          { current: mockTerminal },
          { current: mockFitAddon },
          mockDispatch,
          expectingSeedRef,
          historySync,
          undefined,
          1000,
          undefined,
          onRecoveryComplete,
        ),
      );

      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'first',
          recoveryEpoch: 4,
          capturedSequence: 17,
        });
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'replacement',
          recoveryEpoch: 5,
          capturedSequence: 23,
        });
      });

      expect(mockTerminal.write).toHaveBeenNthCalledWith(1, 'first', expect.any(Function));
      expect(mockTerminal.write).toHaveBeenNthCalledWith(2, 'replacement', expect.any(Function));
      expect(onRecoveryComplete).toHaveBeenNthCalledWith(1, {
        sessionId: 'replacement-sess',
        recoveryEpoch: 4,
        capturedSequence: 17,
      });
      expect(onRecoveryComplete).toHaveBeenNthCalledWith(2, {
        sessionId: 'replacement-sess',
        recoveryEpoch: 5,
        capturedSequence: 23,
      });
    });

    it('redraw request (onSeedReady) does NOT fire on partial seed (final chunk not yet received)', () => {
      const onSeedReady = jest.fn();
      const { result } = renderHook(() =>
        useSeedManager(
          'partial-sess',
          { current: mockTerminal },
          { current: mockFitAddon },
          mockDispatch,
          expectingSeedRef,
          historySync,
          onSeedReady,
        ),
      );

      act(() => {
        result.current.handleSeedChunk({ chunk: 0, totalChunks: 3, data: 'a' });
        result.current.handleSeedChunk({ chunk: 1, totalChunks: 3, data: 'b' });
      });

      // Advance well past the 400ms settle — final chunk never arrived, so no redraw.
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(onSeedReady).not.toHaveBeenCalled();
    });
  });

  // The canonical seed service computes whether older primary-buffer history is
  // loadable; the client applies that provider-independent boolean without inference.
  describe('cross-provider hasHistory semantics', () => {
    const renderAndCompleteSeed = (hasHistory: boolean) => {
      const { result } = renderHook(() =>
        useSeedManager(
          'xprovider-sess',
          { current: mockTerminal },
          { current: mockFitAddon },
          mockDispatch,
          expectingSeedRef,
          historySync,
        ),
      );

      act(() => {
        result.current.handleSeedChunk({
          chunk: 0,
          totalChunks: 1,
          data: 'seed',
          cursorX: 0,
          cursorY: 0,
          hasHistory,
        });
      });

      return result;
    };

    it('claude/codex TRUNCATED seed (server hasHistory=true) SHOWS the scroll-up affordance', () => {
      renderAndCompleteSeed(true);
      // Default mockTerminal.write invokes its callback synchronously, so the
      // finishSeedWrite path runs and records snapshot has-more immediately.
      expect(historySync.hasMore()).toBe(true);
    });

    it('claude/codex NON-truncated seed (server hasHistory=false) HIDES the scroll-up affordance', () => {
      // A non-truncated seed contains the whole scrollback, so nothing remains to load.
      renderAndCompleteSeed(false);
      expect(historySync.hasMore()).toBe(false);
    });

    it('opencode alt-screen seed (server hasHistory=false) HIDES the scroll-up affordance', () => {
      // Alt-screen TUIs have no loadable primary-buffer scrollback (capture-pane
      // only holds the single visible screen) → server advertises false.
      renderAndCompleteSeed(false);
      expect(historySync.hasMore()).toBe(false);
    });

    it('defaults to HIDING when the server omits hasHistory (defensive — no dead affordance)', () => {
      // hasHistory undefined → state.hasHistory === true is false → hidden.
      renderAndCompleteSeed(undefined as unknown as boolean);
      expect(historySync.hasMore()).toBe(false);
    });
  });

  describe('empty initial completion', () => {
    const renderSeedManager = (pump?: TerminalWritePump) => {
      const onSeedReady = jest.fn();
      const { result } = renderHook(() =>
        useSeedManager(
          'empty-sess',
          { current: mockTerminal },
          { current: mockFitAddon },
          mockDispatch,
          expectingSeedRef,
          historySync,
          onSeedReady,
          1000,
          pump,
        ),
      );
      return { result, onSeedReady };
    };

    it('resolves readiness and adopts sequence 0 without resetting xterm', () => {
      expectingSeedRef.current = true;
      const { result, onSeedReady } = renderSeedManager();

      act(() => {
        result.current.handleSeedEmpty({ capturedSequence: 0 });
      });

      expect(historySync.isSettled()).toBe(true);
      expect(historySync.getAcceptedSnapshotSequence()).toBe(0);
      expect(historySync.isDirty()).toBe(false);
      expect(expectingSeedRef.current).toBe(false);
      expect(mockTerminal.reset).not.toHaveBeenCalled();
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'SEED_COMPLETE' });
      expect(onSeedReady).toHaveBeenCalledTimes(1);
    });

    it('does not drive the write pump seed/recovery machinery', () => {
      expectingSeedRef.current = true;
      const pump = new TerminalWritePump({ onOverflow: jest.fn() });
      pump.setTerminal(mockTerminal);
      const { result } = renderSeedManager(pump);

      act(() => {
        result.current.handleSeedEmpty({ capturedSequence: 4 });
      });

      // The pump never entered seeding for an empty capture, so it stays ready.
      expect(pump.getSnapshot().status).toBe('ready');
      expect(historySync.getAcceptedSnapshotSequence()).toBe(4);
    });

    it('ignores a stray completion when not awaiting a seed', () => {
      expectingSeedRef.current = false;
      historySync.settle();
      historySync.commitBaseline(7);
      const { result, onSeedReady } = renderSeedManager();

      act(() => {
        result.current.handleSeedEmpty({ capturedSequence: 0 });
      });

      // A healthy settled session's baseline is not clobbered by a stray empty completion.
      expect(historySync.getAcceptedSnapshotSequence()).toBe(7);
      expect(onSeedReady).not.toHaveBeenCalled();
    });
  });
});
