import { renderHook, waitFor } from '@testing-library/react';
import { act, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useXterm } from './useXterm';
import { termLog } from '@/ui/lib/debug';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '@/common/constants/terminal';
import { DARK_XTERM_THEME, OCEAN_XTERM_THEME } from '../terminal-themes';
import { createTerminalHistorySync } from '../terminal-history-sync';

// Mock @xterm/xterm (same pattern as ChatTerminal.spec.tsx)
jest.mock('@xterm/xterm', () => {
  let container: HTMLElement | null = null;
  return {
    Terminal: jest.fn().mockImplementation(() => ({
      loadAddon: jest.fn(),
      open: jest.fn((el: HTMLElement) => {
        container = el;
      }),
      write: jest.fn((data: string, cb?: () => void) => {
        if (container) container.textContent = (container.textContent || '') + data;
        if (cb) cb();
      }),
      reset: jest.fn(() => {
        if (container) container.textContent = '';
      }),
      dispose: jest.fn(),
      attachCustomWheelEventHandler: jest.fn(),
      scrollLines: jest.fn(),
      scrollToBottom: jest.fn(),
      scrollToLine: jest.fn(),
      onData: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      onScroll: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      onSelectionChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      getSelection: jest.fn().mockReturnValue(''),
      parser: { registerOscHandler: jest.fn().mockReturnValue({ dispose: jest.fn() }) },
      buffer: { active: { viewportY: 0, baseY: 0, cursorY: 0, length: 24 } },
      options: { scrollback: 10000 },
      modes: { mouseTrackingMode: 'none' },
      rows: 24,
      cols: 80,
    })),
  };
});

// Mock @xterm/addon-fit
jest.mock('@xterm/addon-fit', () => ({
  FitAddon: jest.fn().mockImplementation(() => ({
    fit: jest.fn(),
  })),
}));

jest.mock('@/ui/lib/debug', () => ({
  termLog: jest.fn(),
}));

jest.mock('@/ui/hooks/use-toast', () => ({
  toast: jest.fn(),
}));

