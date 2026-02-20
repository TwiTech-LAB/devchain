import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TerminalWindowsProvider } from '@/ui/terminal-windows';

// Polyfill DOMRect for floating-ui positioning used by the context menu
interface GlobalWithDOMRect extends Global {
  DOMRect?: typeof DOMRect;
}

if (!(global as GlobalWithDOMRect).DOMRect) {
  (global as GlobalWithDOMRect).DOMRect = class DOMRect {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;

    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
      this.top = y;
      this.left = x;
      this.right = x + width;
      this.bottom = y + height;
    }

    toJSON() {
      return this;
    }

    static fromRect(rect: Partial<{ x: number; y: number; width: number; height: number }> = {}) {
      const { x = 0, y = 0, width = 0, height = 0 } = rect;
      return new DOMRect(x, y, width, height);
    }
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = jest.fn();
}

if (!(global as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver) {
  class ResizeObserverMock {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
  }

  (
    global as unknown as {
      ResizeObserver?: typeof ResizeObserver;
    }
  ).ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}

// Import as any to avoid TSX type friction in isolated test env
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ChatPage = require('./ChatPage').ChatPage as React.ComponentType;
const toastSpy = jest.fn();
const setActiveWorktreeMock = jest.fn();
const openTerminalWindowMock = jest.fn();
const openWorktreeTerminalWindowMock = jest.fn();
const closeWindowMock = jest.fn();
const terminalWindowsMock: Array<{ id: string; minimized?: boolean }> = [];

// Stub xterm CSS import pulled by ChatPage dependencies
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
  InlineTerminalPanel: ({
    sessionId,
    agentName,
    isWindowOpen,
    emptyState,
    windowId,
  }: {
    sessionId: string | null;
    agentName?: string | null;
    isWindowOpen: boolean;
    emptyState?: React.ReactNode;
    windowId?: string | null;
  }) =>
    sessionId ? (
      <div
        role="region"
        aria-label={agentName ? `Inline terminal for ${agentName}` : 'Inline terminal'}
        data-window-open={isWindowOpen ? 'true' : 'false'}
        data-window-id={windowId ?? ''}
      />
    ) : (
      <div>{emptyState}</div>
    ),
}));

// Terminal windows hooks rely on provider; mock to avoid provider wiring
jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => openTerminalWindowMock,
  useWorktreeTerminalWindowManager: () => openWorktreeTerminalWindowMock,
  useTerminalWindows: () => ({
    windows: terminalWindowsMock,
    closeWindow: closeWindowMock,
    focusedWindowId: null,
  }),
  TerminalWindowsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));
// Mock project selection
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: 'project-1',
    projectsLoading: false,
    projectsError: false,
    projects: [],
  }),
}));
jest.mock('@/ui/hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => ({
    activeWorktree: null,
    setActiveWorktree: setActiveWorktreeMock,
    apiBase: '',
    worktrees: [],
    worktreesLoading: false,
  }),
}));

