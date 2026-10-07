import { renderHook, act } from '@testing-library/react';
import type { Terminal } from '@xterm/xterm';
import { useTerminalSubscription } from './useTerminalSubscription';
import { createTerminalHistorySync, type TerminalHistorySync } from '../terminal-history-sync';
import { termLog } from '@/ui/lib/debug';

jest.mock('@/ui/lib/debug');

// Mock socket
const mockSocket = {
  emit: jest.fn(),
  connected: false,
  id: 'test-socket-id',
};

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: () => mockSocket,
}));

describe('useTerminalSubscription', () => {
  let mockTerminal: Terminal;
  let mockDispatch: jest.Mock;
  let historySync: TerminalHistorySync;

  beforeEach(() => {
    mockTerminal = {
      cols: 80,
      rows: 24,
    } as Terminal;

    mockDispatch = jest.fn();
    historySync = createTerminalHistorySync();
    mockSocket.connected = false;
    jest.clearAllMocks();
  });

  it.each(['disconnected', 'not-ready', 'already-subscribed'])(
    'blocks subscription when %s',
    (reason) => {
      mockSocket.connected = reason !== 'disconnected';
      const xtermRef = { current: reason === 'not-ready' ? null : mockTerminal };
      const { result } = renderHook(() =>
        useTerminalSubscription('test-session', xtermRef, mockDispatch, historySync),
      );
      if (reason === 'already-subscribed') {
        act(() => {
          expect(result.current.attemptSubscription()).toBe(true);
          result.current.isSubscribedRef.current = true;
        });
        mockSocket.emit.mockClear();
      }
      act(() => expect(result.current.attemptSubscription()).toBe(false));
      expect(mockSocket.emit).not.toHaveBeenCalled();
    },
  );

  it('should subscribe successfully when all preconditions met', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    mockSocket.connected = true;

    const { result } = renderHook(() =>
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, historySync),
    );

    expect(result.current.expectingSeedRef.current).toBe(false);
    act(() => {
      const success = result.current.attemptSubscription();
      expect(success).toBe(true);
    });

    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SUBSCRIBE_ATTEMPT' });
    // First attach with no known domain: the reconnect cursor sends NEITHER field.
    expect(mockSocket.emit).toHaveBeenCalledWith('terminal:subscribe', {
      sessionId,
      lastSequence: undefined,
      sequenceEpoch: undefined,
      cols: 80,
      rows: 24,
    });
    // Subscribe no longer auto-steals authority: initial authority originates server-side
    // (claimInitialAuthority latch + subscribe() first-subscriber grant). Resize rides the
    // subscribe payload's cols/rows.
    expect(mockSocket.emit).not.toHaveBeenCalledWith('terminal:focus', { sessionId });
    expect(termLog).toHaveBeenCalledWith('subscribe_success', {
      sessionId,
      expectingSeed: true,
    });
    expect(result.current.expectingSeedRef.current).toBe(true);
  });

  it('should use provided socket instead of singleton fallback when passed', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    // If fallback socket were used, subscribe would be blocked.
    mockSocket.connected = false;
    const providedSocket = {
      emit: jest.fn(),
      connected: true,
      id: 'provided-socket-id',
    };

    const { result } = renderHook(() =>
      useTerminalSubscription(
        sessionId,
        xtermRef,
        mockDispatch,
        historySync,
        providedSocket as never,
      ),
    );

    act(() => {
      const success = result.current.attemptSubscription();
      expect(success).toBe(true);
    });

    expect(providedSocket.emit).toHaveBeenCalledWith(
      'terminal:subscribe',
      expect.objectContaining({ sessionId }),
    );
    expect(providedSocket.emit).not.toHaveBeenCalledWith('terminal:focus', { sessionId });
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it.each([0, 123])('sends known epoch with reconnect sequence %s', (sequence) => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    mockSocket.connected = true;

    const { result } = renderHook(() =>
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, historySync),
    );

    // First subscription (first attach - sets hasEverSubscribedRef to true)
    act(() => {
      result.current.attemptSubscription();
    });

    // Reset for reconnection scenario. Adopt a domain epoch (as a `subscribed` ack would) so the
    // reconnect cursor has a domain to pair the sequence with.
    mockSocket.emit.mockClear();
    act(() => {
      result.current.isSubscribedRef.current = false; // Allow re-subscription
      historySync.reconcileEpoch('epoch-A');
      result.current.lastSequenceRef.current = sequence;
    });

    // Reconnection attempt (not first attach) sends BOTH cursor fields.
    act(() => {
      result.current.attemptSubscription();
    });

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'terminal:subscribe',
      expect.objectContaining({
        lastSequence: sequence,
        sequenceEpoch: 'epoch-A',
      }),
    );
  });
});
