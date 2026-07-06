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
      scrollToBottom: jest.fn(),
    } as unknown as Terminal;

    mockFitAddon = {
      fit: jest.fn(),
    } as unknown as FitAddon;

    mockContainerElement = document.createElement('div');
    // jsdom reports offsetParent === null for every element (no layout engine). Default the
    // mock container to "visible" so the existing resize path runs; the hidden-container test
    // overrides this per-case.
    Object.defineProperty(mockContainerElement, 'offsetParent', {
      configurable: true,
      get: () => document.body,
    });

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

  it('scrolls to bottom on a non-initial resize without force-setting hasHistory', () => {
    const terminalRef = { current: mockContainerElement };
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    const sessionId = 'test-session';

    renderHook(() => useTerminalResize(terminalRef, xtermRef, fitAddonRef, sessionId));

    const callback = (
      mockContainerElement as HTMLElement & { _resizeCallback?: ResizeObserverCallback }
    )._resizeCallback;

    // First (initial) resize establishes the dimension baseline.
    act(() => {
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      jest.advanceTimersByTime(250);
    });
    expect(mockTerminal.scrollToBottom).not.toHaveBeenCalled();

    // Change dimensions and resize again (non-initial).
    (mockTerminal as Terminal & { cols: number; rows: number }).cols = 100;
    (mockTerminal as Terminal & { rows: number }).rows = 30;
    act(() => {
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      jest.advanceTimersByTime(250);
    });

    // scrollToBottom is scheduled 300ms after the resize settles.
    expect(mockTerminal.scrollToBottom).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(mockTerminal.scrollToBottom).toHaveBeenCalledTimes(1);

    // The log no longer carries hasHistoryReset: this hook is no longer the hasHistory owner.
    expect(termLog).toHaveBeenCalledWith('resize_scroll_bottom', {
      sessionId,
      cols: 100,
      rows: 30,
    });
  });

  it('should skip fit and resize emission while the container is hidden', () => {
    // Hidden container: offsetParent === null (a display:none ancestor).
    Object.defineProperty(mockContainerElement, 'offsetParent', {
      configurable: true,
      get: () => null,
    });

    const terminalRef = { current: mockContainerElement };
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    const sessionId = 'test-session';

    renderHook(() => useTerminalResize(terminalRef, xtermRef, fitAddonRef, sessionId));

    const callback = (
      mockContainerElement as HTMLElement & { _resizeCallback?: ResizeObserverCallback }
    )._resizeCallback;
    act(() => {
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      jest.advanceTimersByTime(250);
    });

    expect(mockFitAddon.fit).not.toHaveBeenCalled();
    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(termLog).toHaveBeenCalledWith('resize_skipped', { sessionId, reason: 'hidden' });
  });

  it('should emit resize via provided socket when supplied', () => {
    const terminalRef = { current: mockContainerElement };
    const xtermRef = { current: mockTerminal };
    const fitAddonRef = { current: mockFitAddon };
    const sessionId = 'test-session';
    const providedSocket = {
      emit: jest.fn(),
      connected: true,
    };
    mockSocket.connected = false;

    renderHook(() =>
      useTerminalResize(
        terminalRef,
        xtermRef,
        fitAddonRef,
        sessionId,
        undefined,
        providedSocket as never,
      ),
    );

    const callback = (
      mockContainerElement as HTMLElement & { _resizeCallback?: ResizeObserverCallback }
    )._resizeCallback;
    act(() => {
      callback?.([] as ResizeObserverEntry[], {} as ResizeObserver);
      jest.advanceTimersByTime(250);
    });

    expect(providedSocket.emit).toHaveBeenCalledWith('terminal:resize', {
      sessionId,
      cols: 80,
      rows: 24,
    });
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });
});
