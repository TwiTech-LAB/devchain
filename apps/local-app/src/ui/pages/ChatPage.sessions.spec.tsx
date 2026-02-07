import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// Import as any to avoid TSX type friction in isolated test env
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ChatPage = require('./ChatPage').ChatPage as React.ComponentType;
const toastSpy = jest.fn();

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

// Terminal windows hooks rely on provider; mock to avoid provider wiring
jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => jest.fn(),
  useTerminalWindows: () => ({ windows: [], closeWindow: jest.fn(), focusedWindowId: null }),
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

// Socket mock (no-op)
jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: () => {},
}));
jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: () => ({
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  }),
  releaseAppSocket: jest.fn(),
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

  it('shows standardized toast for non-silent auto-compact launch errors', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        return {
          ok: true,
          json: async () => ({ 'agent-1': { online: false, sessionId: null } }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'thread-1', projectId: 'project-1', isGroup: false, members: ['agent-1'] },
            ],
          }),
        } as Response;
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
      if (url === '/api/sessions/launch' && init?.method === 'POST') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            statusCode: 409,
            code: 'SESSION_LAUNCH_FAILED',
            message: 'Claude auto-compact is enabled.',
            details: {
              code: 'CLAUDE_AUTO_COMPACT_ENABLED',
              providerId: 'provider-1',
              providerName: 'claude',
            },
            timestamp: new Date().toISOString(),
            path: '/api/sessions/launch',
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);
    const alphaButton = await screen.findByLabelText(/Chat with Alpha \(offline\)/i);
    fireEvent.contextMenu(alphaButton);
    fireEvent.click(await screen.findByText(/Launch session/i));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Session launch blocked',
          description: 'Claude auto-compact is enabled - see the notification to resolve.',
        }),
      );
    });
    expect(screen.queryByText('Claude Auto-Compact Detected')).not.toBeInTheDocument();
  });
});

describe('Mass agent controls', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    toastSpy.mockReset();
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

  it('shows standardized toast for silent auto-compact launch failures', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        return {
          ok: true,
          json: async () => ({ 'agent-1': { online: false, sessionId: null } }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
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
      if (url === '/api/sessions/launch' && init?.method === 'POST') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            statusCode: 409,
            code: 'SESSION_LAUNCH_FAILED',
            message: 'Claude auto-compact is enabled.',
            details: {
              code: 'CLAUDE_AUTO_COMPACT_ENABLED',
              providerId: 'provider-1',
              providerName: 'claude',
            },
            timestamp: new Date().toISOString(),
            path: '/api/sessions/launch',
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Chat with Alpha \(offline\)/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^start/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Claude auto-compact is enabled - see the notification to resolve.',
        }),
      );
    });
  });
});
