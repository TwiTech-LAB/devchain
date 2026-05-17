import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const socketEmitSpy = jest.fn();
const focusedWindowIdMock = { value: null as string | null };

jest.mock('@xterm/xterm/css/xterm.css', () => ({}), { virtual: true });
jest.mock('@xterm/xterm', () => {
  const fake = {
    loadAddon: jest.fn(),
    dispose: jest.fn(),
    open: jest.fn(),
    reset: jest.fn(),
    write: jest.fn(),
    attachCustomKeyEventHandler: jest.fn(),
    onData: jest.fn(() => ({ dispose: jest.fn() })),
    onResize: jest.fn(() => ({ dispose: jest.fn() })),
    onTitleChange: jest.fn(() => ({ dispose: jest.fn() })),
    onSelectionChange: jest.fn(() => ({ dispose: jest.fn() })),
  };
  return {
    Terminal: jest.fn(() => fake),
    FitAddon: jest
      .fn()
      .mockImplementation(() => ({ activate: jest.fn(), dispose: jest.fn(), fit: jest.fn() })),
  };
});
jest.mock('@/ui/components/chat/InlineTerminalPanel', () => ({
  InlineTerminalPanel: () => <div data-testid="inline-terminal" />,
}));
jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => jest.fn(),
  useWorktreeTerminalWindowManager: () => jest.fn(),
  useTerminalWindows: () => ({
    windows: [],
    closeWindow: jest.fn(),
    get focusedWindowId() {
      return focusedWindowIdMock.value;
    },
  }),
  TerminalWindowsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: 'project-1',
    selectedProject: { id: 'project-1', name: 'Test', rootPath: '/tmp/test' },
    projectsLoading: false,
    projectsError: false,
    projects: [],
  }),
}));
jest.mock('@/ui/hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => ({
    activeWorktree: null,
    setActiveWorktree: jest.fn(),
    apiBase: '',
    worktrees: [],
    worktreesLoading: false,
    runtimeResolved: true,
  }),
}));
jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: socketEmitSpy,
  })),
}));
jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: socketEmitSpy,
  })),
  getWorktreeSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  })),
  releaseAppSocket: jest.fn(),
  releaseWorktreeSocket: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ChatPage = require('./ChatPage').ChatPage as React.ComponentType;

function renderChatPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/chat']}>
      <QueryClientProvider client={queryClient}>
        <ChatPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ChatPage Escape handler emit ordering (RTL)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    socketEmitSpy.mockClear();
    focusedWindowIdMock.value = 'focused-terminal-session';
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [] }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    focusedWindowIdMock.value = null;
    global.fetch = originalFetch;
  });

  it('emits terminal:focus immediately before terminal:input on Escape keydown', async () => {
    await act(async () => {
      renderChatPage();
    });

    socketEmitSpy.mockClear();

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });

    const focusCall = socketEmitSpy.mock.calls.find(
      ([event]: [string]) => event === 'terminal:focus',
    );
    const inputCall = socketEmitSpy.mock.calls.find(
      ([event]: [string]) => event === 'terminal:input',
    );

    expect(focusCall).toBeDefined();
    expect(inputCall).toBeDefined();
    expect(focusCall![1]).toEqual({ sessionId: 'focused-terminal-session' });
    expect(inputCall![1]).toEqual({ sessionId: 'focused-terminal-session', data: '\x1b' });

    const focusIndex = socketEmitSpy.mock.calls.indexOf(focusCall!);
    const inputIndex = socketEmitSpy.mock.calls.indexOf(inputCall!);
    expect(focusIndex).toBeLessThan(inputIndex);
  });

  it('does not emit when no focused window', async () => {
    focusedWindowIdMock.value = null;

    await act(async () => {
      renderChatPage();
    });

    socketEmitSpy.mockClear();

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });

    const focusCall = socketEmitSpy.mock.calls.find(
      ([event]: [string]) => event === 'terminal:focus',
    );
    const inputCall = socketEmitSpy.mock.calls.find(
      ([event]: [string]) => event === 'terminal:input',
    );

    expect(focusCall).toBeUndefined();
    expect(inputCall).toBeUndefined();
  });
});
