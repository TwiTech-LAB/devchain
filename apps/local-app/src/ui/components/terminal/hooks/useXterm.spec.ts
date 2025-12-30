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
});
