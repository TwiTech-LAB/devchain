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
import { Terminal } from '@xterm/xterm';

jest.mock('@xterm/xterm/css/xterm.css', () => ({}), { virtual: true });
const xtermScrollCallbacks: Array<() => void> = [];
const xtermKeyCallbacks: Array<() => void> = [];
const xtermDataCallbacks: Array<(data: string) => void> = [];
const heldXtermWriteCallbacks: Array<() => void> = [];
let holdXtermWriteCallbacks = false;
const BRACKETED_PASTE_ON = '\x1b[?2004h';

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

      const terminal = {
        loadAddon: jest.fn(),
        open: jest.fn((el: HTMLElement) => {
          container = el;
          terminal.element = el;
        }),
        write: jest.fn((data: string, cb?: () => void) => {
          // Like xterm, the mock applies a mode sequence and prints nothing for it.
          if (data === BRACKETED_PASTE_ON) terminal.modes.bracketedPasteMode = true;
          else if (container) container.textContent = (container.textContent || '') + data;
          if (cb) {
            if (holdXtermWriteCallbacks) heldXtermWriteCallbacks.push(cb);
            else cb();
          }
        }),
        reset: jest.fn(() => {
          terminal.modes.bracketedPasteMode = false;
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
        element: null as HTMLElement | null,
        scrollLines: jest.fn(),
        scrollToBottom: jest.fn(),
        scrollToLine: jest.fn(),
        focus: jest.fn(),
        attachCustomKeyEventHandler: jest.fn(),
        attachCustomWheelEventHandler: jest.fn(),
        onScroll: jest.fn((cb: () => void) => {
          xtermScrollCallbacks.push(cb);
          return { dispose: jest.fn() };
        }),
        onKey: jest.fn((cb: () => void) => {
          xtermKeyCallbacks.push(cb);
          return { dispose: jest.fn() };
        }),
        onData: jest.fn((cb: (data: string) => void) => {
          xtermDataCallbacks.push(cb);
          return { dispose: jest.fn() };
        }),
        input: jest.fn((data: string) => xtermDataCallbacks.at(-1)?.(data)),
        onSelectionChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
        hasSelection: jest.fn().mockReturnValue(false),
        getSelection: jest.fn().mockReturnValue(''),
        clearSelection: jest.fn(),
        parser: { registerOscHandler: jest.fn() },
        options: { scrollback: 10000 },
        modes: { mouseTrackingMode: 'none', bracketedPasteMode: false },
        buffer: { active: bufferActive },
      };
      return terminal;
    }),
  };
});

import type { Socket } from 'socket.io-client';
import { FitAddon } from '@xterm/addon-fit';

// Socket reference for socket.io-client mock - set per test
let currentAppSocket: Socket | null = null;

jest.mock('socket.io-client', () => ({
  io: () => currentAppSocket,
}));

jest.mock('@/ui/lib/debug', () => ({
  termLog: jest.fn(),
}));
jest.mock('@/ui/hooks/use-toast', () => ({ toast: jest.fn() }));

