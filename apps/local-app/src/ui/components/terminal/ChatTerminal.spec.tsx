import { act, cleanup as rtlCleanup, fireEvent, render, waitFor } from '@testing-library/react';

jest.mock('@xterm/xterm/css/xterm.css', () => ({}), { virtual: true });
jest.mock('@xterm/xterm', () => {
  return {
    Terminal: jest.fn().mockImplementation(function (this: object) {
      let container: HTMLElement | null = null;

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
        onScroll: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        onData: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        options: { scrollback: 10000 },
        buffer: {
          active: {
            viewportY: 0,
            baseY: 0,
            cursorY: 0,
            length: 0,
          },
        },
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

  it('assembles seed chunks and skips writing content (Option A - TUI redraw)', async () => {
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

    // Option A: Seed content is NOT written - we skip it and trigger TUI redraw instead.
    // This fixes cursor position issues with Claude Code TUI.
    await waitFor(() => {
      expect(history.innerHTML).toBe('');
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

  it('writes data after seed completes (Option A skips seed content)', async () => {
    jest.useFakeTimers();
    const { socket, history } = await renderTerminal(true);

    const seedEnvelope = { topic: 'terminal/chat-session', ts: new Date().toISOString() };

    // Send seed - with Option A, content is NOT written
    await act(async () => {
      socket.trigger('message', {
        ...seedEnvelope,
        type: 'seed_ansi',
        payload: { chunk: 0, totalChunks: 1, data: 'Initial' },
      });
    });

    // Option A: seed content is skipped
    await waitFor(() => {
      expect(history.innerHTML).toBe('');
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

  it('requests scrollback history on scroll-up (Option A enables hasHistory)', async () => {
    const { socket, history, viewport } = await renderTerminal();

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

    // Option A: seed content is skipped, but hasHistory is enabled
    await waitFor(() => {
      expect(history.innerHTML).toBe('');
    });

    const initialRequestCount = socket.emit.mock.calls.filter(
      ([event]) => event === 'terminal:request_full_history',
    ).length;

    await act(async () => {
      viewport.scrollTop = 0;
      fireEvent.scroll(viewport);
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

    await waitFor(() => {
      expect(history.innerHTML).toContain('HV');
    });

    await act(async () => {
      viewport.scrollTop = 0;
      fireEvent.scroll(viewport);
    });

    const requestCount = socket.emit.mock.calls.filter(
      ([event]) => event === 'terminal:request_full_history',
    ).length;
    expect(requestCount).toBe(afterFirstScrollCount);
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
});