// Socket mock (no-op)
jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: () => {},
}));
jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn(() => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
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

function renderWithClient(ui: React.ReactNode, initialEntries: string[] = ['/chat']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={queryClient}>
        <TerminalWindowsProvider>{ui}</TerminalWindowsProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ChatPage agent context menu', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    toastSpy.mockReset();
    setActiveWorktreeMock.mockReset();
    openTerminalWindowMock.mockReset();
    openWorktreeTerminalWindowMock.mockReset();
    closeWindowMock.mockReset();
    terminalWindowsMock.splice(0, terminalWindowsMock.length);
    global.fetch = jest.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-1', name: 'Alpha', projectId: 'project-1', profileId: 'p1' },
              { id: 'agent-2', name: 'Beta', projectId: 'project-1', profileId: 'p1' },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return {
          ok: true,
          json: async () => ({
            'agent-1': { online: false, sessionId: null },
            'agent-2': { online: true, sessionId: 'session-2' },
          }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
        // API returns array directly, not { items: [] }
        return { ok: true, json: async () => [] } as Response;
      }
      if (url.startsWith('/api/sessions')) {
        return { ok: true, json: async () => ({ id: 'session-new' }) } as Response;
      }
      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [],
            supportedMcpProviders: [],
            timestamp: new Date().toISOString(),
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('shows launch when no session and terminate when running', async () => {
    renderWithClient(<ChatPage />);

    const alphaButton = await screen.findByLabelText(/Chat with Alpha \(offline\)/i);
    const betaButton = await screen.findByLabelText(/Chat with Beta \(online\)/i);

    // Open context menu for offline agent (Alpha) -> should show Launch
    fireEvent.contextMenu(alphaButton);
    await waitFor(() => expect(screen.getByText(/Launch session/i)).toBeInTheDocument());
    expect(screen.queryByText(/Terminate session/i)).not.toBeInTheDocument();

    // Close menu by clicking elsewhere
    fireEvent.click(document.body);

    // Open context menu for online agent with session (Beta) -> should show Terminate
    fireEvent.contextMenu(betaButton);
    await waitFor(() => expect(screen.getByText(/Terminate session/i)).toBeInTheDocument());
  });

  it('launches a session from agent context menu without a selected thread', async () => {
    renderWithClient(<ChatPage />);

    const alphaButton = await screen.findByLabelText(/Chat with Alpha \(offline\)/i);

    fireEvent.contextMenu(alphaButton);
    const launchItem = await screen.findByText(/Launch session/i);
    fireEvent.click(launchItem);

    await waitFor(() => {
      const calls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u === '/api/sessions/launch')).toBe(true);
    });
  });
});