import { ChatTerminal, TerminalPromptInsertError, type ChatTerminalHandle } from './ChatTerminal';
import { _resetThemeCacheForTesting, useTerminalThemeSync } from './hooks/useTerminalThemeSync';
import { DEFAULT_TERMINAL_SCROLLBACK } from '@/common/constants/terminal';
import { HISTORY_REQUEST_COOLDOWN_MS } from './scroll-history-detector';
import { releaseAppSocket, setAppSocket } from '@/ui/lib/socket';
import { toast } from '@/ui/hooks/use-toast';
import { BackendContext } from '@/ui/lib/backend-context';
import { buildApiUrl, createApiFetch, HOME_BACKEND } from '@/ui/lib/api-transport';

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
      ok: true,
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
    xtermKeyCallbacks.length = 0;
    xtermDataCallbacks.length = 0;
    heldXtermWriteCallbacks.length = 0;
    holdXtermWriteCallbacks = false;
    _resetThemeCacheForTesting();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  const renderTerminal = async (
    useFakeTimers = false,
    terminalHandleRef?: React.RefObject<ChatTerminalHandle>,
    projectId?: string,
  ) => {
    const socket = createMockSocket();
    currentAppSocket = socket as unknown as Socket;

    const utils = render(
      <ChatTerminal ref={terminalHandleRef} sessionId="chat-session" projectId={projectId} />,
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

    const readyFit = !useFakeTimers ? jest.spyOn(FitAddon.prototype, 'fit') : null;

    // Wait for settings fetch and effects to register
    if (useFakeTimers) {
      // With fake timers, run all pending timers
      await act(async () => {
        jest.runAllTimers();
      });
    } else {
      await act(async () => {
        await Promise.resolve();
      });
    }

    if (readyFit) {
      try {
        await waitFor(() => expect(readyFit).toHaveBeenCalled());
      } finally {
        readyFit.mockRestore();
      }
    }

    socket.connected = true;
    await act(async () => {
      socket.trigger('connect');
    });

    if (!useFakeTimers) {
      await act(async () => {
        await Promise.resolve();
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

  const resolveInputMode = (inputMode: 'form' | 'tty') => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ terminal: { inputMode } }),
    });
  };

  const resubscribeWithoutAuthorityUpdate = async (socket: MockSocket) => {
    await act(async () => {
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'subscribed',
        payload: { currentSequence: 0 },
      });
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'focus_changed',
        payload: { clientId: 'socket-test' },
      });
      socket.trigger('disconnect');
      socket.trigger('connect');
      socket.trigger('message', {
        topic: 'terminal/chat-session',
        ts: new Date().toISOString(),
        type: 'subscribed',
        payload: { currentSequence: 0 },
      });
    });
  };

  // UI jsdom is the cheapest reliable layer for the settings promise-to-hook construction seam.
  it('stores the Ctrl+C setting before inputMode unlocks one terminal construction', async () => {
    let resolveSettings: ((value: unknown) => void) | undefined;
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        }),
    });
    const socket = createMockSocket();
    currentAppSocket = socket as unknown as Socket;

    const view = render(<ChatTerminal sessionId="settings-session" />);
    expect(Terminal).not.toHaveBeenCalled();
    await waitFor(() => expect(resolveSettings).toBeDefined());

    await act(async () => {
      resolveSettings?.({
        terminal: { inputMode: 'tty', suppressCtrlCWithSelection: false },
      });
    });

    await waitFor(() => expect(Terminal).toHaveBeenCalledTimes(1));
    const terminal = (Terminal as unknown as jest.Mock).mock.results[0]?.value as {
      attachCustomKeyEventHandler: jest.Mock;
      hasSelection: jest.Mock;
    };
    terminal.hasSelection.mockReturnValue(true);
    const handler = terminal.attachCustomKeyEventHandler.mock.calls[0]?.[0] as (
      event: KeyboardEvent,
    ) => boolean;
    const event = {
      type: 'keydown',
      key: 'c',
      keyCode: 67,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault: jest.fn(),
    } as unknown as KeyboardEvent;

    expect(handler(event)).toBe(true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(Terminal).toHaveBeenCalledTimes(1);
    view.rerender(<ChatTerminal sessionId="settings-session" />);
    expect(Terminal).toHaveBeenCalledTimes(1);
  });

  it.each(['project', 'home'] as const)(
    'routes form clipboard files only for the agent terminal on the %s socket',
    async (socketTarget) => {
      const socket = createMockSocket();
      currentAppSocket = socket as unknown as Socket;
      const onClipboardImagePaste = jest.fn();
      const view = render(
        <ChatTerminal
          sessionId="form-clipboard"
          socket={socketTarget}
          onClipboardImagePaste={onClipboardImagePaste}
        />,
      );
      const textarea = await view.findByRole('textbox');
      const file = new File([], 'screenshot');
      const header = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      jest.spyOn(file, 'slice').mockReturnValue(
        Object.assign(new Blob(), {
          arrayBuffer: async () => header.buffer,
        }),
      );

      const clipboardData = { files: [file], getData: () => 'text fallback' };
      const allowed = fireEvent.paste(textarea, { clipboardData });
      if (socketTarget === 'project') {
        expect(allowed).toBe(false);
        expect(onClipboardImagePaste).toHaveBeenCalledTimes(1);
        const [paste] = onClipboardImagePaste.mock.calls[0];
        expect(paste).toMatchObject({ inputMode: 'form', browserFileCount: 1 });
        await expect(paste.readResult).resolves.toMatchObject({
          images: [{ file, mimeType: 'image/png' }],
        });

        const terminal = (Terminal as unknown as jest.Mock).mock.results[0]?.value;
        const keyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0][0];
        const ctrlV = new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, cancelable: true });
        expect(keyHandler(ctrlV)).toBe(false);
        expect(ctrlV.defaultPrevented).toBe(false);
        expect(fireEvent.paste(terminal.element, { clipboardData })).toBe(false);
        expect(onClipboardImagePaste).toHaveBeenCalledTimes(2);
      } else {
        expect(allowed).toBe(true);
        expect(onClipboardImagePaste).not.toHaveBeenCalled();
      }
      expect(socket.emit).not.toHaveBeenCalledWith('terminal:input', expect.anything());
    },
  );

  it('reports the browser count for unsupported and unreadable clipboard files', async () => {
    const { utils } = await renderTerminal();
    const textarea = utils.getByRole('textbox');
    const file = new File(['not an image'], 'paste.txt');
    jest
      .spyOn(file, 'slice')
      .mockReturnValue(
        Object.assign(new Blob(), { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
      );
    const items = [
      { kind: 'file', getAsFile: () => file },
      { kind: 'file', getAsFile: () => null },
    ];

    expect(fireEvent.paste(textarea, { clipboardData: { files: [file], items } })).toBe(false);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: 'Clipboard files could not all be attached',
        description:
          'The browser supplied 2 files. Unsupported format (1). Use PNG or JPEG. Could not read 1 file.',
        variant: 'destructive',
      }),
    );
  });

  it('returns the fallback main-socket refcount to baseline across mount cycles', () => {
    const socket = createMockSocket();
    currentAppSocket = socket as unknown as Socket;
    setAppSocket(currentAppSocket);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const view = render(<ChatTerminal sessionId={`fallback-${cycle}`} />);
      view.unmount();
    }

    releaseAppSocket('home');
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
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
    (termLog as jest.Mock).mock.calls.filter(
      (c) => c[0] === 'seed_hasHistory_resolved' && c[1]?.snapshotHasMore === true,
    );

    // Post-seed (onSeedReady), the client requests a server-gated viewport-mode restore so a
    // seeded (re)connect into a full-screen TUI re-emits alt-screen + mouse modes.
    await waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith('terminal:restore_viewport_modes', {
        sessionId: 'chat-session',
      });
    });

    // The seed resets the xterm, which turns bracketed paste off. The reset turns it on again,
    // so pastes reach the provider as bracketed pastes.
    await waitFor(() => {
      expect(history.textContent).toBe('ABC');
    });
    expect(jest.mocked(Terminal).mock.results.at(-1)?.value.modes.bracketedPasteMode).toBe(true);
  });

  // The component owns the imperative clear entry point.
  it.each([true, false])('preserves bracketed paste mode %s when cleared', async (mode) => {
    const handle = createRef<ChatTerminalHandle>();
    await renderTerminal(false, handle);
    const terminal = jest.mocked(Terminal).mock.results.at(-1)?.value;
    terminal.modes.bracketedPasteMode = mode;

    act(() => handle.current?.clear());

    expect(terminal.modes.bracketedPasteMode).toBe(mode);
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
    (termLog as jest.Mock).mock.calls.filter((c) => c[0] === 'subscribed');
  });

  it('claims authority before form input only after focus moves to another client', async () => {
    resolveInputMode('form');
    const { socket, utils } = await renderTerminal();
    const envelope = { topic: 'terminal/chat-session', ts: new Date().toISOString() };
    await act(async () => {
      socket.trigger('message', {
        ...envelope,
        type: 'subscribed',
        payload: { currentSequence: 0 },
      });
      socket.trigger('message', {
        ...envelope,
        type: 'focus_changed',
        payload: { clientId: socket.id },
      });
    });
    const input = utils.getByPlaceholderText('Type command...');
    socket.emit.mockClear();
    fireEvent.change(input, { target: { value: 'own authority' } });
    fireEvent.click(utils.getByRole('button', { name: /send/i }));
    expect(socket.emit.mock.calls).toEqual([
      ['terminal:input', { sessionId: 'chat-session', data: 'own authority' }],
    ]);
    await act(async () => {
      socket.trigger('message', {
        ...envelope,
        type: 'focus_changed',
        payload: { clientId: 'someone-else' },
      });
    });
    socket.emit.mockClear();
    fireEvent.change(input, { target: { value: 'claim authority' } });
    fireEvent.click(utils.getByRole('button', { name: /send/i }));
    expect(socket.emit.mock.calls).toEqual([
      ['terminal:focus', { sessionId: 'chat-session' }],
      ['terminal:input', { sessionId: 'chat-session', data: 'claim authority' }],
    ]);
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

  it('clears authority on disconnect and reclaims before form input after resubscribe', async () => {
    resolveInputMode('form');
    const { socket, utils } = await renderTerminal();

    await resubscribeWithoutAuthorityUpdate(socket);

    socket.emit.mockClear();
    fireEvent.change(utils.getByPlaceholderText('Type command...'), {
      target: { value: 'echo recovered' },
    });
    fireEvent.click(utils.getByRole('button', { name: /send/i }));

    expect(socket.emit.mock.calls).toEqual([
      ['terminal:focus', { sessionId: 'chat-session' }],
      ['terminal:input', { sessionId: 'chat-session', data: 'echo recovered' }],
    ]);
  });

  it('clears authority on disconnect and reclaims from TTY key intent after resubscribe', async () => {
    resolveInputMode('tty');
    const { socket } = await renderTerminal();

    await resubscribeWithoutAuthorityUpdate(socket);

    socket.emit.mockClear();
    act(() => {
      xtermKeyCallbacks.at(-1)?.();
      xtermDataCallbacks.at(-1)?.('a');
    });

    expect(socket.emit.mock.calls).toEqual([
      ['terminal:focus', { sessionId: 'chat-session' }],
      ['terminal:input', { sessionId: 'chat-session', data: 'a', ttyMode: true }],
    ]);
  });

  it('claims TTY authority and sends one control byte for Ctrl+V with an empty clipboard', async () => {
    resolveInputMode('tty');
    const { socket, viewport } = await renderTerminal();
    await resubscribeWithoutAuthorityUpdate(socket);

    const terminal = (Terminal as unknown as jest.Mock).mock.results[0]?.value;
    const keyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0][0];
    socket.emit.mockClear();
    expect(keyHandler(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }))).toBe(false);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(fireEvent.paste(viewport, { clipboardData: { files: [], getData: () => '' } })).toBe(
      false,
    );
    expect(socket.emit.mock.calls).toEqual([
      ['terminal:focus', { sessionId: 'chat-session' }],
      ['terminal:input', { sessionId: 'chat-session', data: '\x16', ttyMode: true }],
    ]);
  });

  it('discards a pending Ctrl+V when the TTY loses focus without reclaiming authority', async () => {
    resolveInputMode('tty');
    const { socket, viewport } = await renderTerminal();
    await resubscribeWithoutAuthorityUpdate(socket);

    const terminal = (Terminal as unknown as jest.Mock).mock.results[0]?.value;
    const keyHandler = terminal.attachCustomKeyEventHandler.mock.calls[0][0];
    socket.emit.mockClear();
    expect(keyHandler(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }))).toBe(false);
    fireEvent.focusOut(viewport, { relatedTarget: document.body });
    const file = new File([], 'image.png');
    expect(fireEvent.paste(viewport, { clipboardData: { files: [file] } })).toBe(false);
    keyHandler(new KeyboardEvent('keyup', { key: 'v' }));
    expect(socket.emit).not.toHaveBeenCalled();
  });

  async function imageTerminal(
    mode: 'form' | 'tty' = 'tty',
    ref?: React.RefObject<ChatTerminalHandle>,
  ) {
    resolveInputMode(mode);
    const projectId = '00000000-0000-4000-8000-000000000001';
    const terminal = await renderTerminal(false, ref, projectId);
    await resubscribeWithoutAuthorityUpdate(terminal.socket);
    const file = new File(['fixture'], 'picture.png');
    jest.spyOn(file, 'slice').mockReturnValue(
      Object.assign(new Blob(), {
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
      }),
    );
    terminal.socket.emit.mockClear();
    terminal.socket.emit.mockImplementation((event, data, ack) => {
      if (event === 'terminal:image-begin')
        ack(null, { gestureId: data.gestureId, index: -1, status: 'ready' });
    });
    return { ...terminal, file, projectId };
  }

  it('reports partial progress and retries only the same image without taking focus again', async () => {
    const { socket, viewport, file, projectId } = await imageTerminal();
    const upload = global.fetch as jest.Mock;
    upload
      .mockResolvedValueOnce({ ok: true, json: async () => ({ attachmentId: 'first.png' }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        json: async () => ({ message: 'Image exceeds the file limit' }),
      });
    let attempts = 0;
    socket.emit.mockImplementation((event, data, ack) => {
      if (event === 'terminal:image-begin')
        ack(null, { gestureId: data.gestureId, index: -1, status: 'ready' });
      if (event === 'terminal:input' && data.kind === 'image-paste') {
        if (++attempts === 1) ack(new Error('lost acknowledgement'));
        else ack(null, { gestureId: data.gestureId, index: 0, status: 'delivered' });
      }
    });
    fireEvent.paste(viewport, { clipboardData: { files: [file, file] } });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: expect.stringContaining('Browser supplied 2. Terminal acknowledged 1.'),
        }),
      ),
    );
    expect(upload).toHaveBeenCalledWith(
      expect.stringContaining(`/api/sessions/chat-session/attachments?projectId=${projectId}`),
      expect.objectContaining({ body: file }),
    );
    const deliveries = socket.emit.mock.calls.filter(([event]) => event === 'terminal:input');
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0][1]).toEqual(deliveries[1][1]);
    expect(socket.emit.mock.calls.filter(([event]) => event === 'terminal:focus')).toHaveLength(1);
  });

  it('retries only the remaining file after a transient second upload failure', async () => {
    const { socket, viewport, file } = await imageTerminal();
    const second = new File(['other fixture'], 'second.png');
    jest.spyOn(second, 'slice').mockImplementation(file.slice.bind(file));
    const upload = global.fetch as jest.Mock;
    upload.mockClear();
    upload
      .mockResolvedValueOnce({ ok: true, json: async () => ({ attachmentId: 'one.png' }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ message: 'Host busy' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ attachmentId: 'two.png' }) });
    socket.emit.mockImplementation((event, data, ack) => {
      if (event === 'terminal:image-begin')
        ack(null, { gestureId: data.gestureId, index: -1, status: 'ready' });
      if (data.kind === 'image-paste')
        ack(null, { gestureId: data.gestureId, index: data.index, status: 'delivered' });
    });
    fireEvent.paste(viewport, { clipboardData: { files: [file, second] } });
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Browser supplied 2. Terminal acknowledged 2.' }),
      ),
    );
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Terminal acknowledged 1. Retrying file 2.'),
      }),
    );
    expect(upload.mock.calls.map(([, init]) => init.body)).toEqual([file, second, second]);
    expect(
      socket.emit.mock.calls.filter(([e]) => e === 'terminal:input').map(([, p]) => p.attachmentId),
    ).toEqual(['one.png', 'two.png']);
    expect(socket.emit.mock.calls.filter(([e]) => e === 'terminal:focus')).toHaveLength(1);
  });

  it.each([
    [
      'disconnect',
      'timeout',
      1,
      'File 2 may already be attached. Inspect the original draft before pasting again.',
    ],
    [
      'authority loss',
      'timeout',
      1,
      'File 2 may already be attached. Inspect the original draft before pasting again.',
    ],
    [
      'authority loss',
      'unconfirmed',
      2,
      'Copilot did not show an attachment chip for file 2. Inspect the original draft before pasting again.',
    ],
    ['disconnect', 'recognized', 2, 'The paste was cancelled.'],
  ])(
    'preserves the second image outcome after %s with a late %s acknowledgement',
    async (loss, status, count, detail) => {
      const { socket, viewport, file } = await imageTerminal();
      const upload = global.fetch as jest.Mock;
      upload.mockClear();
      for (const attachmentId of ['first.png', 'second.png']) {
        upload.mockResolvedValueOnce({ ok: true, json: async () => ({ attachmentId }) });
      }
      let acknowledgeSecond: (() => void) | undefined;
      socket.emit.mockImplementation((event, data, ack) => {
        if (event === 'terminal:image-begin')
          ack(null, { gestureId: data.gestureId, index: -1, status: 'ready' });
        if (data.kind !== 'image-paste') return;
        if (data.index === 0) {
          ack(null, { gestureId: data.gestureId, index: 0, status: 'delivered' });
        } else {
          acknowledgeSecond = () =>
            status === 'timeout'
              ? ack(new Error('lost acknowledgement'))
              : ack(null, { gestureId: data.gestureId, index: 1, status });
        }
      });
      fireEvent.paste(viewport, { clipboardData: { files: [file, file, file] } });
      await waitFor(() => expect(acknowledgeSecond).toBeDefined());
      act(() => {
        if (loss === 'disconnect') {
          socket.connected = false;
          socket.trigger('disconnect', 'transport close');
        } else {
          socket.trigger('message', {
            topic: 'terminal/chat-session',
            type: 'focus_changed',
            payload: { clientId: 'another-writer' },
          });
        }
        acknowledgeSecond!();
      });
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Image paste incomplete',
            description: `Browser supplied 3. Terminal acknowledged ${count}. ${detail}`,
          }),
        ),
      );
      expect(upload).toHaveBeenCalledTimes(2);
      expect(
        socket.emit.mock.calls
          .filter(([e]) => e === 'terminal:input')
          .map(([, p]) => p.attachmentId),
      ).toEqual(['first.png', 'second.png']);
      expect(socket.emit.mock.calls.filter(([e]) => e === 'terminal:focus')).toHaveLength(1);
    },
  );

  it.each(['unmount', 'project switch', 'another mounted terminal', 'authority loss'])(
    'cancels a late upload on %s',
    async (change) => {
      const { socket, viewport, utils, file } = await imageTerminal();
      let finish!: () => void;
      let uploadSignal: AbortSignal | undefined;
      (global.fetch as jest.Mock).mockImplementationOnce(
        (_url, init) =>
          new Promise((resolve) => {
            uploadSignal = init.signal;
            finish = () => resolve({ ok: true, json: async () => ({ attachmentId: 'late.png' }) });
          }),
      );
      fireEvent.paste(viewport, { clipboardData: { files: [file] } });
      await waitFor(() => expect(uploadSignal).toBeDefined());
      if (change === 'unmount') utils.unmount();
      if (change === 'project switch')
        utils.rerender(<ChatTerminal sessionId="chat-session" projectId="other-project" />);
      if (change === 'another mounted terminal') {
        const other = render(
          <ChatTerminal sessionId="second-session" ariaLabel="Second terminal" />,
        );
        fireEvent.focusIn(other.getByRole('region', { name: 'Second terminal' }));
      }
      if (change === 'authority loss')
        act(() =>
          socket.trigger('message', {
            topic: 'terminal/chat-session',
            type: 'focus_changed',
            payload: { clientId: 'another-writer' },
          }),
        );
      expect(uploadSignal!.aborted).toBe(true);
      finish();
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({
            description: 'Browser supplied 1. Terminal acknowledged 0. The paste was cancelled.',
          }),
        ),
      );
      expect(socket.emit.mock.calls.filter(([event]) => event === 'terminal:input')).toHaveLength(
        0,
      );
      expect(socket.emit).toHaveBeenCalledWith(
        'terminal:image-end',
        expect.objectContaining({ sessionId: 'chat-session' }),
      );
    },
  );

  // The component exercises the real fetch factory when the provider publishes new bindings.
  it('keeps the unsent form when another project moves to a remote backend', async () => {
    currentAppSocket = createMockSocket() as unknown as Socket;
    const terminal = (bindings: Map<string, string>) => (
      <BackendContext.Provider
        value={{
          activeBackend: HOME_BACKEND,
          activeRemote: null,
          bindings,
          ready: true,
          bindingsError: null,
          retry: jest.fn(),
          apiFetch: createApiFetch(() => ({ bindings, activeProjectId: 'a', authority: 'known' })),
          buildApiUrl,
        }}
      >
        <ChatTerminal projectId="a" sessionId="chat-session" />
      </BackendContext.Provider>
    );
    const utils = render(terminal(new Map()));
    const area = await utils.findByPlaceholderText('Type command...');
    fireEvent.change(area, { target: { value: 'my edited but unsent prompt' } });
    utils.rerender(terminal(new Map([['b', 'remote-b']])));
    expect(area).toHaveValue('my edited but unsent prompt');
  });

  it('keeps attachments at the caret during edits, picker insertion, removal and partial Send retry', async () => {
    const handle = createRef<ChatTerminalHandle>();
    const { utils, socket, file } = await imageTerminal('form', handle);
    const area = utils.getByPlaceholderText('Type command...') as HTMLTextAreaElement;
    const upload = global.fetch as jest.Mock;
    for (const attachmentId of ['first.png', 'second.png'])
      upload.mockResolvedValueOnce({ ok: true, json: async () => ({ attachmentId }) });
    fireEvent.change(area, { target: { value: 'left replace right' } });
    area.setSelectionRange(5, 12);
    fireEvent.paste(area, { clipboardData: { files: [file, file] } });
    expect(area).toHaveValue('left [Image 1][Image 2] right');
    expect(area.selectionStart).toBe(23);
    area.setSelectionRange(14, 14);
    await act(async () => {
      await handle.current!.insertPromptText(' middle ');
    });
    expect(area).toHaveValue('left [Image 1] middle [Image 2] right');
    await waitFor(() => expect(utils.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(utils.getByRole('button', { name: 'Remove image 2' }));
    expect(area).toHaveValue('left [Image 1] middle  right');
    expect(area.selectionStart).toBe(22);
    const send = utils.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeEnabled());
    expect(socket.emit.mock.calls.filter(([e]) => e === 'terminal:input')).toEqual([]);
    socket.emit.mockImplementation((event, payload, ack) => {
      if (event === 'terminal:input')
        ack(null, {
          sendId: payload.sendId,
          status: payload.resume ? 'submitted' : 'retryable',
          confirmedSegments: payload.resume ? 3 : 2,
          acknowledgedImages: 1,
        });
    });
    fireEvent.click(send);
    const retry = await utils.findByRole('button', { name: 'Retry send' });
    expect(area).toHaveValue('left [Image 1] middle  right');
    expect(area).toHaveAttribute('readonly');
    const focusClaims = socket.emit.mock.calls.filter(
      ([event]) => event === 'terminal:focus',
    ).length;
    fireEvent.click(retry);
    await waitFor(() => expect(area).toHaveValue(''));
    const calls = socket.emit.mock.calls.filter(([e]) => e === 'terminal:input').map(([, p]) => p);
    expect(calls).toHaveLength(2);
    expect(calls[0].segments).toEqual([
      { kind: 'text', text: 'left ' },
      { kind: 'image', attachmentId: 'first.png' },
      { kind: 'text', text: ' middle  right' },
    ]);
    expect(calls[1]).toEqual({ ...calls[0], resume: true });
    expect(socket.emit.mock.calls.filter(([event]) => event === 'terminal:focus')).toHaveLength(
      focusClaims,
    );
  });

  it.each(['submitted', 'lost', 'unconfirmed'] as const)(
    'handles an image-only Send with %s acknowledgement',
    async (outcome) => {
      const { utils, socket, file, viewport } = await imageTerminal('form');
      const area = utils.getByPlaceholderText('Type command...');
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ attachmentId: 'first.png' }),
      });
      fireEvent.paste(viewport, { clipboardData: { files: [file] } });
      const send = utils.getByRole('button', { name: 'Send' });
      await waitFor(() => expect(send).toBeEnabled());
      expect(socket.emit.mock.calls.filter(([e]) => e === 'terminal:input')).toEqual([]);
      socket.emit.mockImplementation((event, p, ack) => {
        if (event !== 'terminal:input') return;
        if (outcome === 'lost') ack(new Error('lost'));
        else
          ack(null, {
            sendId: p.sendId,
            status: outcome === 'submitted' ? 'submitted' : 'inspect',
            confirmedSegments: 1,
            acknowledgedImages: 1,
          });
      });
      fireEvent.click(send);
      if (outcome === 'submitted') await waitFor(() => expect(area).toHaveValue(''));
      else {
        const alert = await utils.findByRole('alert');
        expect(alert).toHaveTextContent('Inspect the terminal');
        expect(alert).toHaveTextContent(
          `Terminal acknowledged ${outcome === 'lost' ? 0 : 1} image`,
        );
        expect(area).toHaveValue('[Image 1]');
        expect(send).toBeDisabled();
        fireEvent.keyDown(area, { key: 'Enter' });
        fireEvent.click(utils.getByRole('button', { name: 'Inspect terminal' }));
        fireEvent.click(utils.getByRole('button', { name: 'Discard form draft' }));
        expect(area).toHaveValue('');
      }
      const deliveries = socket.emit.mock.calls.filter(([e]) => e === 'terminal:input');
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0][1].segments).toEqual([{ kind: 'image', attachmentId: 'first.png' }]);
    },
  );

  function replaceTextareaSelection(
    area: HTMLTextAreaElement,
    start: number,
    end: number,
    inserted: string,
  ) {
    area.focus();
    area.setSelectionRange(start, end);
    fireEvent(
      area,
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertFromPaste',
        data: null,
      }),
    );
    const value = area.value.slice(0, start) + inserted + area.value.slice(end);
    const caret = start + inserted.length;
    fireEvent.input(area, {
      target: { value, selectionStart: caret, selectionEnd: caret },
      inputType: 'insertFromPaste',
      data: null,
    });
  }

  it.each(['[notes]', '[Image 12]', '[Image 1]', '[Image'])(
    'replaces a selected image marker with exact literal text %s',
    async (replacement) => {
      const { utils, socket, file } = await imageTerminal('form');
      const area = utils.getByPlaceholderText('Type command...') as HTMLTextAreaElement;
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ attachmentId: 'one.png' }),
      });
      fireEvent.paste(area, { clipboardData: { files: [file] } });
      await waitFor(() => expect(utils.getByRole('button', { name: 'Send' })).toBeEnabled());
      replaceTextareaSelection(area, 0, area.value.length, replacement);
      expect(area).toHaveValue(replacement);
      expect([area.selectionStart, area.selectionEnd]).toEqual([
        replacement.length,
        replacement.length,
      ]);
      expect(utils.queryByRole('list', { name: 'Draft attachments' })).toBeNull();
      expect(socket.emit.mock.calls.filter(([e]) => e === 'terminal:input')).toEqual([]);
    },
  );

  it('preserves adjacent edits, surrounding text and the unselected attachment ID', async () => {
    const { utils, socket, file } = await imageTerminal('form');
    const area = utils.getByPlaceholderText('Type command...') as HTMLTextAreaElement;
    for (const attachmentId of ['one.png', 'two.png'])
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ attachmentId }),
      });
    fireEvent.change(area, { target: { value: 'left right' } });
    area.setSelectionRange(5, 5);
    fireEvent.paste(area, { clipboardData: { files: [file, file] } });
    const send = utils.getByRole('button', { name: 'Send' });
    await waitFor(() => expect(send).toBeEnabled());
    replaceTextareaSelection(area, 13, 13, ']');
    expect(area).toHaveValue('left [Image 1]][Image 2]right');
    expect([area.selectionStart, area.selectionEnd]).toEqual([15, 15]);
    replaceTextareaSelection(area, 14, 15, '+');
    expect(area).toHaveValue('left [Image 1]+[Image 2]right');
    expect(utils.getByRole('button', { name: 'Remove image 1' })).toBeEnabled();
    expect(utils.getByRole('button', { name: 'Remove image 2' })).toBeEnabled();
    // Replacing part of the first atomic marker removes it, preserving exactly what was pasted.
    replaceTextareaSelection(area, 6, 13, 'Image notes');
    expect(area).toHaveValue('left Image notes+[Image 2]right');
    expect([area.selectionStart, area.selectionEnd]).toEqual([16, 16]);
    expect(utils.queryByRole('button', { name: 'Remove image 1' })).toBeNull();
    expect(utils.getByRole('button', { name: 'Remove image 2' })).toBeEnabled();
    socket.emit.mockImplementation((event, payload, ack) => {
      if (event === 'terminal:input')
        ack(null, {
          sendId: payload.sendId,
          status: 'submitted',
          confirmedSegments: 3,
          acknowledgedImages: 1,
        });
    });
    fireEvent.click(send);
    await waitFor(() => expect(area).toHaveValue(''));
    const calls = socket.emit.mock.calls.filter(([e]) => e === 'terminal:input');
    expect(calls).toHaveLength(1);
    expect(calls[0][1].segments).toEqual([
      { kind: 'text', text: 'left Image notes+' },
      { kind: 'image', attachmentId: 'two.png' },
      { kind: 'text', text: 'right' },
    ]);
  });

  it('treats a tracked marker as one editable item and preserves identical literal text', async () => {
    const { utils, socket, file } = await imageTerminal('form');
    const area = utils.getByPlaceholderText('Type command...') as HTMLTextAreaElement;
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ attachmentId: 'one.png' }),
    });
    fireEvent.change(area, { target: { value: 'literal [Image 1] and ' } });
    area.setSelectionRange(area.value.length, area.value.length);
    fireEvent.paste(area, { clipboardData: { files: [file] } });
    await waitFor(() => expect(utils.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(area).toHaveValue('literal [Image 1] and [Image 1]');
    const shortened = area.value.slice(0, -1);
    fireEvent.change(area, {
      target: {
        value: shortened,
        selectionStart: shortened.length,
        selectionEnd: shortened.length,
      },
    });
    expect(area).toHaveValue('literal [Image 1] and ');
    expect(utils.queryByRole('list', { name: 'Draft attachments' })).toBeNull();
    expect(socket.emit.mock.calls.filter(([e]) => e === 'terminal:input')).toEqual([]);
  });

  // The form owns both the native textarea selection and the asynchronous upload receipt.
  it('restores only the selected content when a pending file paste is rejected', async () => {
    const { utils, socket, file } = await imageTerminal('form');
    const area = utils.getByPlaceholderText('Type command...') as HTMLTextAreaElement;
    const send = utils.getByRole('button', { name: 'Send' });
    let finishUpload!: () => void;
    (global.fetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = () =>
            resolve({ ok: true, json: async () => ({ attachmentId: 'one.png' }) });
        }),
    );
    fireEvent.change(area, { target: { value: 'keep these words ' } });
    fireEvent.paste(area, { clipboardData: { files: [file] } });
    await waitFor(() => expect(finishUpload).toBeDefined());
    const unsupported = new File(['text'], 'note.txt');
    jest
      .spyOn(unsupported, 'slice')
      .mockReturnValue(
        Object.assign(new Blob(), { arrayBuffer: async () => new Uint8Array([1]).buffer }),
      );
    area.setSelectionRange(0, 4, 'backward');
    fireEvent.paste(area, { clipboardData: { files: [unsupported] } });
    expect(area).toHaveValue('[Image 2] these words [Image 1]');
    finishUpload();
    await waitFor(() => expect(send).toBeEnabled());
    expect(area).toHaveValue('keep these words [Image 1]');
    expect([area.selectionStart, area.selectionEnd]).toEqual([0, 4]);
    expect(area.selectionDirection).toBe('backward');

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ attachmentId: 'two.png' }),
    });
    area.setSelectionRange(area.value.length, area.value.length);
    fireEvent.paste(area, { clipboardData: { files: [file] } });
    area.setSelectionRange(0, area.value.length);
    fireEvent.paste(area, { clipboardData: { files: [unsupported] } });
    replaceTextareaSelection(area, 0, 0, 'please ');
    replaceTextareaSelection(area, area.value.length, area.value.length, 'obsolete');
    area.setSelectionRange(area.value.indexOf('obsolete'), area.value.length);
    fireEvent.paste(area, { clipboardData: { files: [unsupported] } });
    replaceTextareaSelection(area, area.value.lastIndexOf('[Image 5]'), area.value.length, '!');
    await waitFor(() => expect(send).toBeEnabled());
    expect(area).toHaveValue('please keep these words [Image 1][Image 3]!');
    expect(area.selectionStart).toBe(area.value.length);

    socket.emit.mockImplementation((event, payload, ack) => {
      if (event === 'terminal:input')
        ack(null, {
          sendId: payload.sendId,
          status: 'submitted',
          confirmedSegments: 4,
          acknowledgedImages: 2,
        });
    });
    fireEvent.click(send);
    await waitFor(() => expect(area).toHaveValue(''));
    expect(
      socket.emit.mock.calls.find(([event]) => event === 'terminal:input')?.[1].segments,
    ).toEqual([
      { kind: 'text', text: 'please keep these words ' },
      { kind: 'image', attachmentId: 'one.png' },
      { kind: 'image', attachmentId: 'two.png' },
      { kind: 'text', text: '!' },
    ]);
  });

  it('retains a failed upload and replaces it only on explicit upload retry', async () => {
    const { utils, socket, file } = await imageTerminal('form');
    const area = utils.getByPlaceholderText('Type command...');
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ message: 'host busy' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ attachmentId: 'first.png' }) });
    fireEvent.paste(area, { clipboardData: { files: [file] } });
    const retry = await utils.findByRole('button', { name: 'Retry upload' });
    expect(area).toHaveValue('[Image 1]');
    expect(utils.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(utils.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(socket.emit.mock.calls.filter(([e]) => e === 'terminal:input')).toEqual([]);
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
      ok: true,
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
      ok: true,
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
      ok: true,
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

  // ── terminal:theme sync ─────────────────────────────────────────────

  it('syncs the dark terminal theme only after each subscription confirmation', async () => {
    const { socket } = await renderTerminal();
    const themeCalls = () =>
      socket.emit.mock.calls.filter(([event]: [string]) => event === 'terminal:theme');
    expect(themeCalls()).toHaveLength(0);
    const subscribeMsg = {
      topic: 'terminal/chat-session',
      ts: new Date().toISOString(),
      type: 'subscribed',
      payload: { currentSequence: 0 },
    };
    await act(async () => {
      socket.trigger('message', subscribeMsg);
    });
    expect(themeCalls()).toHaveLength(1);
    expect(themeCalls()[0][1]).toEqual({ foregroundHex: '#c9d1d9', backgroundHex: '#1a1a1a' });
    await act(async () => {
      socket.trigger('message', subscribeMsg);
    });
    expect(themeCalls()).toHaveLength(2);
    expect(themeCalls()[0][1]).toEqual(themeCalls()[1][1]);
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

    expect(
      socket.emit.mock.calls.find(([event]: [string]) => event === 'terminal:theme')?.[1],
    ).toEqual({ foregroundHex: '#172b3a', backgroundHex: '#eaf1f5' });
    // Terminal content must survive the retheme
    expect(history.innerHTML).toBe('live-content');

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
