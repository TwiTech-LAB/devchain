import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useXterm } from './useXterm';
import { termLog } from '@/ui/lib/debug';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '@/common/constants/terminal';

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
      onData: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      onScroll: jest.fn().mockReturnValue({ dispose: jest.fn() }),
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
        convertEol: true,
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
        undefined, // hasHistoryRef
        undefined, // isLoadingHistoryRef
        undefined, // historyViewportOffsetRef
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
          undefined,
          undefined,
          undefined,
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
          undefined,
          undefined,
          undefined,
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
          undefined,
          undefined,
          undefined,
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

  describe('wheel handler mouse tracking conditional', () => {
    /**
     * Helper: render useXterm with given inputMode, capture the callback
     * passed to attachCustomWheelEventHandler, then set mouseTrackingMode.
     */
    function setupWheelTest(inputMode: 'form' | 'tty', mouseTrackingMode: string) {
      const terminalRef = { current: mockContainerElement };
      const { result } = renderHook(() => {
        const xtermRef = useRef<Terminal | null>(null);
        const fitAddonRef = useRef<FitAddon | null>(null);
        useXterm(terminalRef, 'test-session', xtermRef, fitAddonRef, undefined, inputMode);
        return { xtermRef, fitAddonRef };
      });

      const terminal = result.current.xtermRef.current as Record<string, unknown>;
      // Mutate modes to desired tracking mode (read dynamically by the callback)
      (terminal.modes as { mouseTrackingMode: string }).mouseTrackingMode = mouseTrackingMode;

      // Extract the callback registered with attachCustomWheelEventHandler
      const wheelCallback = (terminal.attachCustomWheelEventHandler as jest.Mock).mock
        .calls[0][0] as (event: WheelEvent) => boolean;

      return { terminal, wheelCallback };
    }

    function makeWheelEvent(deltaY: number): WheelEvent {
      return { deltaY, preventDefault: jest.fn() } as unknown as WheelEvent;
    }

    // --- TTY mode + wheel-capable tracking modes → bypass to xterm (return true) ---

    it('tty + any: bypasses to xterm (returns true, no scrollLines)', () => {
      const { terminal, wheelCallback } = setupWheelTest('tty', 'any');
      const event = makeWheelEvent(120);

      expect(wheelCallback(event)).toBe(true);
      expect(terminal.scrollLines).not.toHaveBeenCalled();
    });

    it('tty + drag: bypasses to xterm (returns true, no scrollLines)', () => {
      const { terminal, wheelCallback } = setupWheelTest('tty', 'drag');
      const event = makeWheelEvent(120);

      expect(wheelCallback(event)).toBe(true);
      expect(terminal.scrollLines).not.toHaveBeenCalled();
    });

    it('tty + vt200: bypasses to xterm (returns true, no scrollLines)', () => {
      const { terminal, wheelCallback } = setupWheelTest('tty', 'vt200');
      const event = makeWheelEvent(120);

      expect(wheelCallback(event)).toBe(true);
      expect(terminal.scrollLines).not.toHaveBeenCalled();
    });

    // --- TTY mode + non-wheel tracking modes → custom dampened scroll ---

    it('tty + none: custom scroll (scrollLines called, returns false)', () => {
      const { terminal, wheelCallback } = setupWheelTest('tty', 'none');
      const event = makeWheelEvent(120);

      expect(wheelCallback(event)).toBe(false);
      expect(terminal.scrollLines).toHaveBeenCalledWith(2); // Math.sign(120) * max(1, round(1*1.5)) = 2
      expect((event as unknown as { preventDefault: jest.Mock }).preventDefault).toHaveBeenCalled();
    });

    it('tty + x10: custom scroll (scrollLines called, returns false)', () => {
      const { terminal, wheelCallback } = setupWheelTest('tty', 'x10');
      const event = makeWheelEvent(-240);

      expect(wheelCallback(event)).toBe(false);
      expect(terminal.scrollLines).toHaveBeenCalledWith(-3); // Math.sign(-240) * max(1, round(2*1.5)) = -3
      expect((event as unknown as { preventDefault: jest.Mock }).preventDefault).toHaveBeenCalled();
    });

    // --- Form mode → always custom scroll (dead wheel guard) ---

    it('form + any: custom scroll despite active tracking (dead wheel guard)', () => {
      const { terminal, wheelCallback } = setupWheelTest('form', 'any');
      const event = makeWheelEvent(120);

      expect(wheelCallback(event)).toBe(false);
      expect(terminal.scrollLines).toHaveBeenCalledWith(2);
      expect((event as unknown as { preventDefault: jest.Mock }).preventDefault).toHaveBeenCalled();
    });

    it('form + none: custom scroll (returns false)', () => {
      const { terminal, wheelCallback } = setupWheelTest('form', 'none');
      const event = makeWheelEvent(120);

      expect(wheelCallback(event)).toBe(false);
      expect(terminal.scrollLines).toHaveBeenCalledWith(2);
      expect((event as unknown as { preventDefault: jest.Mock }).preventDefault).toHaveBeenCalled();
    });

    // --- Edge case: deltaY === 0 ---

    it('returns false and does not scroll when deltaY is 0', () => {
      const { terminal, wheelCallback } = setupWheelTest('form', 'none');
      const event = makeWheelEvent(0);

      expect(wheelCallback(event)).toBe(false);
      expect(terminal.scrollLines).not.toHaveBeenCalled();
    });
  });
});
