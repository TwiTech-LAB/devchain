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

  it('should block subscription when socket not connected', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };

    const { result } = renderHook(() =>
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, historySync),
    );

    act(() => {
      const success = result.current.attemptSubscription();
      expect(success).toBe(false);
    });

    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(termLog).toHaveBeenCalledWith('subscribe_blocked', {
      reason: 'socket_not_connected',
      sessionId,
      socketId: mockSocket.id,
    });
  });

  it('should block subscription when terminal not ready', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: null };
    mockSocket.connected = true;

    const { result } = renderHook(() =>
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, historySync),
    );

    act(() => {
      const success = result.current.attemptSubscription();
      expect(success).toBe(false);
    });

    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(termLog).toHaveBeenCalledWith(
      'subscribe_blocked',
      expect.objectContaining({
        reason: 'terminal_not_ready',
        sessionId,
      }),
    );
  });

  it('should block subscription when already subscribed', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    mockSocket.connected = true;

    const { result } = renderHook(() =>
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, historySync),
    );

    // First subscription should succeed
    act(() => {
      result.current.attemptSubscription();
    });

    // Manually mark as subscribed (simulating server response)
    act(() => {
      result.current.isSubscribedRef.current = true;
    });

    jest.clearAllMocks();

    // Second subscription should be blocked
    act(() => {
      const success = result.current.attemptSubscription();
      expect(success).toBe(false);
    });

    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(termLog).toHaveBeenCalledWith('subscribe_blocked', {
      reason: 'already_subscribed',
      sessionId,
    });
  });

  it('should subscribe successfully when all preconditions met', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    mockSocket.connected = true;

    const { result } = renderHook(() =>
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, historySync),
    );

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

  it('should mark expecting seed on first attach', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    mockSocket.connected = true;

    const { result } = renderHook(() =>
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, historySync),
    );

    expect(result.current.expectingSeedRef.current).toBe(false);

    act(() => {
      result.current.attemptSubscription();
    });

    expect(result.current.expectingSeedRef.current).toBe(true);
  });

  it('should send the {sequenceEpoch, sequence} cursor pair on reconnection once a domain is known', () => {
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
      result.current.lastSequenceRef.current = 123;
    });

    // Reconnection attempt (not first attach) sends BOTH cursor fields.
    act(() => {
      result.current.attemptSubscription();
    });

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'terminal:subscribe',
      expect.objectContaining({
        lastSequence: 123,
        sequenceEpoch: 'epoch-A',
      }),
    );
  });

  it('sends the cursor with sequence 0 (a valid baseline) when a domain is known on reconnect', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    mockSocket.connected = true;

    const { result } = renderHook(() =>
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, historySync),
    );

    act(() => {
      result.current.attemptSubscription();
    });

    mockSocket.emit.mockClear();
    act(() => {
      result.current.isSubscribedRef.current = false;
      historySync.reconcileEpoch('epoch-A');
      result.current.lastSequenceRef.current = 0; // sequence 0 is still a valid cursor
    });

    act(() => {
      result.current.attemptSubscription();
    });

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'terminal:subscribe',
      expect.objectContaining({ lastSequence: 0, sequenceEpoch: 'epoch-A' }),
    );
  });

  it('should be idempotent - safe to call multiple times', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    mockSocket.connected = true;

    const { result } = renderHook(() =>
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, historySync),
    );

    // Call once
    act(() => {
      result.current.attemptSubscription();
    });

    const firstCallCount = mockSocket.emit.mock.calls.length;

    // Mark as subscribed
    act(() => {
      result.current.isSubscribedRef.current = true;
    });

    // Call again - should be blocked
    act(() => {
      result.current.attemptSubscription();
    });

    // Should not have made more calls (blocked after marking subscribed)
    expect(mockSocket.emit).toHaveBeenCalledTimes(firstCallCount);
  });

  it('should return correct refs', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };

    const { result } = renderHook(() =>
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, historySync),
    );

    expect(result.current.lastSequenceRef).toBeDefined();
    expect(result.current.isSubscribedRef).toBeDefined();
    expect(result.current.expectingSeedRef).toBeDefined();
    expect(result.current.attemptSubscription).toBeInstanceOf(Function);
  });
});