describe('useXterm', () => {
  let mockContainerElement: HTMLDivElement;

  beforeEach(() => {
    // Create mock container element
    mockContainerElement = document.createElement('div');

    jest.clearAllMocks();
  });

  it('should initialize terminal and fit addon when ref is available', () => {
    const terminalRef = { current: mockContainerElement };
    const sessionId = 'test-session';

    const { result } = renderHook(() => {
      const xtermRef = useRef<Terminal | null>(null);
      const fitAddonRef = useRef<FitAddon | null>(null);
      useXterm(terminalRef, sessionId, xtermRef, fitAddonRef);
      return { xtermRef, fitAddonRef };
    });

    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        convertEol: false,
        scrollback: DEFAULT_TERMINAL_SCROLLBACK,
        cursorBlink: false,
        disableStdin: true,
        theme: expect.any(Object),
      }),
    );
    expect(result.current.xtermRef.current?.loadAddon).toHaveBeenCalled();
    expect(result.current.xtermRef.current?.open).toHaveBeenCalledWith(mockContainerElement);
    expect(termLog).toHaveBeenCalledWith('terminal_init_start', { sessionId });
  });

  it('should call onReady callback after fitting terminal', (done) => {
    const terminalRef = { current: mockContainerElement };
    const sessionId = 'test-session';
    const onReady = jest.fn();

    const { result } = renderHook(() => {
      const xtermRef = useRef<Terminal | null>(null);
      const fitAddonRef = useRef<FitAddon | null>(null);
      useXterm(terminalRef, sessionId, xtermRef, fitAddonRef, onReady);
      return { xtermRef, fitAddonRef };
    });

    // onReady is called in setTimeout(..., 0)
    setTimeout(() => {
      expect(result.current.fitAddonRef.current?.fit).toHaveBeenCalled();
      expect(onReady).toHaveBeenCalled();
      done();
    }, 10);
  });

  it('should not initialize if container ref is null', () => {
    const terminalRef = { current: null };
    const sessionId = 'test-session';

    renderHook(() => {
      const xtermRef = useRef<Terminal | null>(null);
      const fitAddonRef = useRef<FitAddon | null>(null);
      useXterm(terminalRef, sessionId, xtermRef, fitAddonRef);
    });

    expect(Terminal).not.toHaveBeenCalled();
    expect(termLog).toHaveBeenCalledWith('terminal_init_blocked', {
      sessionId,
      reason: 'no_container',
    });
  });

  it('should dispose terminal on unmount', () => {
    const terminalRef = { current: mockContainerElement };
    const sessionId = 'test-session';

    const { result, unmount } = renderHook(() => {
      const xtermRef = useRef<Terminal | null>(null);
      const fitAddonRef = useRef<FitAddon | null>(null);
      useXterm(terminalRef, sessionId, xtermRef, fitAddonRef);
      return { xtermRef, fitAddonRef };
    });

    // Get the terminal instance
    const terminal = result.current.xtermRef.current;

    unmount();

    expect(terminal?.dispose).toHaveBeenCalled();
    expect(termLog).toHaveBeenCalledWith('terminal_dispose', { sessionId });
  });

  it('should populate terminal and fitAddon refs', () => {
    const terminalRef = { current: mockContainerElement };
    const sessionId = 'test-session';

    const { result } = renderHook(() => {
      const xtermRef = useRef<Terminal | null>(null);
      const fitAddonRef = useRef<FitAddon | null>(null);
      useXterm(terminalRef, sessionId, xtermRef, fitAddonRef);
      return { xtermRef, fitAddonRef };
    });

    // Check that refs are populated
    expect(result.current.xtermRef.current).toBeTruthy();
    expect(result.current.fitAddonRef.current).toBeTruthy();
    expect(result.current.xtermRef.current?.dispose).toBeDefined();
    expect(result.current.fitAddonRef.current?.fit).toBeDefined();
  });

  it('decodes OSC 52 clipboard payloads as UTF-8', async () => {
    const terminalRef = { current: mockContainerElement };
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { result } = renderHook(() => {
      const xtermRef = useRef<Terminal | null>(null);
      const fitAddonRef = useRef<FitAddon | null>(null);
      useXterm(terminalRef, 'test-session', xtermRef, fitAddonRef);
      return { xtermRef, fitAddonRef };
    });

    const terminal = result.current.xtermRef.current as Record<string, unknown>;
    const registerOscHandler = (terminal.parser as { registerOscHandler: jest.Mock })
      .registerOscHandler;
    const handler = registerOscHandler.mock.calls.find(([code]) => code === 52)?.[1] as
      | ((data: string) => boolean)
      | undefined;

    expect(handler).toBeDefined();
    expect(handler?.(`c;${Buffer.from('—', 'utf-8').toString('base64')}`)).toBe(true);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('—');
    });

    const { toast } = jest.requireMock('@/ui/hooks/use-toast');
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Copied to clipboard',
        description: '1 character from the terminal',
      }),
    );
  });

  it('should not reinitialize if terminal already exists', () => {
    const terminalRef = { current: mockContainerElement };
    const sessionId = 'test-session';

    const { rerender, result } = renderHook(() => {
      const xtermRef = useRef<Terminal | null>(null);
      const fitAddonRef = useRef<FitAddon | null>(null);
      useXterm(terminalRef, sessionId, xtermRef, fitAddonRef);
      return { xtermRef, fitAddonRef };
    });

    // Get the terminal instance
    const firstTerminal = result.current.xtermRef.current;

    // Force rerender of the same hook
    rerender();

    // Should still have the same terminal instance (not create a new one)
    expect(result.current.xtermRef.current).toBe(firstTerminal);
  });

  it('should use custom scrollbackLines for Terminal creation (within valid range)', () => {
    const terminalRef = { current: mockContainerElement };
    const sessionId = 'test-session';
    const customScrollback = 25000; // Within MIN (100) and MAX (50000)

    renderHook(() => {
      const xtermRef = useRef<Terminal | null>(null);
      const fitAddonRef = useRef<FitAddon | null>(null);
      useXterm(
        terminalRef,
        sessionId,
        xtermRef,
        fitAddonRef,
        undefined, // onReady
        'form', // inputMode
        undefined, // historySync
        undefined, // isSubscribedRef
        undefined, // isLoadingHistoryRef
        undefined, // isHistoryInFlightRef
        undefined, // pendingHistoryFramesRef
        customScrollback,
      );
      return { xtermRef, fitAddonRef };
    });

    expect(Terminal).toHaveBeenCalledWith(
      expect.objectContaining({
        scrollback: customScrollback,
      }),
    );
  });

  describe('scrollbackLines clamping (C1)', () => {
    it('should clamp scrollbackLines below minimum to MIN_TERMINAL_SCROLLBACK', () => {
      const terminalRef = { current: mockContainerElement };
      const sessionId = 'test-session';
      const belowMin = 10; // Below MIN_TERMINAL_SCROLLBACK (100)

      renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(
          terminalRef,
          sessionId,
          xtermRef,
          fitAddonRef,
          undefined,
          'form',
          undefined, // historySync
          undefined, // isSubscribedRef
          undefined, // isLoadingHistoryRef
          undefined, // isHistoryInFlightRef
          undefined, // pendingHistoryFramesRef
          belowMin,
        );
        return { xtermRef, fitAddonRef };
      });

      expect(Terminal).toHaveBeenCalledWith(
        expect.objectContaining({
          scrollback: MIN_TERMINAL_SCROLLBACK,
        }),
      );
    });

    it('should clamp scrollbackLines above maximum to MAX_TERMINAL_SCROLLBACK', () => {
      const terminalRef = { current: mockContainerElement };
      const sessionId = 'test-session';
      const aboveMax = 100000; // Above MAX_TERMINAL_SCROLLBACK (50000)

      renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(
          terminalRef,
          sessionId,
          xtermRef,
          fitAddonRef,
          undefined,
          'form',
          undefined, // historySync
          undefined, // isSubscribedRef
          undefined, // isLoadingHistoryRef
          undefined, // isHistoryInFlightRef
          undefined, // pendingHistoryFramesRef
          aboveMax,
        );
        return { xtermRef, fitAddonRef };
      });

      expect(Terminal).toHaveBeenCalledWith(
        expect.objectContaining({
          scrollback: MAX_TERMINAL_SCROLLBACK,
        }),
      );
    });

    it('should use DEFAULT_TERMINAL_SCROLLBACK when scrollbackLines is undefined', () => {
      const terminalRef = { current: mockContainerElement };
      const sessionId = 'test-session';

      renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(
          terminalRef,
          sessionId,
          xtermRef,
          fitAddonRef,
          undefined,
          'form',
          // No scrollbackLines passed - uses default
        );
        return { xtermRef, fitAddonRef };
      });

      expect(Terminal).toHaveBeenCalledWith(
        expect.objectContaining({
          scrollback: DEFAULT_TERMINAL_SCROLLBACK,
        }),
      );
    });

    it('should pass valid values unchanged', () => {
      const terminalRef = { current: mockContainerElement };
      const sessionId = 'test-session';
      const validValue = 5000; // Well within range

      renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(
          terminalRef,
          sessionId,
          xtermRef,
          fitAddonRef,
          undefined,
          'form',
          undefined, // historySync
          undefined, // isSubscribedRef
          undefined, // isLoadingHistoryRef
          undefined, // isHistoryInFlightRef
          undefined, // pendingHistoryFramesRef
          validValue,
        );
        return { xtermRef, fitAddonRef };
      });

      expect(Terminal).toHaveBeenCalledWith(
        expect.objectContaining({
          scrollback: validValue,
        }),
      );
    });
  });

  describe('wheel movement ownership (xterm 6 is the sole owner)', () => {
    /**
     * Regression guard for the xterm 6 seam: useXterm no longer installs a movement-owning
     * custom wheel handler and never calls `scrollLines` itself, so xterm 6's
     * SmoothScrollableElement is the sole owner of viewport movement and cannot be double-scrolled.
     * The full wheel/scrollbar routing matrix lives in `scroll-intent-binding.spec.ts`.
     */
    it('does not attach a custom wheel handler or manually scroll on a container wheel', () => {
      const terminalRef = { current: mockContainerElement };
      const { result } = renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(terminalRef, 'test-session', xtermRef, fitAddonRef, undefined, 'form');
        return { xtermRef, fitAddonRef };
      });
      const terminal = result.current.xtermRef.current as Record<string, unknown>;

      mockContainerElement.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }),
      );

      expect(terminal.attachCustomWheelEventHandler).not.toHaveBeenCalled();
      expect(terminal.scrollLines).not.toHaveBeenCalled();
    });

    it('surfaces a scroll-intent controller and clears it on unmount', () => {
      const terminalRef = { current: mockContainerElement };
      const onController = jest.fn();
      const { unmount } = renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(
          terminalRef,
          'test-session',
          xtermRef,
          fitAddonRef,
          undefined,
          'form',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          DEFAULT_TERMINAL_SCROLLBACK,
          undefined, // socket
          undefined, // appTheme
          undefined, // onTerminalChange
          onController,
        );
        return { xtermRef, fitAddonRef };
      });

      expect(onController).toHaveBeenCalledTimes(1);
      const controller = onController.mock.calls[0][0];
      expect(typeof controller.isDragActive).toBe('function');
      expect(typeof controller.onDragEnd).toBe('function');
      expect(typeof controller.dispose).toBe('function');
      expect(controller.isDragActive()).toBe(false);

      unmount();
      expect(onController).toHaveBeenLastCalledWith(null);
    });
  });

  describe('appTheme initialization and live update', () => {
    it('initializes with dark xterm theme by default', () => {
      const terminalRef = { current: mockContainerElement };

      renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(terminalRef, 'test-session', xtermRef, fitAddonRef);
        return { xtermRef, fitAddonRef };
      });

      expect(Terminal).toHaveBeenCalledWith(
        expect.objectContaining({
          theme: DARK_XTERM_THEME,
        }),
      );
    });

    it('initializes with ocean xterm theme when appTheme is ocean', () => {
      const terminalRef = { current: mockContainerElement };

      renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(
          terminalRef,
          'test-session',
          xtermRef,
          fitAddonRef,
          undefined,
          'form',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          DEFAULT_TERMINAL_SCROLLBACK,
          undefined,
          'ocean',
        );
        return { xtermRef, fitAddonRef };
      });

      expect(Terminal).toHaveBeenCalledWith(
        expect.objectContaining({
          theme: OCEAN_XTERM_THEME,
        }),
      );
    });

    it('updates terminal options.theme on live theme change without dispose', () => {
      const terminalRef = { current: mockContainerElement };
      let appTheme: 'dark' | 'ocean' = 'dark';

      const { result, rerender } = renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(
          terminalRef,
          'test-session',
          xtermRef,
          fitAddonRef,
          undefined,
          'form',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          DEFAULT_TERMINAL_SCROLLBACK,
          undefined,
          appTheme,
        );
        return { xtermRef, fitAddonRef };
      });

      const terminal = result.current.xtermRef.current;
      expect(terminal).toBeTruthy();
      expect(terminal!.options.theme).toBe(DARK_XTERM_THEME);

      // Change theme to ocean
      appTheme = 'ocean';
      rerender();

      // Terminal should NOT be disposed/recreated
      expect(result.current.xtermRef.current).toBe(terminal);
      expect(terminal!.dispose).not.toHaveBeenCalled();

      // Theme should be updated on the existing instance
      expect(terminal!.options.theme).toBe(OCEAN_XTERM_THEME);
    });

    it('updates from ocean back to dark without remount', () => {
      const terminalRef = { current: mockContainerElement };
      let appTheme: 'dark' | 'ocean' = 'ocean';

      const { result, rerender } = renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(
          terminalRef,
          'test-session',
          xtermRef,
          fitAddonRef,
          undefined,
          'form',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          DEFAULT_TERMINAL_SCROLLBACK,
          undefined,
          appTheme,
        );
        return { xtermRef, fitAddonRef };
      });

      const terminal = result.current.xtermRef.current;
      expect(terminal!.options.theme).toBe(OCEAN_XTERM_THEME);

      appTheme = 'dark';
      rerender();

      expect(result.current.xtermRef.current).toBe(terminal);
      expect(terminal!.dispose).not.toHaveBeenCalled();
      expect(terminal!.options.theme).toBe(DARK_XTERM_THEME);
    });
  });

  describe('visibility-aware scroll guard and re-show restore', () => {
    /**
     * Test layer: UI hook (jsdom). Proves the WIRING between useXterm and the detector seam —
     * that visibility is read from `offsetParent`, gates the history request, and drives the
     * deterministic re-show restore. The policy math itself is proven cheaper in
     * `scroll-history-detector.spec.ts`; here we only simulate viewport moves via the mock buffer
     * and make no claim about real-browser scroll event ordering.
     */
    const mockSocket = { emit: jest.fn(), connected: true, id: 'sock-1' };

    function setVisible(el: HTMLElement, visible: boolean) {
      Object.defineProperty(el, 'offsetParent', {
        configurable: true,
        get: () => (visible ? document.body : null),
      });
    }

    function renderScrollHook(refreshable: boolean, inputMode: 'form' | 'tty' = 'form') {
      // A refreshable, settled owner with no baseline is dirty → request-eligible; a
      // non-refreshable one is not. The detector adds gesture/visibility/cooldown on top.
      const historySync = createTerminalHistorySync();
      historySync.adoptRefreshable(refreshable);
      historySync.settle();
      const isSubscribedRef = { current: true };
      const isLoadingHistoryRef = { current: false };
      const isHistoryInFlightRef = { current: false };
      const pendingHistoryFramesRef = { current: [] as { sequence: number; data: string }[] };
      const terminalRef = { current: mockContainerElement };

      const { result } = renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(
          terminalRef,
          'test-session',
          xtermRef,
          fitAddonRef,
          undefined,
          inputMode,
          historySync,
          isSubscribedRef,
          isLoadingHistoryRef,
          isHistoryInFlightRef,
          pendingHistoryFramesRef,
          DEFAULT_TERMINAL_SCROLLBACK,
          mockSocket as never,
        );
        return { xtermRef, fitAddonRef };
      });

      const terminal = result.current.xtermRef.current as unknown as {
        buffer: { active: { viewportY: number; baseY: number } };
        scrollToBottom: jest.Mock;
        scrollToLine: jest.Mock;
      };
      return { terminal, isHistoryInFlightRef };
    }

    beforeEach(() => {
      jest.useFakeTimers();
      mockSocket.emit.mockClear();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function emittedFullHistory() {
      return mockSocket.emit.mock.calls.some(
        ([event]) => event === 'terminal:request_full_history',
      );
    }

    // Dispatch the capture-phase Shift+PageUp keyboard gesture on the terminal container,
    // mirroring a real user scroll intent. Fake timers freeze Date.now(), so the stamped
    // timestamp tracks jest.advanceTimersByTime.
    function stampKeyboardGesture() {
      act(() => {
        mockContainerElement.dispatchEvent(
          new KeyboardEvent('keydown', {
            shiftKey: true,
            code: 'PageUp',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }

    it('requests full history on a genuine scroll-up while visible', () => {
      setVisible(mockContainerElement, true);
      const { terminal } = renderScrollHook(true);

      // Establish at-bottom baseline.
      terminal.buffer.active.baseY = 100;
      terminal.buffer.active.viewportY = 100;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(false);

      // A real user gesture authorizes the request.
      stampKeyboardGesture();

      // Scroll up (leaving the bottom).
      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(true);
    });

    it('does NOT request on a programmatic scroll-up with no user gesture', () => {
      setVisible(mockContainerElement, true);
      const { terminal } = renderScrollHook(true);

      terminal.buffer.active.baseY = 100;
      terminal.buffer.active.viewportY = 100;
      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Programmatic leaving-bottom with no gesture (resize reflow / stale-scrollTop sync).
      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(false);
    });

    it('never requests full history while hidden even if the buffer jumps to the top', () => {
      setVisible(mockContainerElement, false);
      const { terminal } = renderScrollHook(true);

      // Buffer viewport races to the top while hidden (the corruption we defend against).
      terminal.buffer.active.baseY = 100;
      terminal.buffer.active.viewportY = 0;
      act(() => {
        jest.advanceTimersByTime(100);
      });

      expect(emittedFullHistory()).toBe(false);
    });

    it('restores the viewport to bottom on re-show and re-enables genuine scroll-up', () => {
      setVisible(mockContainerElement, true);
      const { terminal } = renderScrollHook(true);

      // Visible, at bottom.
      terminal.buffer.active.baseY = 100;
      terminal.buffer.active.viewportY = 100;
      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Hide the container (poll arms the pending-restore latch).
      setVisible(mockContainerElement, false);
      act(() => {
        jest.advanceTimersByTime(100);
      });

      // Re-show with a corrupted (top) viewport; a raced poll must be suppressed, not emit.
      setVisible(mockContainerElement, true);
      terminal.buffer.active.viewportY = 0;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(false);
      expect(terminal.scrollToBottom).not.toHaveBeenCalled();

      // After the settle delay the deterministic restore runs.
      act(() => {
        jest.advanceTimersByTime(300);
      });
      expect(terminal.scrollToBottom).toHaveBeenCalled();

      // Detector was reset (intent cleared) → a programmatic scroll-up alone must NOT emit.
      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(false);

      // A fresh genuine gesture re-enables the request after restore.
      terminal.buffer.active.viewportY = 100;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      stampKeyboardGesture();
      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(true);
    });

    it('restores the viewport to the saved offset (not bottom) on re-show when the user was browsing history', () => {
      setVisible(mockContainerElement, true);
      const { terminal } = renderScrollHook(true);

      // At bottom.
      terminal.buffer.active.baseY = 100;
      terminal.buffer.active.viewportY = 100;
      act(() => {
        jest.advanceTimersByTime(100);
      });

      // User had scrolled up into history (30 lines above the bottom). lastVisible tracking is
      // independent of the gesture gate, so a programmatic move is enough to seed the offset the
      // restore must return to — no request fires here.
      terminal.buffer.active.viewportY = 70;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(false);

      // Hide → re-show with the stale-scrollTop race (viewport clamped to top while hidden).
      setVisible(mockContainerElement, false);
      act(() => {
        jest.advanceTimersByTime(100);
      });
      setVisible(mockContainerElement, true);
      terminal.buffer.active.viewportY = 0;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(false);

      // After the settle delay the deterministic restore runs the NON-bottom branch:
      // scrollToLine(baseY - offsetFromBottom) = scrollToLine(100 - 30) = 70.
      act(() => {
        jest.advanceTimersByTime(300);
      });
      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
      expect(terminal.scrollToLine).toHaveBeenCalledWith(70);
    });

    // Routing proof: dispatch a real capture-phase wheel on the STABLE container (where the seam
    // observes it) rather than invoking a custom callback directly.
    function dispatchWheel(deltaY: number) {
      act(() => {
        mockContainerElement.dispatchEvent(
          new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }),
        );
      });
    }

    // Build the xterm 6 scrollbar subtree under the container: a pointerdown on the real vertical
    // scrollbar (track/slider) routes through the seam; a pointerdown on the screen is content
    // selection and must not.
    function buildScrollbar() {
      const scrollable = document.createElement('div');
      scrollable.className = 'xterm-scrollable-element';
      const scrollbar = document.createElement('div');
      scrollbar.className = 'scrollbar vertical';
      const slider = document.createElement('div');
      slider.className = 'slider';
      const screen = document.createElement('div');
      screen.className = 'xterm-screen';
      scrollbar.appendChild(slider);
      scrollable.appendChild(scrollbar);
      scrollable.appendChild(screen);
      mockContainerElement.appendChild(scrollable);
      return { slider, screen };
    }

    function establishAtBottom(terminal: {
      buffer: { active: { viewportY: number; baseY: number } };
    }) {
      terminal.buffer.active.baseY = 100;
      terminal.buffer.active.viewportY = 100;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      mockSocket.emit.mockClear();
    }

    it('host-path wheel-up stamps intent and triggers a request', () => {
      setVisible(mockContainerElement, true);
      const { terminal } = renderScrollHook(true);
      establishAtBottom(terminal);

      // Host-scroll wheel-up (form mode, no mouse tracking) stamps intent via the container seam.
      dispatchWheel(-120);

      // The scroll lands above the bottom; the poll sees fresh intent → emits.
      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(true);
    });

    it('wheel forwarded to a TUI with mouse tracking does NOT stamp intent', () => {
      setVisible(mockContainerElement, true);
      const { terminal } = renderScrollHook(true, 'tty');
      // TUI has wheel-capable mouse tracking → xterm forwards the wheel; the seam must not stamp.
      (terminal as unknown as { modes: { mouseTrackingMode: string } }).modes.mouseTrackingMode =
        'any';
      establishAtBottom(terminal);

      dispatchWheel(-120);

      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(false);
    });

    it('Shift+PageDown also stamps intent (xterm viewport scroll key)', () => {
      setVisible(mockContainerElement, true);
      const { terminal } = renderScrollHook(true);
      establishAtBottom(terminal);

      act(() => {
        mockContainerElement.dispatchEvent(
          new KeyboardEvent('keydown', {
            shiftKey: true,
            code: 'PageDown',
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(true);
    });

    it('unmodified PageUp (a shell key sequence) does NOT stamp intent', () => {
      setVisible(mockContainerElement, true);
      const { terminal } = renderScrollHook(true);
      establishAtBottom(terminal);

      act(() => {
        mockContainerElement.dispatchEvent(
          new KeyboardEvent('keydown', { code: 'PageUp', bubbles: true, cancelable: true }),
        );
      });

      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(false);
    });

    it('pointerdown on the vertical scrollbar stamps intent', () => {
      setVisible(mockContainerElement, true);
      const { slider } = buildScrollbar();
      const { terminal } = renderScrollHook(true);
      establishAtBottom(terminal);

      act(() => {
        slider.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });

      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(true);
    });

    it('pointerdown on terminal content (selection) does NOT stamp intent', () => {
      setVisible(mockContainerElement, true);
      const { screen } = buildScrollbar();
      const { terminal } = renderScrollHook(true);
      establishAtBottom(terminal);

      act(() => {
        screen.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });

      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(false);
    });

    it('slow scrollbar drag past the decay window still loads history via pointermove refresh', () => {
      setVisible(mockContainerElement, true);
      const { slider } = buildScrollbar();
      const { terminal } = renderScrollHook(true);
      establishAtBottom(terminal);

      // Drag starts (scrollbar pointerdown stamps intent and begins the drag).
      act(() => {
        slider.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      });

      // Hold the drag longer than SCROLL_GESTURE_STALE_MS without moving the viewport.
      act(() => {
        jest.advanceTimersByTime(2500);
      });

      // A pointermove mid-drag (observed on window while the drag is active) refreshes intent.
      act(() => {
        window.dispatchEvent(new Event('pointermove', { bubbles: true }));
      });

      terminal.buffer.active.viewportY = 40;
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(emittedFullHistory()).toBe(true);
    });
  });
});
