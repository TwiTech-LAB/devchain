import { act, render } from '@testing-library/react';
import { Terminal } from './Terminal';

const writeMock = jest.fn((data: unknown, callback?: () => void) => {
  if (callback) callback();
});
const resetMock = jest.fn();
const scrollBottomMock = jest.fn();
const loadAddonMock = jest.fn();
const disposeMock = jest.fn();
const openMock = jest.fn();
const clearMock = jest.fn();
const onDataMock = jest.fn();
const fitMock = jest.fn();

jest.mock('@xterm/xterm', () => ({
  Terminal: jest.fn().mockImplementation(() => ({
    loadAddon: loadAddonMock,
    write: writeMock,
    reset: resetMock,
    scrollToBottom: scrollBottomMock,
    dispose: disposeMock,
    open: openMock,
    clear: clearMock,
    onData: onDataMock,
    onScroll: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    scrollLines: jest.fn(),
    element: null,
    options: { scrollback: 10000 },
    buffer: { active: { viewportY: 0, baseY: 0, cursorY: 0, length: 0 } },
    rows: 24,
    cols: 80,
    refresh: jest.fn(),
  })),
}));

jest.mock('@xterm/addon-fit', () => ({
  FitAddon: jest.fn().mockImplementation(() => ({ fit: fitMock })),
}));

jest.mock('@xterm/xterm/css/xterm.css', () => ({}), { virtual: true });

type SocketHandlers = Record<string, Array<(...args: unknown[]) => void>>;

interface MockSocket {
  id: string;
  connected: boolean;
  emit: jest.Mock;
  on: jest.Mock;
  off: jest.Mock;
  disconnect: jest.Mock;
  trigger: (event: string, ...args: unknown[]) => void;
}

const sockets: { instance: MockSocket; handlers: SocketHandlers }[] = [];

function createMockSocket(): MockSocket {
  const handlers: SocketHandlers = {};
  const socket = {
    id: `socket-${sockets.length + 1}`,
    connected: false,
    emit: jest.fn(),
    disconnect: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    trigger(event: string, ...args: unknown[]) {
      for (const handler of handlers[event] ?? []) {
        handler(...args);
      }
    },
  } as MockSocket;

  socket.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    handlers[event] = handlers[event] ?? [];
    handlers[event].push(handler);
    return socket;
  });

  socket.off.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    handlers[event] = (handlers[event] ?? []).filter((fn) => fn !== handler);
    return socket;
  });

  sockets.push({ instance: socket, handlers });
  return socket;
}

jest.mock('socket.io-client', () => {
  const io = jest.fn(() => createMockSocket());
  return { io };
});

const { io: ioMock } = jest.requireMock('socket.io-client') as { io: jest.Mock };

beforeAll(() => {
  (global as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = jest
    .fn()
    .mockImplementation(() => ({
      observe: jest.fn(),
      disconnect: jest.fn(),
      unobserve: jest.fn(),
    }));

  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 0;
  };

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-color-scheme') ? false : true,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });

  // Mock fetch for /api/settings
  global.fetch = jest.fn().mockResolvedValue({
    json: () => Promise.resolve({ terminal: { inputMode: 'form' } }),
  });
});

afterAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global.fetch as any)?.mockRestore?.();
});

beforeEach(() => {
  jest.useFakeTimers();
  sockets.length = 0;
  ioMock.mockReset();
  ioMock.mockImplementation(() => createMockSocket());
  writeMock.mockClear();
  resetMock.mockClear();
  scrollBottomMock.mockClear();
  loadAddonMock.mockClear();
  fitMock.mockClear();
  disposeMock.mockClear();
  openMock.mockClear();
  clearMock.mockClear();
  onDataMock.mockClear();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('TerminalComponent', () => {
  it('replays seed_ansi chunks once and clears buffered data (to prevent duplicates)', async () => {
    render(
      <Terminal
        sessionId="session-visual"
        socket={null}
        chrome="none"
        className=""
        ariaLabel="terminal"
      />,
    );

    expect(ioMock).toHaveBeenCalledTimes(1);
    const { instance: socket } = sockets[0];

    // Open terminal (delayed via setTimeout inside component)
    await act(async () => {
      jest.runOnlyPendingTimers();
    });

    socket.connected = true;

    await act(async () => {
      socket.trigger('connect');
    });

    expect(socket.emit).toHaveBeenCalledWith(
      'terminal:subscribe',
      expect.objectContaining({
        sessionId: 'session-visual',
        rows: 24,
        cols: 80,
      }),
    );

    const seedEnvelope = {
      topic: 'terminal/session-visual',
      ts: new Date().toISOString(),
    };

    await act(async () => {
      socket.trigger('message', {
        ...seedEnvelope,
        type: 'seed_ansi',
        payload: { chunk: 0, totalChunks: 2, data: 'seed-chunk-a' },
      });
    });

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(writeMock).not.toHaveBeenCalled();

    await act(async () => {
      socket.trigger('message', {
        ...seedEnvelope,
        type: 'data',
        payload: { data: 'live-data', sequence: 1 },
      });
    });

    expect(writeMock).not.toHaveBeenCalled();

    await act(async () => {
      socket.trigger('message', {
        ...seedEnvelope,
        type: 'seed_ansi',
        payload: { chunk: 1, totalChunks: 2, data: 'seed-chunk-b' },
      });
    });

    // Option A: Seed chunks are assembled but NOT written - TUI redraws instead.
    // This fixes cursor position issues with Claude Code.
    expect(writeMock.mock.calls.map((call) => call[0])).toEqual([]);

    // Wait for seed ready delay (400ms)
    await act(async () => {
      jest.advanceTimersByTime(500);
    });

    // After seed completes, normal data should be written
    await act(async () => {
      socket.trigger('message', {
        ...seedEnvelope,
        type: 'data',
        payload: { data: 'post-seed', sequence: 2 },
      });
    });

    expect(writeMock.mock.calls[writeMock.mock.calls.length - 1][0]).toBe('post-seed');
  });
});