describe('ChatPage worktree agent groups', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    toastSpy.mockReset();
    setActiveWorktreeMock.mockReset();
    openTerminalWindowMock.mockReset();
    openWorktreeTerminalWindowMock.mockReset();
    closeWindowMock.mockReset();
    terminalWindowsMock.splice(0, terminalWindowsMock.length);
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('handles worktree -> main -> worktree round-trip with pooled socket lifecycle', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/worktrees' || url.startsWith('/api/worktrees?')) {
        return {
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              branchName: 'feature/auth',
              status: 'running',
              runtimeType: 'process',
              containerPort: 4310,
              devchainProjectId: 'project-wt-1',
            },
          ],
        } as Response;
      }
      if (url.startsWith('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-main-1', name: 'Main Agent', projectId: 'project-1', profileId: 'p1' },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return {
          ok: true,
          json: async () => ({ 'agent-main-1': { online: false, sessionId: null } }),
        } as Response;
      }
      if (url.startsWith('/api/chat/threads?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'thread-main',
                projectId: 'project-1',
                title: null,
                isGroup: false,
                createdByType: 'user',
                createdByUserId: 'user-1',
                createdByAgentId: null,
                members: ['agent-main-1'],
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/wt/feature-auth/api/agents?projectId=project-wt-1&includeGuests=true') {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'agent-wt-1', name: 'Worktree Agent', profileId: 'p1', type: 'agent' }],
          }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/agents/presence?projectId=project-wt-1') {
        return {
          ok: true,
          json: async () => ({ 'agent-wt-1': { online: true, sessionId: 'session-wt-1' } }),
        } as Response;
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [],
            supportedMcpProviders: [],
            timestamp: new Date().toISOString(),
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    const mainAgentButton = await screen.findByLabelText(/Chat with Main Agent \(offline\)/i);
    fireEvent.click(mainAgentButton);
    await waitFor(() => {
      expect(mainAgentButton).toHaveAttribute('aria-current', 'true');
    });

    const worktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent in feature-auth \(online\)/i,
    );
    expect(screen.getByText('Process')).toBeInTheDocument();
    fireEvent.click(worktreeAgentButton);

    await waitFor(() => {
      expect(mainAgentButton).not.toHaveAttribute('aria-current');
      expect(worktreeAgentButton).toHaveAttribute('aria-current', 'true');
    });
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /Inline terminal for Worktree Agent/i }),
      ).toBeInTheDocument();
    });

    fireEvent.click(mainAgentButton);
    await waitFor(() => {
      expect(mainAgentButton).toHaveAttribute('aria-current', 'true');
      expect(worktreeAgentButton).not.toHaveAttribute('aria-current');
    });

    const socketLib = jest.requireMock('@/ui/lib/socket') as {
      getWorktreeSocket: jest.Mock;
      releaseWorktreeSocket: jest.Mock;
    };
    expect(socketLib.releaseWorktreeSocket).toHaveBeenCalledWith('feature-auth');

    fireEvent.click(worktreeAgentButton);
    await waitFor(() => {
      expect(mainAgentButton).not.toHaveAttribute('aria-current');
      expect(worktreeAgentButton).toHaveAttribute('aria-current', 'true');
    });
    expect(socketLib.getWorktreeSocket).toHaveBeenCalledWith('feature-auth');
    expect(socketLib.getWorktreeSocket.mock.calls.length).toBeGreaterThanOrEqual(2);

    expect(screen.queryByText(/Loading projects/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Launch session/i })).not.toBeInTheDocument();
    const openWindowButton = screen.getByRole('button', { name: /Open terminal in window/i });
    fireEvent.click(openWindowButton);
    expect(openWorktreeTerminalWindowMock).toHaveBeenCalledWith({
      sessionId: 'session-wt-1',
      agentName: 'Worktree Agent',
      worktreeName: 'feature-auth',
    });

    expect(setActiveWorktreeMock).not.toHaveBeenCalled();
    const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/chat/threads/direct'))).toBe(false);
  });

  it('detects window-open state via worktree window id scheme', async () => {
    terminalWindowsMock.push({ id: 'worktree:feature-auth:session-wt-1', minimized: false });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/worktrees' || url.startsWith('/api/worktrees?')) {
        return {
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              branchName: 'feature/auth',
              status: 'running',
              containerPort: 4310,
              devchainProjectId: 'project-wt-1',
            },
          ],
        } as Response;
      }
      if (url.startsWith('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-main-1', name: 'Main Agent', projectId: 'project-1', profileId: 'p1' },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return {
          ok: true,
          json: async () => ({ 'agent-main-1': { online: false, sessionId: null } }),
        } as Response;
      }
      if (url.startsWith('/api/chat/threads?projectId=')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/wt/feature-auth/api/agents?projectId=project-wt-1&includeGuests=true') {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'agent-wt-1', name: 'Worktree Agent', profileId: 'p1', type: 'agent' }],
          }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/agents/presence?projectId=project-wt-1') {
        return {
          ok: true,
          json: async () => ({ 'agent-wt-1': { online: true, sessionId: 'session-wt-1' } }),
        } as Response;
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    const worktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent in feature-auth \(online\)/i,
    );
    fireEvent.click(worktreeAgentButton);

    const inlineTerminalRegion = await screen.findByRole('region', {
      name: /Inline terminal for Worktree Agent/i,
    });
    expect(inlineTerminalRegion).toHaveAttribute('data-window-open', 'true');
    expect(inlineTerminalRegion).toHaveAttribute(
      'data-window-id',
      'worktree:feature-auth:session-wt-1',
    );
  });

  it('shows launch/restart worktree context menu items for offline agent and launches via proxy', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/worktrees' || url.startsWith('/api/worktrees?')) {
        return {
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              branchName: 'feature/auth',
              status: 'running',
              containerPort: 4310,
              devchainProjectId: 'project-wt-1',
            },
          ],
        } as Response;
      }
      if (url.startsWith('/api/agents?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.startsWith('/api/chat/threads?projectId=')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/wt/feature-auth/api/agents?projectId=project-wt-1&includeGuests=true') {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'agent-wt-1', name: 'Worktree Agent', profileId: 'p1', type: 'agent' }],
          }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/agents/presence?projectId=project-wt-1') {
        return {
          ok: true,
          json: async () => ({ 'agent-wt-1': { online: false, sessionId: null } }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/launch' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            id: 'session-wt-1',
            agentId: 'agent-wt-1',
            status: 'running',
            epicId: null,
            tmuxSessionId: 'tmux-wt-1',
            startedAt: '2024-01-01T00:00:00.000Z',
            endedAt: null,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }),
        } as Response;
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    const worktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent in feature-auth \(offline\)/i,
    );
    fireEvent.contextMenu(worktreeAgentButton);

    await waitFor(() => {
      expect(screen.getByText(/Restart session/i)).toBeInTheDocument();
      expect(screen.getByText(/Launch session/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Terminate session/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Launch session/i));
    await waitFor(() => {
      const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
      expect(urls).toContain('/wt/feature-auth/api/sessions/launch');
    });
  });

  it('tracks worktree busy state per agent key without disabling other worktree rows', async () => {
    let resolveLaunch: (() => void) | null = null;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/worktrees' || url.startsWith('/api/worktrees?')) {
        return {
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              branchName: 'feature/auth',
              status: 'running',
              containerPort: 4310,
              devchainProjectId: 'project-wt-1',
            },
          ],
        } as Response;
      }
      if (url.startsWith('/api/agents?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.startsWith('/api/chat/threads?projectId=')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/wt/feature-auth/api/agents?projectId=project-wt-1&includeGuests=true') {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-wt-1', name: 'Worktree Agent One', profileId: 'p1', type: 'agent' },
              { id: 'agent-wt-2', name: 'Worktree Agent Two', profileId: 'p1', type: 'agent' },
            ],
          }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/agents/presence?projectId=project-wt-1') {
        return {
          ok: true,
          json: async () => ({
            'agent-wt-1': { online: false, sessionId: null },
            'agent-wt-2': { online: false, sessionId: null },
          }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/launch' && init?.method === 'POST') {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        if (body.agentId === 'agent-wt-1') {
          return new Promise<Response>((resolve) => {
            resolveLaunch = () =>
              resolve({
                ok: true,
                json: async () => ({
                  id: 'session-wt-1',
                  agentId: 'agent-wt-1',
                  status: 'running',
                  epicId: null,
                  tmuxSessionId: 'tmux-wt-1',
                  startedAt: '2024-01-01T00:00:00.000Z',
                  endedAt: null,
                  createdAt: '2024-01-01T00:00:00.000Z',
                  updatedAt: '2024-01-01T00:00:00.000Z',
                }),
              } as Response);
          });
        }
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    const firstWorktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent One in feature-auth \(offline\)/i,
    );
    const secondWorktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent Two in feature-auth \(offline\)/i,
    );

    fireEvent.contextMenu(firstWorktreeAgentButton);
    fireEvent.click(await screen.findByText(/^Launch session$/i));

    await waitFor(() => {
      expect(firstWorktreeAgentButton).toBeDisabled();
    });
    expect(secondWorktreeAgentButton).not.toBeDisabled();

    await act(async () => {
      resolveLaunch?.();
    });
  });

  it('shows terminate in worktree context menu when session is active and calls proxied terminate', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/worktrees' || url.startsWith('/api/worktrees?')) {
        return {
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              branchName: 'feature/auth',
              status: 'running',
              containerPort: 4310,
              devchainProjectId: 'project-wt-1',
            },
          ],
        } as Response;
      }
      if (url.startsWith('/api/agents?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.startsWith('/api/chat/threads?projectId=')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/wt/feature-auth/api/agents?projectId=project-wt-1&includeGuests=true') {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'agent-wt-1', name: 'Worktree Agent', profileId: 'p1', type: 'agent' }],
          }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/agents/presence?projectId=project-wt-1') {
        return {
          ok: true,
          json: async () => ({ 'agent-wt-1': { online: true, sessionId: 'session-wt-1' } }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/session-wt-1' && init?.method === 'DELETE') {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    const worktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent in feature-auth \(online\)/i,
    );
    fireEvent.contextMenu(worktreeAgentButton);

    await waitFor(() => {
      expect(screen.getByText(/Restart session/i)).toBeInTheDocument();
      expect(screen.getByText(/Terminate session/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/^Launch session$/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/Terminate session/i));
    await waitFor(() => {
      const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
      expect(urls).toContain('/wt/feature-auth/api/sessions/session-wt-1');
    });
  });

  it('shows MCP guidance toast for worktree context launch failures', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/worktrees' || url.startsWith('/api/worktrees?')) {
        return {
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              branchName: 'feature/auth',
              status: 'running',
              containerPort: 4310,
              devchainProjectId: 'project-wt-1',
            },
          ],
        } as Response;
      }
      if (url.startsWith('/api/agents?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.startsWith('/api/chat/threads?projectId=')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/wt/feature-auth/api/agents?projectId=project-wt-1&includeGuests=true') {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'agent-wt-1', name: 'Worktree Agent', profileId: 'p1', type: 'agent' }],
          }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/agents/presence?projectId=project-wt-1') {
        return {
          ok: true,
          json: async () => ({ 'agent-wt-1': { online: false, sessionId: null } }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/launch' && init?.method === 'POST') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            statusCode: 409,
            code: 'SESSION_LAUNCH_FAILED',
            message: 'MCP configuration required',
            details: {
              code: 'MCP_NOT_CONFIGURED',
              providerId: 'provider-1',
              providerName: 'claude',
            },
            timestamp: new Date().toISOString(),
            path: '/wt/feature-auth/api/sessions/launch',
          }),
        } as Response;
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    const worktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent in feature-auth \(offline\)/i,
    );
    fireEvent.contextMenu(worktreeAgentButton);
    fireEvent.click(await screen.findByText(/^Launch session$/i));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'MCP not configured',
          description: expect.stringContaining('Switch to worktree tab to configure MCP'),
        }),
      );
    });
  });

  it('keeps offline worktree agents clickable and launches via worktree apiBase', async () => {
    let worktreePresenceRequestCount = 0;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/worktrees' || url.startsWith('/api/worktrees?')) {
        return {
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              branchName: 'feature/auth',
              status: 'running',
              containerPort: 4310,
              devchainProjectId: 'project-wt-1',
            },
          ],
        } as Response;
      }
      if (url.startsWith('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-main-1', name: 'Main Agent', projectId: 'project-1', profileId: 'p1' },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return {
          ok: true,
          json: async () => ({ 'agent-main-1': { online: true, sessionId: 'session-main-1' } }),
        } as Response;
      }
      if (url.startsWith('/api/chat/threads?projectId=')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/wt/feature-auth/api/agents?projectId=project-wt-1&includeGuests=true') {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'agent-wt-1', name: 'Worktree Agent', profileId: 'p1', type: 'agent' }],
          }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/agents/presence?projectId=project-wt-1') {
        worktreePresenceRequestCount += 1;
        return {
          ok: true,
          json: async () => ({
            'agent-wt-1':
              worktreePresenceRequestCount > 1
                ? { online: true, sessionId: 'session-wt-1' }
                : { online: false, sessionId: null },
          }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/launch' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            id: 'session-wt-1',
            agentId: 'agent-wt-1',
            status: 'running',
            epicId: null,
            tmuxSessionId: 'tmux-wt-1',
            startedAt: '2024-01-01T00:00:00.000Z',
            endedAt: null,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }),
        } as Response;
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    const worktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent in feature-auth \(offline\)/i,
    );
    expect(worktreeAgentButton).not.toBeDisabled();

    fireEvent.click(worktreeAgentButton);
    const launchButton = await screen.findByRole('button', { name: /Launch session/i });
    fireEvent.click(launchButton);

    await waitFor(() => {
      const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
      expect(urls).toContain('/wt/feature-auth/api/sessions/launch');
    });
    await waitFor(() => {
      expect(worktreePresenceRequestCount).toBeGreaterThan(1);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: /Inline terminal for Worktree Agent/i }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Launch session/i })).not.toBeInTheDocument();
    expect(openWorktreeTerminalWindowMock).not.toHaveBeenCalled();
  });
});

