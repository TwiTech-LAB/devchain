import {
  act,
  cleanup as rtlCleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from '@testing-library/react';

jest.mock('@xterm/xterm/css/xterm.css', () => ({}), { virtual: true });
const xtermScrollCallbacks: Array<() => void> = [];

jest.mock('@xterm/xterm', () => {
  return {
    Terminal: jest.fn().mockImplementation(function (this: object) {
      let container: HTMLElement | null = null;
      const bufferActive = {
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        length: 0,
      };

      return {
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
        clear: jest.fn(() => {
          if (container) container.textContent = '';
        }),
        dispose: jest.fn(() => {
          container = null;
        }),
        rows: 24,
        cols: 80,
        element: null,
        scrollLines: jest.fn(),
        scrollToBottom: jest.fn(),
        scrollToLine: jest.fn(),
        focus: jest.fn(),
        attachCustomWheelEventHandler: jest.fn(),
        onScroll: jest.fn((cb: () => void) => {
          xtermScrollCallbacks.push(cb);
          return { dispose: jest.fn() };
        }),
        onData: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        onSelectionChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        getSelection: jest.fn().mockReturnValue(''),
        parser: { registerOscHandler: jest.fn() },
        options: { scrollback: 10000 },
        modes: { mouseTrackingMode: 'none' },
        buffer: { active: bufferActive },
      };
    }),
  };
});

import type { Socket } from 'socket.io-client';

// Socket reference for socket.io-client mock - set per test
let currentAppSocket: Socket | null = null;

jest.mock('socket.io-client', () => ({
  io: () => currentAppSocket,
}));

jest.mock('@/ui/lib/debug', () => ({
  termLog: jest.fn(),
}));

import { ChatTerminal } from './ChatTerminal';
import { _resetThemeCacheForTesting, useTerminalThemeSync } from './hooks/useTerminalThemeSync';
import { DEFAULT_TERMINAL_SCROLLBACK } from '@/common/constants/terminal';

type SocketHandlerMap = Record<string, Set<(...args: unknown[]) => void>>;

interface MockSocket {
  id: string;
  connected: boolean;
  emit: jest.Mock;
  on: jest.Mock;
  off: jest.Mock;
  trigger: (event: string, ...args: unknown[]) => void;
  clearHandlers: () => void;
}

function createMockSocket(): MockSocket {
  const handlers: SocketHandlerMap = {};

  const socket: MockSocket = {
    id: 'socket-test',
    connected: false,
    emit: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    trigger(event: string, ...args: unknown[]) {
      handlers[event]?.forEach((handler) => handler(...args));
    },
    clearHandlers() {
      Object.keys(handlers).forEach((key) => delete handlers[key]);
    },
  };

  socket.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    handlers[event] = handlers[event] ?? new Set();
    handlers[event]!.add(handler);
    return socket;
  });

  socket.off.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    handlers[event]?.delete(handler);
    return socket;
  });

  return socket;
}

jest.mock('ansi-to-html', () => {
  return jest.fn().mockImplementation(() => ({
    toHtml: jest.fn((input: string) => input),
  }));
});

