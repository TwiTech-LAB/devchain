import { renderHook } from '@testing-library/react';
import { act } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { useTerminalResize } from './useTerminalResize';
import { termLog } from '@/ui/lib/debug';

jest.mock('@/ui/lib/debug');

// Mock socket
const mockSocket = {
  emit: jest.fn(),
  connected: true,
};

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: () => mockSocket,
}));

describe('useTerminalResize', () => {
  let mockTerminal: Terminal;
  let mockFitAddon: FitAddon;
  let mockContainerElement: HTMLDivElement;
  let mockResizeObserver: jest.Mock;

  beforeEach(() => {
    mockTerminal = {
      cols: 80,
      rows: 24,
    } as Terminal;

    mockFitAddon = {
      fit: jest.fn(),
    } as unknown as FitAddon;

    mockContainerElement = document.createElement('div');

    // Mock ResizeObserver
    mockResizeObserver = jest.fn().mockImplementation((callback) => ({
      observe: jest.fn((element) => {
        // Store callback for manual triggering
        (element as HTMLElement & { _resizeCallback?: ResizeObserverCallback })._resizeCallback =
          callback;
      }),
      disconnect: jest.fn(),
      unobserve: jest.fn(),
    }));

    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = mockResizeObserver;

    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should setup ResizeObserver when terminal is ready', () => {
    const terminalRef = { current: mockContainerElement };
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    const sessionId = 'test-session';

    renderHook(() => useTerminalResize(terminalRef, xtermRef, fitAddonRef, sessionId));

    expect(mockResizeObserver).toHaveBeenCalled();
  });

  it('should debounce resize events (250ms)', () => {
    const terminalRef = { current: mockContainerElement };
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    const sessionId = 'test-session';

    renderHook(() => useTerminalResize(terminalRef, xtermRef, fitAddonRef, sessionId));

    // Trigger resize callback multiple times
    const callback = (
      mockContainerElement as HTMLElement & { _resizeCallback?: ResizeObserverCallback }
    )._resizeCallback;
    act(() => {
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
    });

    // Should not emit yet (debounced)
    expect(mockSocket.emit).not.toHaveBeenCalled();

    // Fast-forward 250ms
    act(() => {
      jest.advanceTimersByTime(250);
    });

    // Should emit once after debounce
    expect(mockFitAddon.fit).toHaveBeenCalledTimes(1);
    expect(mockSocket.emit).toHaveBeenCalledTimes(1);
    expect(mockSocket.emit).toHaveBeenCalledWith('terminal:resize', {
      sessionId,
      cols: 80,
      rows: 24,
    });
  });

  it('should only emit when dimensions actually change', () => {
    const terminalRef = { current: mockContainerElement };
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    const sessionId = 'test-session';

    renderHook(() => useTerminalResize(terminalRef, xtermRef, fitAddonRef, sessionId));

    const callback = (
      mockContainerElement as HTMLElement & { _resizeCallback?: ResizeObserverCallback }
    )._resizeCallback;

    // First resize
    act(() => {
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      jest.advanceTimersByTime(250);
    });

    expect(mockSocket.emit).toHaveBeenCalledTimes(1);
    jest.clearAllMocks();

    // Second resize with same dimensions
    act(() => {
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      jest.advanceTimersByTime(250);
    });

    // Should not emit (dimensions unchanged)
    expect(mockSocket.emit).not.toHaveBeenCalled();

    // Change dimensions
    (mockTerminal as Terminal & { cols: number; rows: number }).cols = 100;
    (mockTerminal as Terminal & { rows: number }).rows = 30;

    // Third resize with new dimensions
    act(() => {
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      jest.advanceTimersByTime(250);
    });

    // Should emit with new dimensions
    expect(mockSocket.emit).toHaveBeenCalledTimes(1);
    expect(mockSocket.emit).toHaveBeenCalledWith('terminal:resize', {
      sessionId,
      cols: 100,
      rows: 30,
    });
  });

  it('should not setup observer if terminal is not ready', () => {
    // When terminalRef.current is null, no container to observe
    const terminalRef = { current: null };
    const xtermRef = { current: null };
    const fitAddonRef = { current: mockFitAddon };
    const sessionId = 'test-session';

    renderHook(() => useTerminalResize(terminalRef, xtermRef, fitAddonRef, sessionId));

    // ResizeObserver is created but observe() is not called since there's no container
    expect(mockResizeObserver).toHaveBeenCalled();
    const observerInstance = mockResizeObserver.mock.results[0].value;
    expect(observerInstance.observe).not.toHaveBeenCalled();
  });

  it('should disconnect observer on unmount', () => {
    const terminalRef = { current: mockContainerElement };
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    const sessionId = 'test-session';

    const { unmount } = renderHook(() =>
      useTerminalResize(terminalRef, xtermRef, fitAddonRef, sessionId),
    );

    const observerInstance = mockResizeObserver.mock.results[0].value;

    unmount();

    expect(observerInstance.disconnect).toHaveBeenCalled();
  });

  it('should log resize events', () => {
    const terminalRef = { current: mockContainerElement };
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    const sessionId = 'test-session';

    renderHook(() => useTerminalResize(terminalRef, xtermRef, fitAddonRef, sessionId));

    const callback = (
      mockContainerElement as HTMLElement & { _resizeCallback?: ResizeObserverCallback }
    )._resizeCallback;
    act(() => {
      // ResizeObserverCallback requires entries and observer args
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      jest.advanceTimersByTime(250);
    });

    expect(termLog).toHaveBeenCalledWith('resize', {
      sessionId,
      cols: 80,
      rows: 24,
      isInitialResize: true,
    });
  });
});
