import {
  act,
  cleanup as rtlCleanup,
  createEvent,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from '@testing-library/react';
import { createRef } from 'react';

jest.mock('@xterm/xterm/css/xterm.css', () => ({}), { virtual: true });
const xtermScrollCallbacks: Array<() => void> = [];
const heldXtermWriteCallbacks: Array<() => void> = [];
let holdXtermWriteCallbacks = false;

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
          if (cb) {
            if (holdXtermWriteCallbacks) heldXtermWriteCallbacks.push(cb);
            else cb();
          }
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

import { ChatTerminal, TerminalPromptInsertError, type ChatTerminalHandle } from './ChatTerminal';
import { _resetThemeCacheForTesting, useTerminalThemeSync } from './hooks/useTerminalThemeSync';
import { DEFAULT_TERMINAL_SCROLLBACK } from '@/common/constants/terminal';
import { HISTORY_REQUEST_COOLDOWN_MS } from './scroll-history-detector';
import { releaseAppSocket, setAppSocket } from '@/ui/lib/socket';

type SocketHandlerMap = Record<string, Set<(...args: unknown[]) => void>>;

interface MockSocket {
  id: string;
  connected: boolean;
  emit: jest.Mock;
  on: jest.Mock;
  off: jest.Mock;
  disconnect: jest.Mock;
  connect: jest.Mock;
  timeout: jest.Mock;
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
    disconnect: jest.fn(),
    connect: jest.fn(),
    timeout: jest.fn(),
    trigger(event: string, ...args: unknown[]) {
      handlers[event]?.forEach((handler) => handler(...args));
    },
    clearHandlers() {
      Object.keys(handlers).forEach((key) => delete handlers[key]);
    },
  };
  socket.timeout.mockReturnValue(socket);

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
    heldXtermWriteCallbacks.length = 0;
    holdXtermWriteCallbacks = false;
    _resetThemeCacheForTesting();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  const renderTerminal = async (
    useFakeTimers = false,
    terminalHandleRef?: React.RefObject<ChatTerminalHandle>,
  ) => {
    const socket = createMockSocket();
    currentAppSocket = socket as unknown as Socket;

    const utils = render(
      <ChatTerminal ref={terminalHandleRef} sessionId="chat-session" socket={currentAppSocket} />,
    );

    // jsdom reports offsetParent === null for every element (no layout engine), which the
    // visibility-aware scroll guard would read as "hidden" and suppress all history requests.
    // Mark the terminal container visible BEFORE the 100ms poll first ticks so these tests
    // exercise the on-screen path (the terminal is genuinely visible in these scenarios).
    const terminalContainer = utils
      .getByRole('region')
      .querySelector('div.overflow-auto') as HTMLElement | null;
    if (terminalContainer) {
      Object.defineProperty(terminalContainer, 'offsetParent', {
        configurable: true,
        get: () => document.body,
      });
    }

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
    const viewport = (region.querySelector('[data-radix-scroll-area-viewport]') ??
      region.querySelector('div.overflow-auto')) as HTMLElement;
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

  it('returns the fallback main-socket refcount to baseline across mount cycles', () => {
    const socket = createMockSocket();
    currentAppSocket = socket as unknown as Socket;
    setAppSocket(currentAppSocket);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const view = render(<ChatTerminal sessionId={`fallback-${cycle}`} />);
      view.unmount();
    }

    releaseAppSocket();
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not acquire or release the main pool for a provided socket', () => {
    const baseline = createMockSocket();
    const provided = createMockSocket();
    currentAppSocket = baseline as unknown as Socket;
    setAppSocket(currentAppSocket);

    const view = render(
      <ChatTerminal sessionId="provided-path" socket={provided as unknown as Socket} />,
    );
    view.unmount();
    releaseAppSocket();

    expect(baseline.disconnect).toHaveBeenCalledTimes(1);
    expect(provided.disconnect).not.toHaveBeenCalled();
  });

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

    // Unified seed_ansi: seed content is written directly to xterm.
    await waitFor(() => {
      expect(history.innerHTML).toBe('ABC');
    });

    // Verify that snapshot has-more is resolved from the server's per-snapshot hasHistory:true
    const hasHistoryCalls = (termLog as jest.Mock).mock.calls.filter(
      (c) => c[0] === 'seed_hasHistory_resolved' && c[1]?.snapshotHasMore === true,
    );
    expect(hasHistoryCalls.length).toBeGreaterThan(0);

    // Post-seed (onSeedReady), the client requests a server-gated viewport-mode restore so a
    // seeded (re)connect into a full-screen TUI re-emits alt-screen + mouse modes.
    await waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith('terminal:restore_viewport_modes', {
        sessionId: 'chat-session',
      });
    });
  });

  it('aborts incomplete seed after timeout and flushes bounded staged output', async () => {
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

    // The subscription handler reports the current seed expectation without changing it.
    const calls = (termLog as jest.Mock).mock.calls.filter((c) => c[0] === 'subscribed');
    expect(calls.length).toBeGreaterThan(0);
    const last = calls[calls.length - 1];
    expect(last[1]).toEqual(
      expect.objectContaining({ currentSequence: 0, expectingSeed: expect.any(Boolean) }),
    );
  });

  it('handles subscribed on reconnect and flushes bounded staged output', async () => {
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

  it('requests exactly one targeted reseed when the bounded xterm queue overflows', async () => {
    const { socket } = await renderTerminal();
    holdXtermWriteCallbacks = true;
    const data = 'x'.repeat(64 * 1024);

    await act(async () => {
      for (let sequence = 1; sequence <= 100; sequence += 1) {
        socket.trigger('message', {
          topic: 'terminal/chat-session',
          ts: new Date().toISOString(),
          type: 'data',
          payload: { data, sequence },
        });
      }
    });

    const requests = socket.emit.mock.calls.filter(
      ([event]) => event === 'terminal:resync_request',
    );
    expect(requests).toEqual([
      ['terminal:resync_request', { sessionId: 'chat-session', reason: 'client_write_overflow' }],
    ]);

    await act(async () => {
      for (let sequence = 101; sequence <= 120; sequence += 1) {
        socket.trigger('message', {
          topic: 'terminal/chat-session',
          ts: new Date().toISOString(),
          type: 'data',
          payload: { data, sequence },
        });
      }
    });
    expect(
      socket.emit.mock.calls.filter(([event]) => event === 'terminal:resync_request'),
    ).toHaveLength(1);
  });

  it('completes a watermarked recovery once, then appends its covered tail', async () => {
    const { socket, history } = await renderTerminal();
    holdXtermWriteCallbacks = true;

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'seed_ansi',
        payload: {
          chunk: 0,
          totalChunks: 1,
          data: 'snapshot',
          recoveryEpoch: 6,
          capturedSequence: 12,
        },
      });
    });
    expect(
      socket.emit.mock.calls.filter(([event]) => event === 'terminal:resync_complete'),
    ).toHaveLength(0);

    await act(async () => heldXtermWriteCallbacks.shift()?.());
    expect(
      socket.emit.mock.calls.filter(([event]) => event === 'terminal:resync_complete'),
    ).toEqual([
      [
        'terminal:resync_complete',
        { sessionId: 'chat-session', recoveryEpoch: 6, capturedSequence: 12 },
      ],
    ]);

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'data',
        payload: { data: 'during-seed', sequence: 13 },
      });
    });
    expect(history.textContent).toBe('snapshotduring-seed');

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'seed_ansi',
        payload: {
          chunk: 0,
          totalChunks: 1,
          data: 'duplicate',
          recoveryEpoch: 6,
          capturedSequence: 12,
        },
      });
    });
    expect(history.textContent).toBe('snapshotduring-seed');
    expect(
      socket.emit.mock.calls.filter(([event]) => event === 'terminal:resync_complete'),
    ).toHaveLength(1);
  });

  it('aborts an incomplete recovery, retries once after acknowledgment, and converges on the fresh epoch', async () => {
    const { socket, history } = await renderTerminal();
    jest.useFakeTimers();

    await act(async () => {
      for (let chunk = 0; chunk < 4; chunk += 1) {
        socket.trigger('message', {
          topic: 'terminal/chat-session',
          ts: new Date().toISOString(),
          type: 'seed_ansi',
          payload: {
            chunk,
            totalChunks: 5,
            data: `partial-${chunk}`,
            recoveryEpoch: 6,
            capturedSequence: 12,
          },
        });
      }
      jest.advanceTimersByTime(30000);
    });

    expect(history.textContent).toBe('');
    const abortCalls = socket.emit.mock.calls.filter(
      ([event]) => event === 'terminal:resync_abort',
    );
    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0]?.slice(0, 2)).toEqual([
      'terminal:resync_abort',
      { sessionId: 'chat-session', recoveryEpoch: 6 },
    ]);
    expect(socket.emit.mock.calls.filter(([event]) => event === 'terminal:resync_request')).toEqual(
      [],
    );

    await act(async () => {
      const acknowledge = abortCalls[0]?.[2] as ((accepted: boolean) => void) | undefined;
      acknowledge?.(true);
      acknowledge?.(true);
    });
    expect(socket.emit.mock.calls.filter(([event]) => event === 'terminal:resync_request')).toEqual(
      [['terminal:resync_request', { sessionId: 'chat-session', reason: 'client_write_overflow' }]],
    );

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'seed_ansi',
        payload: {
          chunk: 4,
          totalChunks: 5,
          data: 'late-final',
          recoveryEpoch: 6,
          capturedSequence: 12,
        },
      });
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'seed_ansi',
        payload: {
          chunk: 0,
          totalChunks: 1,
          data: 'fresh-snapshot',
          recoveryEpoch: 7,
          capturedSequence: 19,
        },
      });
    });

    expect(history.textContent).toBe('fresh-snapshot');
    expect(
      socket.emit.mock.calls.filter(([event]) => event === 'terminal:resync_complete'),
    ).toContainEqual([
      'terminal:resync_complete',
      { sessionId: 'chat-session', recoveryEpoch: 7, capturedSequence: 19 },
    ]);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('forces a clean reconnect when the single recovery retry also times out', async () => {
    const { socket, utils } = await renderTerminal();
    jest.useFakeTimers();
    socket.disconnect.mockImplementation(() => {
      socket.connected = false;
      socket.trigger('disconnect', 'io client disconnect');
      return socket;
    });

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'seed_ansi',
        payload: {
          chunk: 0,
          totalChunks: 2,
          data: 'first-attempt',
          recoveryEpoch: 6,
          capturedSequence: 12,
        },
      });
      jest.advanceTimersByTime(30000);
    });
    const acknowledge = socket.emit.mock.calls.find(
      ([event]) => event === 'terminal:resync_abort',
    )?.[2] as ((accepted: boolean) => void) | undefined;
    await act(async () => acknowledge?.(true));

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'seed_ansi',
        payload: {
          chunk: 0,
          totalChunks: 2,
          data: 'retry-attempt',
          recoveryEpoch: 7,
          capturedSequence: 19,
        },
      });
      jest.advanceTimersByTime(30000);
    });

    expect(
      socket.emit.mock.calls.filter(([event]) => event === 'terminal:resync_request'),
    ).toHaveLength(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(utils.getByRole('region')).toHaveAttribute('data-terminal-status', 'disconnected');
  });

  it('forces a clean reconnect when the recovery abort is not acknowledged', async () => {
    const { socket } = await renderTerminal();
    jest.useFakeTimers();

    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'seed_ansi',
        payload: {
          chunk: 0,
          totalChunks: 2,
          data: 'partial',
          recoveryEpoch: 6,
          capturedSequence: 12,
        },
      });
      jest.advanceTimersByTime(30000);
      jest.advanceTimersByTime(5000);
    });

    expect(
      socket.emit.mock.calls.filter(([event]) => event === 'terminal:resync_abort'),
    ).toHaveLength(1);
    expect(socket.emit.mock.calls.filter(([event]) => event === 'terminal:resync_request')).toEqual(
      [],
    );
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
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

  it('inserts multiline form prompt text at the selection without a socket write', async () => {
    const terminalHandleRef = createRef<ChatTerminalHandle>();
    const { socket, utils } = await renderTerminal(false, terminalHandleRef);
    const textarea = utils.getByPlaceholderText('Type command...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    textarea.focus();
    textarea.setSelectionRange(6, 11);
    socket.emit.mockClear();

    await act(async () => {
      await terminalHandleRef.current?.insertPromptText('alpha\nbeta');
    });

    expect(textarea).toHaveValue('hello alpha\nbeta');
    expect(textarea.selectionStart).toBe(16);
    expect(textarea.selectionEnd).toBe(16);
    expect(document.activeElement).toBe(textarea);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('submits Enter exactly once while Shift+Enter remains a multiline edit', async () => {
    const { socket, utils } = await renderTerminal();
    const textarea = utils.getByPlaceholderText('Type command...') as HTMLTextAreaElement;
    socket.emit.mockClear();

    fireEvent.change(textarea, { target: { value: 'echo hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    expect(
      socket.emit.mock.calls.filter(([event]: [string]) => event === 'terminal:input'),
    ).toEqual([
      [
        'terminal:input',
        {
          sessionId: 'chat-session',
          data: 'echo hello',
        },
      ],
    ]);

    socket.emit.mockClear();
    fireEvent.change(textarea, { target: { value: 'line one' } });
    const shiftEnter = createEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
    });
    fireEvent(textarea, shiftEnter);
    fireEvent.change(textarea, { target: { value: 'line one\nline two' } });

    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(textarea).toHaveValue('line one\nline two');
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('retries a timed-out TTY prompt paste with the same request ID and typed ack', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      json: () => Promise.resolve({ terminal: { inputMode: 'tty' } }),
    });
    const terminalHandleRef = createRef<ChatTerminalHandle>();
    const { socket } = await renderTerminal(false, terminalHandleRef);
    socket.emit.mockClear();
    let inputAttempt = 0;
    socket.emit.mockImplementation(
      (
        event: string,
        payload: { requestId?: string },
        acknowledge?: (...args: unknown[]) => void,
      ) => {
        if (event !== 'terminal:input' || typeof acknowledge !== 'function') return socket;
        inputAttempt += 1;
        if (inputAttempt === 1) {
          acknowledge(new Error('operation has timed out'));
        } else {
          acknowledge(null, {
            ok: true,
            code: 'OK',
            requestId: payload.requestId,
          });
        }
        return socket;
      },
    );

    await act(async () => {
      await terminalHandleRef.current?.insertPromptText('first line\nsecond line');
    });

    const promptInputCalls = socket.emit.mock.calls.filter(
      ([event, payload]: [string, { kind?: string }]) =>
        event === 'terminal:input' && payload.kind === 'prompt-paste',
    );
    expect(promptInputCalls).toHaveLength(2);
    expect(promptInputCalls[0][1].requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(promptInputCalls[1][1].requestId).toBe(promptInputCalls[0][1].requestId);
    expect(socket.emit.mock.calls.map(([event]: [string]) => event)).toEqual([
      'terminal:focus',
      'terminal:input',
      'terminal:focus',
      'terminal:input',
    ]);
    expect(socket.timeout).toHaveBeenCalledTimes(2);
  });

  it('surfaces typed TTY prompt-paste failures', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      json: () => Promise.resolve({ terminal: { inputMode: 'tty' } }),
    });
    const terminalHandleRef = createRef<ChatTerminalHandle>();
    const { socket } = await renderTerminal(false, terminalHandleRef);
    socket.emit.mockImplementation(
      (
        event: string,
        payload: { requestId?: string },
        acknowledge?: (...args: unknown[]) => void,
      ) => {
        if (event === 'terminal:input' && typeof acknowledge === 'function') {
          acknowledge(null, {
            ok: false,
            code: 'BUSY',
            requestId: payload.requestId,
          });
        }
        return socket;
      },
    );

    let failure: unknown;
    await act(async () => {
      try {
        await terminalHandleRef.current?.insertPromptText('prompt');
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toBeInstanceOf(TerminalPromptInsertError);
    expect(failure).toMatchObject({ code: 'BUSY' });
  });

  it('surfaces a typed timeout after both TTY attempts use the same request ID', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      json: () => Promise.resolve({ terminal: { inputMode: 'tty' } }),
    });
    const terminalHandleRef = createRef<ChatTerminalHandle>();
    const { socket } = await renderTerminal(false, terminalHandleRef);
    socket.emit.mockClear();
    socket.emit.mockImplementation(
      (event: string, _payload: unknown, acknowledge?: (...args: unknown[]) => void) => {
        if (event === 'terminal:input' && typeof acknowledge === 'function') {
          acknowledge(new Error('operation has timed out'));
        }
        return socket;
      },
    );

    let failure: unknown;
    await act(async () => {
      try {
        await terminalHandleRef.current?.insertPromptText('prompt');
      } catch (error) {
        failure = error;
      }
    });

    const promptInputCalls = socket.emit.mock.calls.filter(
      ([event, payload]: [string, { kind?: string }]) =>
        event === 'terminal:input' && payload.kind === 'prompt-paste',
    );
    expect(promptInputCalls).toHaveLength(2);
    expect(promptInputCalls[1][1].requestId).toBe(promptInputCalls[0][1].requestId);
    expect(failure).toBeInstanceOf(TerminalPromptInsertError);
    expect(failure).toMatchObject({
      code: 'ACK_TIMEOUT',
      requestId: promptInputCalls[0][1].requestId,
    });
  });

  it('requests scrollback history on scroll-up (hasHistory enabled after seed)', async () => {
    jest.useFakeTimers();
    const { socket, history } = await renderTerminal(true);

    const envelope = { topic: 'terminal/chat-session', ts: new Date().toISOString() };

    // The subscribed ack publishes the immutable provider refresh capability; without it a
    // line provider is not refresh-eligible regardless of per-snapshot has-more.
    await act(async () => {
      socket.trigger('message', {
        ...envelope,
        type: 'subscribed',
        payload: { currentSequence: 0, replayStatus: 'seed', historyRefreshable: true },
      });
    });

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

    // A genuine user scroll gesture (Shift+PageUp) is required by the gesture gate before a
    // scroll-up can request history. The container is the element passed to terminal.open().
    const termContainer = terminalInstance?.open.mock.calls[0]?.[0] as HTMLElement | undefined;
    await act(async () => {
      termContainer?.dispatchEvent(
        new KeyboardEvent('keydown', {
          shiftKey: true,
          code: 'PageUp',
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Now simulate scroll-up (viewportY moves away from baseY)
    if (terminalInstance) {
      terminalInstance.buffer.active.viewportY = 0;
    }

    // Advance past poll interval to trigger detection
    await act(async () => {
      jest.advanceTimersByTime(150);
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'terminal:request_full_history',
      expect.objectContaining({
        sessionId: 'chat-session',
        maxLines: DEFAULT_TERMINAL_SCROLLBACK,
        correlationId: expect.any(String),
      }),
    );

    const afterFirstScrollCount = socket.emit.mock.calls.filter(
      ([event]) => event === 'terminal:request_full_history',
    ).length;
    expect(afterFirstScrollCount).toBe(initialRequestCount + 1);

    // Echo the request's correlation token so the response matches the active attempt.
    const requestCall = socket.emit.mock.calls.find(
      ([event]) => event === 'terminal:request_full_history',
    );
    const correlationId = (requestCall?.[1] as { correlationId?: string })?.correlationId;

    await act(async () => {
      // Server sends complete history including both scrollback (H) and viewport (V)
      socket.trigger('message', {
        ...envelope,
        type: 'full_history',
        payload: { history: 'HV', correlationId },
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

    await act(async () => {
      document.documentElement.classList.remove('theme-ocean');
    });
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

    await act(async () => {
      document.documentElement.classList.remove('theme-ocean');
    });
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

  // Cross-layer history-ordering regression matrix. These drive the FULL normal lifecycle
  // (subscribe → seed/empty → live output → scroll-up / recovery / disconnect) through the
  // real component + mock socket, rather than injecting an already-enabled history gate.
  // They assert observable outcomes (emitted requests, written content, xterm reset); the
  // narrow-layer math (detector gesture/cooldown/visibility, owner dirtiness) is proven in
  // scroll-history-detector.spec.ts / terminal-history-sync.spec.ts / the hook specs.
  describe('cross-layer history ordering regressions', () => {
    // Every scenario drives the 100ms scroll poll and other timers via fake timers; the shared
    // afterEach restores real timers. renderTerminal(true) assumes fake timers are already active.
    beforeEach(() => {
      jest.useFakeTimers();
    });

    const message = (type: string, payload: unknown) => ({
      topic: 'terminal/chat-session',
      ts: new Date().toISOString(),
      type,
      payload,
    });

    const getTerminal = () => {
      const { Terminal } = jest.requireMock('@xterm/xterm');
      return Terminal.mock.results.at(-1)?.value;
    };

    const historyRequestCount = (socket: MockSocket) =>
      socket.emit.mock.calls.filter(([e]: [string]) => e === 'terminal:request_full_history')
        .length;

    const lastCorrelationId = (socket: MockSocket): string | undefined => {
      const call = [...socket.emit.mock.calls]
        .reverse()
        .find(([e]: [string]) => e === 'terminal:request_full_history');
      return (call?.[1] as { correlationId?: string })?.correlationId;
    };

    // Drive a genuine bottom→scroll-up excursion: establish at-bottom, stamp a real user
    // gesture (Shift+PageUp), then move the viewport up so the 100ms poll detects it.
    const scrollUp = async (terminal: ReturnType<typeof getTerminal>) => {
      const container = terminal.open.mock.calls[0]?.[0] as HTMLElement | undefined;
      terminal.buffer.active.baseY = 10;
      terminal.buffer.active.viewportY = 10;
      await act(async () => {
        jest.advanceTimersByTime(150);
      });
      await act(async () => {
        container?.dispatchEvent(
          new KeyboardEvent('keydown', {
            shiftKey: true,
            code: 'PageUp',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      terminal.buffer.active.viewportY = 0;
      await act(async () => {
        jest.advanceTimersByTime(150);
      });
    };

    const seedLineProvider = async (
      socket: MockSocket,
      opts: { refreshable?: boolean; hasHistory?: boolean } = {},
    ) => {
      await act(async () => {
        socket.trigger(
          'message',
          message('subscribed', {
            currentSequence: 0,
            replayStatus: 'seed',
            historyRefreshable: opts.refreshable ?? true,
            sequenceEpoch: 'epoch-A',
          }),
        );
        socket.trigger(
          'message',
          message('seed_ansi', {
            chunk: 0,
            totalChunks: 1,
            data: 'seed',
            hasHistory: opts.hasHistory ?? true,
          }),
        );
      });
    };

    it('S1: a non-truncated line seed does not suppress a later scroll-up refresh', async () => {
      const { socket } = await renderTerminal(true);
      const terminal = getTerminal();

      // hasHistory:false = the seed was NOT truncated. Under the regression this pinned the
      // gate off forever; now capability comes from the subscribed ack, so refresh survives.
      await seedLineProvider(socket, { refreshable: true, hasHistory: false });
      await act(async () => {
        socket.trigger('message', message('data', { data: 'later', sequence: 3 }));
      });

      await scrollUp(terminal);

      expect(historyRequestCount(socket)).toBe(1);
    });

    it('S2: an empty first capture resolves without resetting xterm and keeps live rows', async () => {
      const { socket, history } = await renderTerminal(true);
      const terminal = getTerminal();

      await act(async () => {
        socket.trigger(
          'message',
          message('subscribed', {
            currentSequence: 0,
            replayStatus: 'seed',
            historyRefreshable: true,
          }),
        );
        socket.trigger('message', message('seed_empty', { capturedSequence: 0 }));
      });
      await act(async () => {
        socket.trigger('message', message('data', { data: 'LIVE', sequence: 1 }));
      });

      expect(terminal.reset).not.toHaveBeenCalled();
      expect(history.textContent).toContain('LIVE');
    });

    it('S2b: an empty capture adopts its non-zero watermark for reconnect replay', async () => {
      const { socket, history } = await renderTerminal(true);
      const terminal = getTerminal();

      await act(async () => {
        socket.trigger(
          'message',
          message('subscribed', {
            currentSequence: 0,
            replayStatus: 'seed',
            historyRefreshable: true,
            sequenceEpoch: 'epoch-A',
          }),
        );
        // This row renders while the empty capture is still in flight, but reconnect sequence
        // adoption is deliberately frozen until the successful completion watermark arrives.
        socket.trigger('message', message('data', { data: 'LIVE', sequence: 1 }));
        socket.trigger('message', message('seed_empty', { capturedSequence: 1 }));
      });

      expect(terminal.reset).not.toHaveBeenCalled();
      expect(history.textContent).toContain('LIVE');

      socket.emit.mockClear();
      socket.connected = false;
      await act(async () => {
        socket.trigger('disconnect');
      });
      socket.connected = true;
      await act(async () => {
        socket.trigger('connect');
      });

      const subscribeCall = socket.emit.mock.calls.find(
        ([e]: [string]) => e === 'terminal:subscribe',
      );
      expect(subscribeCall?.[1]).toMatchObject({
        sessionId: 'chat-session',
        lastSequence: 1,
        sequenceEpoch: 'epoch-A',
      });
    });

    it('S3: no history request while the seed replacement write is still unsettled', async () => {
      const { socket } = await renderTerminal(true);
      const terminal = getTerminal();
      holdXtermWriteCallbacks = true;

      await seedLineProvider(socket, { refreshable: true, hasHistory: true });
      // A live frame observed during the still-unsettled capture makes state dirty…
      await act(async () => {
        socket.trigger('message', message('data', { data: 'x', sequence: 2 }));
      });

      await scrollUp(terminal);
      // …but history cannot emit before the replacement write settles.
      expect(historyRequestCount(socket)).toBe(0);

      // Settle the held seed write.
      await act(async () => {
        heldXtermWriteCallbacks.shift()?.();
      });
      holdXtermWriteCallbacks = false;

      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(1);
    });

    it('S4: capturedSequence 0 is a baseline — no recapture until new output is observed', async () => {
      const { socket } = await renderTerminal(true);
      const terminal = getTerminal();

      await act(async () => {
        socket.trigger(
          'message',
          message('subscribed', {
            currentSequence: 0,
            replayStatus: 'seed',
            historyRefreshable: true,
          }),
        );
        socket.trigger('message', message('seed_empty', { capturedSequence: 0 }));
      });

      // Unchanged bottom→history re-entry: baseline 0, nothing newer observed → no request.
      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(0);

      // New output advances latest-observed past the baseline → now dirty.
      await act(async () => {
        socket.trigger('message', message('data', { data: 'new', sequence: 1 }));
      });
      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(1);
    });

    it('S4b: an accepted full_history at capturedSequence 0 commits a baseline across the async write window with no duplicate request', async () => {
      const { socket } = await renderTerminal(true);
      const terminal = getTerminal();

      await seedLineProvider(socket, { refreshable: true, hasHistory: true });

      // A fresh non-empty seed leaves the baseline unset (null), so the first bottom→history
      // excursion is eligible and emits exactly one request.
      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(1);
      const token = lastCorrelationId(socket);
      expect(token).toBeDefined();

      // The accepted response carries capturedSequence 0. Hold its replacement write so the
      // pre-write/post-write ordering window is observable: 0 must be treated as a real
      // baseline, not "unset".
      holdXtermWriteCallbacks = true;
      await act(async () => {
        socket.trigger(
          'message',
          message('full_history', { history: 'HIST', capturedSequence: 0, correlationId: token }),
        );
      });

      // Pre-write: the attempt is still in-flight (replacement write unsettled) → a further
      // excursion admits no second request.
      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(1);

      // Settle the held replacement write → the baseline commits at sequence 0.
      await act(async () => {
        heldXtermWriteCallbacks.shift()?.();
      });
      holdXtermWriteCallbacks = false;

      // Drain the post-request cooldown so the following assertions isolate baseline/dirtiness
      // rather than passing merely because the 2s cooldown is still active.
      await act(async () => {
        jest.advanceTimersByTime(HISTORY_REQUEST_COOLDOWN_MS + 100);
      });

      // Post-write: an unchanged bottom→history re-entry sees baseline 0 with nothing newer
      // observed → no recapture (baseline, not cooldown).
      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(1);

      // Only genuinely newer output past the baseline re-dirties state and admits a fresh
      // request — proving 0 was an established baseline, not a perpetual "unset" that recaptures.
      await act(async () => {
        socket.trigger('message', message('data', { data: 'newer', sequence: 1 }));
      });
      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(2);
    });

    it('S5: recovery replaces content and adopts its own baseline/watermark; a superseded late full_history is ignored', async () => {
      const { socket, history } = await renderTerminal(true);
      const terminal = getTerminal();

      await seedLineProvider(socket, { refreshable: true, hasHistory: true });
      await act(async () => {
        socket.trigger('message', message('data', { data: 'A', sequence: 3 }));
      });

      await scrollUp(terminal);
      const token = lastCorrelationId(socket);
      expect(token).toBeDefined();
      expect(historyRequestCount(socket)).toBe(1);

      // Recovery supersedes the in-flight history attempt.
      await act(async () => {
        socket.trigger('message', message('resync_required', { currentSequence: 50 }));
      });

      // Deliver the recovery seed but HOLD its replacement write so the mid-recovery window is
      // observable. The seed text is written immediately; only the completion callback (which
      // commits the baseline/watermark and settles the lifecycle) is deferred.
      holdXtermWriteCallbacks = true;
      const requestsBeforeRecoverySeed = historyRequestCount(socket);
      await act(async () => {
        socket.trigger(
          'message',
          message('seed_ansi', {
            chunk: 0,
            totalChunks: 1,
            data: 'RECOVERED',
            sequenceEpoch: 'epoch-A',
            recoveryEpoch: 1,
            capturedSequence: 55,
          }),
        );
      });

      // While recovery is still unsettled (phase = recovery), no scroll-up may emit a request.
      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(requestsBeforeRecoverySeed);

      // Settle the recovery replacement write → recovery content is applied and the recovery
      // capture (55) becomes the baseline and reconnect watermark.
      await act(async () => {
        heldXtermWriteCallbacks.shift()?.();
      });
      holdXtermWriteCallbacks = false;
      expect(history.textContent).toContain('RECOVERED');

      // The late response for the now-superseded pre-recovery attempt must be ignored: it may
      // not rewrite xterm, and its sequence (40) must not be adopted as the baseline.
      const contentBeforeLate = history.textContent;
      await act(async () => {
        socket.trigger(
          'message',
          message('full_history', {
            history: 'STALE-HISTORY',
            capturedSequence: 40,
            correlationId: token,
          }),
        );
      });
      expect(history.textContent).toBe(contentBeforeLate);
      expect(history.textContent).toContain('RECOVERED');
      expect(history.textContent).not.toContain('STALE-HISTORY');

      // The reconnect replays from the applied recovery capture (55) — never the late
      // response's 40, nor the pre-recovery applied 3.
      socket.emit.mockClear();
      socket.connected = false;
      await act(async () => {
        socket.trigger('disconnect');
      });
      socket.connected = true;
      await act(async () => {
        socket.trigger('connect');
      });

      const subscribeCall = socket.emit.mock.calls.find(
        ([e]: [string]) => e === 'terminal:subscribe',
      );
      expect(subscribeCall?.[1]).toMatchObject({
        sessionId: 'chat-session',
        lastSequence: 55,
        sequenceEpoch: 'epoch-A',
      });
    });

    it('S6: disconnect preserves the applied watermark; no request offline; reconnect replays from it', async () => {
      const { socket } = await renderTerminal(true);
      const terminal = getTerminal();

      await seedLineProvider(socket, { refreshable: true, hasHistory: true });
      // An APPLIED live frame advances the reconnect watermark to 5.
      await act(async () => {
        socket.trigger('message', message('data', { data: 'A', sequence: 5 }));
      });

      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(1);

      // A newer frame arrives while the request is in-flight → buffered (unapplied).
      await act(async () => {
        socket.trigger('message', message('data', { data: 'B', sequence: 9 }));
      });

      // Disconnect: clears the in-flight latch; no request may emit while offline.
      socket.connected = false;
      await act(async () => {
        socket.trigger('disconnect');
      });
      const countAtDisconnect = historyRequestCount(socket);
      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(countAtDisconnect);

      // Reconnect: the subscribe replays from the last APPLIED sequence (5), never the
      // buffered-but-unapplied 9.
      socket.emit.mockClear();
      socket.connected = true;
      await act(async () => {
        socket.trigger('connect');
      });

      const subscribeCall = socket.emit.mock.calls.find(
        ([e]: [string]) => e === 'terminal:subscribe',
      );
      expect(subscribeCall?.[1]).toMatchObject({
        sessionId: 'chat-session',
        lastSequence: 5,
        sequenceEpoch: 'epoch-A',
      });
    });

    it('S8: an alternate-screen provider stays non-refreshable (no scroll-up request)', async () => {
      const { socket } = await renderTerminal(true);
      const terminal = getTerminal();

      await seedLineProvider(socket, { refreshable: false, hasHistory: false });
      await act(async () => {
        socket.trigger('message', message('data', { data: 'more', sequence: 4 }));
      });

      await scrollUp(terminal);
      expect(historyRequestCount(socket)).toBe(0);
    });
  });
});