describe('ChatTerminal', () => {
  beforeAll(() => {
    (global as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = jest
      .fn()
      .mockImplementation(() => ({
        observe: jest.fn(),
        disconnect: jest.fn(),
        unobserve: jest.fn(),
      }));

    // Mock fetch for /api/settings
    global.fetch = jest.fn().mockResolvedValue({
      json: () => Promise.resolve({ terminal: { inputMode: 'form' } }),
    });
  });

  afterAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global.fetch as any)?.mockRestore?.();
  });

  afterEach(() => {
    // Cleanup in correct order: unmount first, then clear socket
    rtlCleanup();
    if (currentAppSocket) {
      (currentAppSocket as unknown as MockSocket).clearHandlers?.();
    }
    currentAppSocket = null;
    xtermScrollCallbacks.length = 0;
    _resetThemeCacheForTesting();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  const renderTerminal = async (useFakeTimers = false) => {
    const socket = createMockSocket();
    currentAppSocket = socket as unknown as Socket;

    const utils = render(<ChatTerminal sessionId="chat-session" socket={currentAppSocket} />);

    // Wait for settings fetch and effects to register
    if (useFakeTimers) {
      // With fake timers, run all pending timers
      await act(async () => {
        jest.runAllTimers();
      });
    } else {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }

    socket.connected = true;
    await act(async () => {
      socket.trigger('connect');
    });

    if (!useFakeTimers) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }

    const region = utils.getByRole('region');
    const viewport = region.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    const history = viewport;

    Object.defineProperty(viewport, 'scrollHeight', {
      configurable: true,
      value: 100,
    });

    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 100,
    });

    return { socket, history, viewport, utils };
  };

  it('assembles seed chunks and writes content (unified seed_ansi contract)', async () => {
    const { socket, history } = await renderTerminal();
    const { termLog } = jest.requireMock('@/ui/lib/debug');

    const seedEnvelope = { topic: 'terminal/chat-session', ts: new Date().toISOString() };

    await act(async () => {
      socket.trigger('message', {
        ...seedEnvelope,
        type: 'seed_ansi',
        payload: { chunk: 0, totalChunks: 2, data: 'A' },
      });
    });
    expect(history.innerHTML).toBe('');

    await act(async () => {
      socket.trigger('message', {
        ...seedEnvelope,
        type: 'data',
        payload: { data: 'C', sequence: 1 },
      });
    });
    expect(history.innerHTML).toBe('');

    await act(async () => {
      socket.trigger('message', {
        ...seedEnvelope,
        type: 'seed_ansi',
        payload: {
          chunk: 1,
          totalChunks: 2,
          data: 'B',
          totalLines: 10,
          viewportStart: 5,
          hasHistory: true,
        },
      });
    });

    // Unified seed_ansi: seed content IS written to xterm before resize jiggle.
    await waitFor(() => {
      expect(history.innerHTML).toBe('AB');
    });

    // Verify that hasHistory is enabled for scroll-up history loading
    const hasHistoryCalls = (termLog as jest.Mock).mock.calls.filter(
      (c) => c[0] === 'seed_hasHistory_enabled',
    );
    expect(hasHistoryCalls.length).toBeGreaterThan(0);
  });

  it('aborts incomplete seed after timeout and flushes pending writes', async () => {
    jest.useFakeTimers();
    const { socket, history } = await renderTerminal(true);

    const env = { topic: 'terminal/chat-session', ts: new Date().toISOString() };

    // Begin seeding (2 chunks total) — do not complete
    await act(async () => {
      socket.trigger('message', {
        ...env,
        type: 'seed_ansi',
        payload: { chunk: 0, totalChunks: 2, data: 'A' },
      });
    });

    // While seeding, data should be buffered, not written
    await act(async () => {
      socket.trigger('message', {
        ...env,
        type: 'data',
        payload: { data: 'B', sequence: 1 },
      });
    });
    expect(history.innerHTML).toBe('');

    // Advance timers to trigger the 30s seed timeout
    await act(async () => {
      jest.advanceTimersByTime(30000);
    });

    // Pending writes are flushed on timeout
    await waitFor(() => {
      expect(history.innerHTML).toBe('B');
    });
  });

  it('handles subscribed event and logs expected seed status (first attach)', async () => {
    const { socket } = await renderTerminal();
    const { termLog } = jest.requireMock('@/ui/lib/debug');

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'subscribed',
        payload: { currentSequence: 0 },
      });
    });

    // Expect a subscribed log with expectingSeed true on first attach
    const calls = (termLog as jest.Mock).mock.calls.filter((c) => c[0] === 'subscribed');
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    expect(last[1]).toEqual(expect.objectContaining({ expectingSeed: true }));
  });

  it('handles subscribed on reconnect: updates sequence and flushes pending writes when not expecting seed', async () => {
    const { socket, history } = await renderTerminal();
    const { termLog } = jest.requireMock('@/ui/lib/debug');

    // Begin seed to enable buffering
    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'seed_ansi',
        payload: { chunk: 0, totalChunks: 2, data: 'A' },
      });
    });

    // Buffer data while seed is incomplete
    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'data',
        payload: { data: 'B', sequence: 5 },
      });
    });
    expect(history.innerHTML).toBe('');

    // Simulate a reconnect scenario
    await act(async () => {
      socket.trigger('disconnect');
      socket.connected = true;
      socket.trigger('connect');
    });

    // Subscribed when not expecting a seed should flush pending writes and preserve sequence
    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'subscribed',
        payload: { currentSequence: 5 },
      });
    });

    // Verify flush occurred
    await waitFor(() => {
      expect(history.innerHTML).toBe('B');
    });

    // Verify log reflects no seed expectation and sequence preserved
    const calls = (termLog as jest.Mock).mock.calls.filter((c) => c[0] === 'subscribed');
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    expect(last[1]).toEqual(expect.objectContaining({ expectingSeed: false, currentSequence: 5 }));
  });

  it('logs focus_changed with authority flag based on clientId', async () => {
    const { socket } = await renderTerminal();
    const { termLog } = jest.requireMock('@/ui/lib/debug');

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'focus_changed',
        payload: { clientId: 'socket-test' },
      });
    });

    let calls = (termLog as jest.Mock).mock.calls.filter((c) => c[0] === 'focus_changed');
    expect(calls.length).toBeGreaterThan(0);
    let last = calls[calls.length - 1];
    expect(last[1]).toEqual(expect.objectContaining({ ours: true }));

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'focus_changed',
        payload: { clientId: 'someone-else' },
      });
    });

    calls = (termLog as jest.Mock).mock.calls.filter((c) => c[0] === 'focus_changed');
    last = calls[calls.length - 1];
    expect(last[1]).toEqual(expect.objectContaining({ ours: false }));
  });

  it('writes data after seed completes (unified seed_ansi writes content)', async () => {
    jest.useFakeTimers();
    const { socket, history } = await renderTerminal(true);

    const seedEnvelope = { topic: 'terminal/chat-session', ts: new Date().toISOString() };

    // Seed content IS written under unified contract
    await act(async () => {
      socket.trigger('message', {
        ...seedEnvelope,
        type: 'seed_ansi',
        payload: { chunk: 0, totalChunks: 1, data: 'Initial' },
      });
    });

    await waitFor(() => {
      expect(history.innerHTML).toBe('Initial');
    });

    // Advance past the seed ready delay (400ms)
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    // After seed, normal data should be written
    await act(async () => {
      socket.trigger('message', {
        ...seedEnvelope,
        type: 'data',
        payload: { data: 'New frame', sequence: 2 },
      });
    });

    await waitFor(() => {
      expect(history.innerHTML).toContain('New frame');
    });

    jest.useRealTimers();
  });

  it('sends form input through the provided socket', async () => {
    const { socket, utils } = await renderTerminal();

    const input = utils.getByPlaceholderText('Type command...');
    fireEvent.change(input, { target: { value: 'echo hello' } });

    const sendButton = utils.getByRole('button', { name: /send/i });
    fireEvent.click(sendButton);

    expect(socket.emit).toHaveBeenCalledWith('terminal:input', {
      sessionId: 'chat-session',
      data: 'echo hello',
    });
  });

  it('requests scrollback history on scroll-up (hasHistory enabled after seed)', async () => {
    jest.useFakeTimers();
    const { socket, history } = await renderTerminal(true);

    const envelope = { topic: 'terminal/chat-session', ts: new Date().toISOString() };

    await act(async () => {
      socket.trigger('message', {
        ...envelope,
        type: 'seed_ansi',
        payload: {
          chunk: 0,
          totalChunks: 1,
          data: 'V',
          totalLines: 10,
          viewportStart: 2,
          hasHistory: true,
        },
      });
    });

    // Unified seed_ansi: seed content is written
    expect(history.innerHTML).toBe('V');

    const initialRequestCount = socket.emit.mock.calls.filter(
      ([event]) => event === 'terminal:request_full_history',
    ).length;

    // Simulate xterm scroll-up: set buffer to show user was at bottom (baseY=10)
    // then scrolled up (viewportY=0). The polling fallback detects this change.
    const { Terminal } = jest.requireMock('@xterm/xterm');
    const terminalInstance = Terminal.mock.results[0]?.value;
    if (terminalInstance) {
      terminalInstance.buffer.active.baseY = 10;
      terminalInstance.buffer.active.viewportY = 10;
    }

    // Advance past the poll interval to establish wasAtBottom = true
    await act(async () => {
      jest.advanceTimersByTime(150);
    });

    // Now simulate scroll-up (viewportY moves away from baseY)
    if (terminalInstance) {
      terminalInstance.buffer.active.viewportY = 0;
    }

    // Advance past poll interval to trigger detection
    await act(async () => {
      jest.advanceTimersByTime(150);
    });

    expect(socket.emit).toHaveBeenCalledWith('terminal:request_full_history', {
      sessionId: 'chat-session',
      maxLines: DEFAULT_TERMINAL_SCROLLBACK,
    });

    const afterFirstScrollCount = socket.emit.mock.calls.filter(
      ([event]) => event === 'terminal:request_full_history',
    ).length;
    expect(afterFirstScrollCount).toBe(initialRequestCount + 1);

    await act(async () => {
      // Server sends complete history including both scrollback (H) and viewport (V)
      socket.trigger('message', {
        ...envelope,
        type: 'full_history',
        payload: { history: 'HV' },
      });
    });

    expect(history.innerHTML).toContain('HV');

    jest.useRealTimers();
  });

  it('appends session lifecycle messages', async () => {
    jest.useFakeTimers();
    const { socket, history } = await renderTerminal(true);

    const envelope = { topic: 'terminal/chat-session', ts: new Date().toISOString() };

    await act(async () => {
      socket.trigger('message', {
        ...envelope,
        type: 'seed_ansi',
        payload: { chunk: 0, totalChunks: 1, data: 'X' },
      });
    });

    // Advance past the 500ms ignore window that blocks TUI redraw data
    await act(async () => {
      jest.advanceTimersByTime(600);
    });

    await act(async () => {
      socket.trigger('message', {
        topic: 'session/chat-session',
        ts: new Date().toISOString(),
        type: 'state_change',
        payload: {
          sessionId: 'chat-session',
          status: 'crashed',
          message: 'boom',
        },
      });
    });

    await waitFor(() => {
      expect(history.innerHTML).toContain('[Session crashed: boom]');
    });

    jest.useRealTimers();
  });

  it('registers OSC 52 clipboard handler on terminal mount', async () => {
    await renderTerminal();

    const { Terminal: TerminalMock } = jest.requireMock('@xterm/xterm');
    const instance = (TerminalMock as jest.Mock).mock.results[0].value;
    expect(instance.parser.registerOscHandler).toHaveBeenCalledWith(52, expect.any(Function));
  });

  // ── terminal:theme sync ─────────────────────────────────────────────

  it('does not emit terminal:theme before server subscription confirmation', async () => {
    const { socket } = await renderTerminal();

    const themeCalls = (socket.emit as jest.Mock).mock.calls.filter(
      ([event]: [string]) => event === 'terminal:theme',
    );
    expect(themeCalls).toHaveLength(0);
  });

  it('emits terminal:theme with dark colors after subscribed message', async () => {
    const { socket } = await renderTerminal();

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'subscribed',
        payload: { currentSequence: 0 },
      });
    });

    const themeCalls = (socket.emit as jest.Mock).mock.calls.filter(
      ([event]: [string]) => event === 'terminal:theme',
    );
    expect(themeCalls).toHaveLength(1);
    expect(themeCalls[0][1]).toEqual({ foregroundHex: '#c9d1d9', backgroundHex: '#1a1a1a' });
  });

  it('re-emits terminal:theme on each subscribe confirmation so the server is always synced after reconnect', async () => {
    const { socket } = await renderTerminal();

    const subscribeMsg = {
      topic: 'terminal/chat-session',
      ts: new Date().toISOString(),
      type: 'subscribed',
      payload: { currentSequence: 0 },
    };

    await act(async () => {
      socket.trigger('message', subscribeMsg);
    });
    await act(async () => {
      socket.trigger('message', subscribeMsg);
    });

    const themeCalls = (socket.emit as jest.Mock).mock.calls.filter(
      ([event]: [string]) => event === 'terminal:theme',
    );
    expect(themeCalls).toHaveLength(2);
    expect(themeCalls[0][1]).toEqual(themeCalls[1][1]);
  });

  it('re-emits terminal:theme with ocean colors when app theme changes to ocean', async () => {
    const { socket } = await renderTerminal();

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'subscribed',
        payload: { currentSequence: 0 },
      });
    });

    (socket.emit as jest.Mock).mockClear();

    await act(async () => {
      document.documentElement.classList.add('theme-ocean');
    });

    await waitFor(() => {
      const themeCalls = (socket.emit as jest.Mock).mock.calls.filter(
        ([event]: [string]) => event === 'terminal:theme',
      );
      expect(themeCalls.length).toBeGreaterThan(0);
      expect(themeCalls[themeCalls.length - 1][1]).toEqual({
        foregroundHex: '#1d2b3a',
        backgroundHex: '#eaeff5',
      });
    });

    document.documentElement.classList.remove('theme-ocean');
  });

  it('suppresses duplicate theme emit when two hook instances share the same sessionId (per-session dedup)', () => {
    const mockEmit = jest.fn();
    const mockSocket = {
      connected: true,
      emit: mockEmit,
      on: jest.fn(),
      off: jest.fn(),
    } as unknown as Socket;

    const isSubscribedRef1 = { current: false };
    const isSubscribedRef2 = { current: false };

    type AppThemeProp = Parameters<typeof useTerminalThemeSync>[1];

    const { result: result1, rerender: rerender1 } = renderHook(
      ({ appTheme }: { appTheme: AppThemeProp }) =>
        useTerminalThemeSync('shared-session', appTheme, isSubscribedRef1, mockSocket),
      { initialProps: { appTheme: 'dark' as AppThemeProp } },
    );

    const { result: result2, rerender: rerender2 } = renderHook(
      ({ appTheme }: { appTheme: AppThemeProp }) =>
        useTerminalThemeSync('shared-session', appTheme, isSubscribedRef2, mockSocket),
      { initialProps: { appTheme: 'dark' as AppThemeProp } },
    );

    // Simulate server subscription confirmation for both instances
    act(() => {
      isSubscribedRef1.current = true;
      result1.current.notifySubscribed();
    });
    act(() => {
      isSubscribedRef2.current = true;
      result2.current.notifySubscribed();
    });

    // Each subscribe always re-emits (reconnect correctness)
    const subscribeEmits = mockEmit.mock.calls.filter(([e]: [string]) => e === 'terminal:theme');
    expect(subscribeEmits).toHaveLength(2);

    mockEmit.mockClear();

    // Theme changes to ocean: instance 1 re-renders first → cache miss → emits → sets cache
    rerender1({ appTheme: 'ocean' as AppThemeProp });
    // Instance 2 re-renders with same theme → cache hit → suppressed
    rerender2({ appTheme: 'ocean' as AppThemeProp });

    const themeChangeCalls = mockEmit.mock.calls.filter(([e]: [string]) => e === 'terminal:theme');
    expect(themeChangeCalls).toHaveLength(1);
  });

  it('theme change does not reset terminal content or trigger a seed/history reload', async () => {
    // Layer: ui-component — verifies the live-retheme path is transparent to session state.
    const { socket, history } = await renderTerminal();
    const envelope = { topic: 'terminal/chat-session', ts: new Date().toISOString() };

    // Subscribe so theme sync is active
    await act(async () => {
      socket.trigger('message', {
        ...envelope,
        type: 'subscribed',
        payload: { currentSequence: 0 },
      });
    });

    // Complete seed so the terminal has visible content
    await act(async () => {
      socket.trigger('message', {
        ...envelope,
        type: 'seed_ansi',
        payload: { chunk: 0, totalChunks: 1, data: 'live-content' },
      });
    });

    await waitFor(() => {
      expect(history.innerHTML).toBe('live-content');
    });

    (socket.emit as jest.Mock).mockClear();

    // Trigger a theme change
    await act(async () => {
      document.documentElement.classList.add('theme-ocean');
    });

    // Only terminal:theme may be emitted — no history reload or re-subscribe
    await waitFor(() => {
      const calls = (socket.emit as jest.Mock).mock.calls;
      expect(calls.some(([event]: [string]) => event === 'terminal:theme')).toBe(true);
      expect(calls.every(([event]: [string]) => event === 'terminal:theme')).toBe(true);
    });

    // Terminal content must survive the retheme
    expect(history.innerHTML).toBe('live-content');

    document.documentElement.classList.remove('theme-ocean');
  });

  it('does not emit terminal:theme when socket is not connected', async () => {
    const socket = createMockSocket();
    socket.connected = false;
    currentAppSocket = socket as unknown as Socket;

    render(<ChatTerminal sessionId="chat-session" socket={currentAppSocket} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    const themeCalls = (socket.emit as jest.Mock).mock.calls.filter(
      ([event]: [string]) => event === 'terminal:theme',
    );
    expect(themeCalls).toHaveLength(0);
  });
});