describe('ChatPage worktree provider config context menu', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    toastSpy.mockReset();
    setActiveWorktreeMock.mockReset();
    openTerminalWindowMock.mockReset();
    openWorktreeTerminalWindowMock.mockReset();
    closeWindowMock.mockReset();
    terminalWindowsMock.splice(0, terminalWindowsMock.length);
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  /** Standard fetch mock for worktree provider config tests. */
  function setupFetch(overrides?: {
    mainAgents?: Array<Record<string, unknown>>;
    mainPresence?: Record<string, unknown>;
    worktreeAgents?: Array<Record<string, unknown>>;
    worktreePresence?: Record<string, unknown>;
    worktreeProviderConfigs?: Array<Record<string, unknown>>;
    worktreeProjectId?: string | null;
  }) {
    const {
      mainAgents = [
        {
          id: 'agent-1',
          name: 'Main Agent',
          projectId: 'project-1',
          profileId: 'p1',
          providerConfigId: 'config-1',
        },
      ],
      mainPresence = { 'agent-1': { online: true, sessionId: 'session-main-1' } },
      worktreeAgents = [
        {
          id: 'agent-wt-1',
          name: 'Worktree Agent',
          profileId: 'p1',
          type: 'agent',
          providerConfigId: 'wt-config-1',
        },
      ],
      worktreePresence = { 'agent-wt-1': { online: true, sessionId: 'session-wt-1' } },
      worktreeProviderConfigs = [
        { id: 'wt-config-1', name: 'WT Config A', providerId: 'provider-1' },
        { id: 'wt-config-2', name: 'WT Config B', providerId: 'provider-1' },
      ],
      worktreeProjectId = 'project-wt-1',
    } = overrides ?? {};

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
        } as Response;
      }
      if (url === '/api/worktrees' || url.startsWith('/api/worktrees?')) {
        return {
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              branchName: 'feature/auth',
              status: worktreeProjectId ? 'running' : 'stopped',
              runtimeType: 'process',
              containerPort: worktreeProjectId ? 4310 : 0,
              devchainProjectId: worktreeProjectId,
            },
          ],
        } as Response;
      }
      if (url.startsWith('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({ items: mainAgents }),
        } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return { ok: true, json: async () => mainPresence } as Response;
      }
      if (url.startsWith('/api/chat/threads?projectId=')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url === '/wt/feature-auth/api/agents?projectId=project-wt-1&includeGuests=true') {
        return {
          ok: true,
          json: async () => ({ items: worktreeAgents }),
        } as Response;
      }
      if (url === '/wt/feature-auth/api/sessions/agents/presence?projectId=project-wt-1') {
        return { ok: true, json: async () => worktreePresence } as Response;
      }
      // Worktree provider configs — must be before the generic /api/profiles/ handler
      if (url.startsWith('/wt/feature-auth/api/profiles/') && url.endsWith('/provider-configs')) {
        return { ok: true, json: async () => worktreeProviderConfigs } as Response;
      }
      // Main provider configs
      if (url.startsWith('/api/profiles/') && url.endsWith('/provider-configs')) {
        return {
          ok: true,
          json: async () => [
            { id: 'config-1', name: 'Config A', providerId: 'provider-1' },
            { id: 'config-2', name: 'Config B', providerId: 'provider-1' },
          ],
        } as Response;
      }
      // PUT for worktree config update
      if (init?.method === 'PUT' && url.startsWith('/wt/feature-auth/api/agents/')) {
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      // PUT for main config update
      if (init?.method === 'PUT' && url.startsWith('/api/agents/')) {
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      if (url.startsWith('/api/preflight')) {
        return {
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [],
            supportedMcpProviders: [],
            timestamp: new Date().toISOString(),
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  }

  it('shows Provider Config submenu in worktree agent context menu', async () => {
    setupFetch();
    renderWithClient(<ChatPage />);

    const worktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent in feature-auth \(online\)/i,
    );
    fireEvent.contextMenu(worktreeAgentButton);

    await waitFor(() => {
      expect(screen.getByText('Provider Config')).toBeInTheDocument();
    });
  });

  it('fetches provider configs from worktree proxy and triggers proxied PUT on selection', async () => {
    setupFetch();
    renderWithClient(<ChatPage />);

    const worktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent in feature-auth \(online\)/i,
    );
    fireEvent.contextMenu(worktreeAgentButton);

    // ProviderConfigSubmenu mounts on context menu open → useQuery fires
    await waitFor(() => {
      const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(urls).toContain('/wt/feature-auth/api/profiles/p1/provider-configs');
    });

    // Open the submenu via keyboard navigation (ArrowRight on sub trigger)
    const trigger = screen.getByText('Provider Config');
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });

    // Wait for configs to appear in submenu content
    const configB = await screen.findByText('WT Config B');
    fireEvent.click(configB);
    await waitFor(() => {
      const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(urls).toContain('/wt/feature-auth/api/agents/agent-wt-1');
    });
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Config updated' }));
    });
  });

  it('uses separate cache for main and worktree provider configs with same profileId', async () => {
    setupFetch();
    renderWithClient(<ChatPage />);

    // Open main agent context menu → triggers main provider config fetch
    const mainAgentButton = await screen.findByLabelText(/Chat with Main Agent \(online\)/i);
    fireEvent.contextMenu(mainAgentButton);

    await waitFor(() => {
      const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(urls.some((u: string) => u === '/api/profiles/p1/provider-configs')).toBe(true);
    });

    // Close main context menu
    fireEvent.click(document.body);

    // Open worktree agent context menu → triggers worktree provider config fetch
    const worktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent in feature-auth \(online\)/i,
    );
    fireEvent.contextMenu(worktreeAgentButton);

    await waitFor(() => {
      const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
      // Both URLs should have been fetched (no cache sharing despite same profileId)
      expect(urls.some((u: string) => u === '/api/profiles/p1/provider-configs')).toBe(true);
      expect(
        urls.some((u: string) => u === '/wt/feature-auth/api/profiles/p1/provider-configs'),
      ).toBe(true);
    });
  });

  it('isolates updating state between main and worktree agents with same ID', async () => {
    let resolveWorktreePut: (() => void) | null = null;

    // Use agents with the SAME ID to test state isolation
    setupFetch({
      mainAgents: [
        { id: 'shared-id', name: 'Main Agent', projectId: 'project-1', profileId: 'p1' },
      ],
      mainPresence: { 'shared-id': { online: true, sessionId: 'session-main' } },
      worktreeAgents: [
        {
          id: 'shared-id',
          name: 'Worktree Agent',
          profileId: 'p1',
          type: 'agent',
          providerConfigId: 'wt-config-1',
        },
      ],
      worktreePresence: { 'shared-id': { online: true, sessionId: 'session-wt' } },
    });

    // Intercept worktree PUT to keep it pending
    const baseFetch = global.fetch as jest.Mock;
    const originalImpl = baseFetch.getMockImplementation()!;
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT' && url.startsWith('/wt/feature-auth/api/agents/')) {
        return new Promise<Response>((resolve) => {
          resolveWorktreePut = () =>
            resolve({ ok: true, json: async () => ({ success: true }) } as Response);
        });
      }
      return originalImpl(input, init);
    });

    renderWithClient(<ChatPage />);

    // Open worktree context menu and attempt to trigger config switch
    const worktreeAgentButton = await screen.findByLabelText(
      /Open terminal for Worktree Agent in feature-auth \(online\)/i,
    );
    fireEvent.contextMenu(worktreeAgentButton);

    await waitFor(() => {
      expect(screen.getByText('Provider Config')).toBeInTheDocument();
    });

    // Try to open submenu and select a config
    const trigger = screen.getByText('Provider Config');
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });

    const configB = await screen.findByText('WT Config B');
    fireEvent.click(configB);

    // While worktree PUT is pending, open main agent context menu
    fireEvent.click(document.body); // close worktree menu
    const mainButton = screen.getByLabelText(/Chat with Main Agent \(online\)/i);
    fireEvent.contextMenu(mainButton);

    // Main agent's Provider Config submenu should be present and NOT show updating state
    await waitFor(() => {
      const mainTrigger = screen.getByText('Provider Config');
      expect(mainTrigger).toBeInTheDocument();
      // The trigger should not be disabled (state isolation)
      expect(mainTrigger).not.toHaveAttribute('data-disabled');
    });

    // Resolve the pending worktree PUT
    await act(async () => {
      resolveWorktreePut?.();
    });
  });

  it('disables Provider Config submenu when worktree has no devchainProjectId', async () => {
    setupFetch({
      worktreeProjectId: null,
      worktreeAgents: [],
      worktreePresence: {},
    });
    renderWithClient(<ChatPage />);

    // Worktree with no devchainProjectId shows as unavailable — no agents rendered
    await waitFor(() => {
      expect(screen.getByText('feature-auth')).toBeInTheDocument();
    });

    // Unavailable worktree should show "Worktree unavailable." instead of agent rows
    await waitFor(() => {
      expect(screen.getByText(/Worktree unavailable/i)).toBeInTheDocument();
    });
  });

  it('does not render Provider Config submenu for agent without profileId', async () => {
    setupFetch({
      worktreeAgents: [
        { id: 'agent-no-profile', name: 'No Profile Agent', profileId: null, type: 'agent' },
      ],
      worktreePresence: { 'agent-no-profile': { online: true, sessionId: 'session-np' } },
    });
    renderWithClient(<ChatPage />);

    const agentButton = await screen.findByLabelText(
      /Open terminal for No Profile Agent in feature-auth \(online\)/i,
    );
    fireEvent.contextMenu(agentButton);

    // Context menu should open with session actions but NO Provider Config submenu
    await waitFor(() => {
      expect(screen.getByText(/Restart session/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Provider Config')).not.toBeInTheDocument();
  });
});

describe('Mass agent controls', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    toastSpy.mockReset();
    setActiveWorktreeMock.mockReset();
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('disables Start All while presence is loading', async () => {
    // Mock presence query to never resolve (simulate loading)
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'agent-1', name: 'Alpha', projectId: 'project-1', profileId: 'p1' }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        // Never resolve - keep loading
        return new Promise(() => {});
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    // Wait for agents to load
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });

    // Start button should be disabled while presence is loading
    const startButton = screen.getByRole('button', { name: /^start/i });
    expect(startButton).toBeDisabled();
  });

  it('enables Start All after presence loads with offline agents', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-1', name: 'Alpha', projectId: 'project-1', profileId: 'p1' },
              { id: 'agent-2', name: 'Beta', projectId: 'project-1', profileId: 'p1' },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return {
          ok: true,
          json: async () => ({
            'agent-1': { online: false, sessionId: null },
            'agent-2': { online: false, sessionId: null },
          }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    // Wait for presence to load (agents show offline state)
    await waitFor(() => {
      expect(screen.getByLabelText(/Chat with Alpha \(offline\)/i)).toBeInTheDocument();
    });

    // Start button should be enabled when there are offline agents
    const startButton = screen.getByRole('button', { name: /^start/i });
    expect(startButton).not.toBeDisabled();
  });

  it('disables Start All when all agents are online', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-1', name: 'Alpha', projectId: 'project-1', profileId: 'p1' },
              { id: 'agent-2', name: 'Beta', projectId: 'project-1', profileId: 'p1' },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return {
          ok: true,
          json: async () => ({
            'agent-1': { online: true, sessionId: 'session-1' },
            'agent-2': { online: true, sessionId: 'session-2' },
          }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    // Wait for presence to load (agents show online state)
    await waitFor(() => {
      expect(screen.getByLabelText(/Chat with Alpha \(online\)/i)).toBeInTheDocument();
    });

    // Start button should be disabled when no offline agents
    const startButton = screen.getByRole('button', { name: /^start/i });
    expect(startButton).toBeDisabled();
  });

  it('disables Stop All when no agents have sessions', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-1', name: 'Alpha', projectId: 'project-1', profileId: 'p1' },
              { id: 'agent-2', name: 'Beta', projectId: 'project-1', profileId: 'p1' },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return {
          ok: true,
          json: async () => ({
            'agent-1': { online: false, sessionId: null },
            'agent-2': { online: false, sessionId: null },
          }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    // Wait for presence to load
    await waitFor(() => {
      expect(screen.getByLabelText(/Chat with Alpha \(offline\)/i)).toBeInTheDocument();
    });

    // Stop button should be disabled when no agents have sessions
    const stopButton = screen.getByRole('button', { name: /^stop/i });
    expect(stopButton).toBeDisabled();
  });
});
