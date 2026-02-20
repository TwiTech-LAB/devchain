import { renderHook, act } from '@testing-library/react';
import type { Terminal } from '@xterm/xterm';
import { useTerminalSubscription } from './useTerminalSubscription';
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

  beforeEach(() => {
    mockTerminal = {
      cols: 80,
      rows: 24,
    } as Terminal;

    mockDispatch = jest.fn();
    mockSocket.connected = false;
    jest.clearAllMocks();
  });

  it('should block subscription when socket not connected', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };

    const { result } = renderHook(() => useTerminalSubscription(sessionId, xtermRef, mockDispatch));

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

    const { result } = renderHook(() => useTerminalSubscription(sessionId, xtermRef, mockDispatch));

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

    const { result } = renderHook(() => useTerminalSubscription(sessionId, xtermRef, mockDispatch));

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

    const { result } = renderHook(() => useTerminalSubscription(sessionId, xtermRef, mockDispatch));

    act(() => {
      const success = result.current.attemptSubscription();
      expect(success).toBe(true);
    });

    expect(mockDispatch).toHaveBeenCalledWith({ type: 'SUBSCRIBE_ATTEMPT' });
    expect(mockSocket.emit).toHaveBeenCalledWith('terminal:subscribe', {
      sessionId,
      lastSequence: undefined,
      cols: 80,
      rows: 24,
    });
    expect(mockSocket.emit).toHaveBeenCalledWith('terminal:focus', { sessionId });
    // Note: Resize is handled by server during subscribe (using cols/rows from payload)
    // No separate resize emit needed
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
      useTerminalSubscription(sessionId, xtermRef, mockDispatch, providedSocket as never),
    );

    act(() => {
      const success = result.current.attemptSubscription();
      expect(success).toBe(true);
    });

    expect(providedSocket.emit).toHaveBeenCalledWith(
      'terminal:subscribe',
      expect.objectContaining({ sessionId }),
    );
    expect(providedSocket.emit).toHaveBeenCalledWith('terminal:focus', { sessionId });
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });

  it('should mark expecting seed on first attach', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    mockSocket.connected = true;

    const { result } = renderHook(() => useTerminalSubscription(sessionId, xtermRef, mockDispatch));

    expect(result.current.expectingSeedRef.current).toBe(false);

    act(() => {
      result.current.attemptSubscription();
    });

    expect(result.current.expectingSeedRef.current).toBe(true);
  });

  it('should include lastSequence on reconnection', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    mockSocket.connected = true;

    const { result } = renderHook(() => useTerminalSubscription(sessionId, xtermRef, mockDispatch));

    // First subscription (first attach - sets hasEverSubscribedRef to true)
    act(() => {
      result.current.attemptSubscription();
    });

    // Reset for reconnection scenario
    mockSocket.emit.mockClear();
    act(() => {
      result.current.isSubscribedRef.current = false; // Allow re-subscription
      result.current.lastSequenceRef.current = 123;
    });

    // Reconnection attempt (not first attach - should include lastSequence)
    act(() => {
      result.current.attemptSubscription();
    });

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'terminal:subscribe',
      expect.objectContaining({
        lastSequence: 123,
      }),
    );
  });

  it('should be idempotent - safe to call multiple times', () => {
    const sessionId = 'test-session';
    const xtermRef = { current: mockTerminal };
    mockSocket.connected = true;

    const { result } = renderHook(() => useTerminalSubscription(sessionId, xtermRef, mockDispatch));

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

    const { result } = renderHook(() => useTerminalSubscription(sessionId, xtermRef, mockDispatch));

    expect(result.current.lastSequenceRef).toBeDefined();
    expect(result.current.isSubscribedRef).toBeDefined();
    expect(result.current.expectingSeedRef).toBeDefined();
    expect(result.current.attemptSubscription).toBeInstanceOf(Function);
  });
});
