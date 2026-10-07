import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TerminalWindowsProvider } from '@/ui/terminal-windows';

// Polyfill DOMRect for floating-ui positioning used by the context menu
type GlobalWithDOMRect = typeof globalThis & { DOMRect?: typeof DOMRect };

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

// Import as ComponentType for isolated JSX typing.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ChatPage = require('./ChatPage').ChatPage as React.ComponentType;
const toastSpy = jest.fn();
const openTerminalWindowMock = jest.fn();
const closeWindowMock = jest.fn();
const focusedWindowIdMock = { value: null as string | null };
const terminalWindowsMock: Array<{ id: string; minimized?: boolean }> = [];
const appSocketEmitMock = jest.fn();
const mockAppSocket = {
  connected: true,
  on: jest.fn(),
  off: jest.fn(),
  emit: appSocketEmitMock,
};
const mockInlineTerminalHandle = {
  clear: jest.fn(),
  fit: jest.fn(),
  focus: jest.fn(),
  insertPromptText: jest.fn().mockResolvedValue(undefined),
};
let selectedProjectIdMock = 'project-1';
let selectedProjectRootPathMock = '/tmp/project-1';

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
    element: document.createElement('div'),
    hasSelection: jest.fn(() => false),
    getSelection: jest.fn(() => ''),
    clearSelection: jest.fn(),
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
    terminalRef,
  }: {
    sessionId: string | null;
    agentName?: string | null;
    isWindowOpen: boolean;
    emptyState?: React.ReactNode;
    windowId?: string | null;
    terminalRef?: React.Ref<typeof mockInlineTerminalHandle>;
  }) => {
    React.useEffect(() => {
      if (!sessionId || isWindowOpen || !terminalRef) {
        return;
      }
      if (typeof terminalRef === 'function') {
        terminalRef(mockInlineTerminalHandle);
        return () => terminalRef(null);
      }
      (terminalRef as React.MutableRefObject<typeof mockInlineTerminalHandle | null>).current =
        mockInlineTerminalHandle;
      return () => {
        (terminalRef as React.MutableRefObject<typeof mockInlineTerminalHandle | null>).current =
          null;
      };
    }, [isWindowOpen, sessionId, terminalRef]);

    return sessionId ? (
      <div
        role="region"
        aria-label={agentName ? `Inline terminal for ${agentName}` : 'Inline terminal'}
        data-window-open={isWindowOpen ? 'true' : 'false'}
        data-window-id={windowId ?? ''}
      />
    ) : (
      <div>{emptyState}</div>
    );
  },
}));

// Terminal windows hooks rely on provider; mock to avoid provider wiring
jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => openTerminalWindowMock,
  useTerminalWindows: () => ({
    windows: terminalWindowsMock,
    closeWindow: closeWindowMock,
    focusedWindowId: focusedWindowIdMock.value,
  }),
  TerminalWindowsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));
// Mock project selection
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: selectedProjectIdMock,
    selectedProject: selectedProjectIdMock
      ? {
          id: selectedProjectIdMock,
          name: `Project ${selectedProjectIdMock}`,
          rootPath: selectedProjectRootPathMock,
        }
      : null,
    projectsLoading: false,
    projectsError: false,
    projects: [],
  }),
}));
// Socket mock — must return a Socket-like object with `connected` property
jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(() => mockAppSocket),
}));
jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn(() => mockAppSocket),
  releaseAppSocket: jest.fn(),
}));

function renderWithClient(ui: React.ReactNode, initialEntries: string[] = ['/chat']) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={queryClient}>
        <TerminalWindowsProvider>{ui}</TerminalWindowsProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...utils, queryClient };
}

beforeEach(() => {
  focusedWindowIdMock.value = null;
  selectedProjectIdMock = 'project-1';
  selectedProjectRootPathMock = '/tmp/project-1';
});

describe('ChatPage agent grouping toggle', () => {
  const originalFetch = global.fetch;
  const LS_KEY = 'devchain:chat:agentTab:project-1';
  let requestedUrls: string[] = [];

  beforeEach(() => {
    requestedUrls = [];
    window.localStorage.removeItem(LS_KEY);
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
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
          json: async () => ({
            'agent-1': { online: false, sessionId: null },
          }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    window.localStorage.removeItem(LS_KEY);
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('defaults to all mode and keeps the flat agent list visible', async () => {
    renderWithClient(<ChatPage />);

    const allTab = await screen.findByRole('tab', { name: 'All' });
    expect(allTab).toHaveAttribute('data-state', 'active');
    expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('data-state', 'inactive');
    expect(
      await screen.findByLabelText(/Open terminal for Alpha \(offline\)/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No teams configured/i)).not.toBeInTheDocument();
  });
});

describe('ChatPage agent context menu', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    toastSpy.mockReset();
    openTerminalWindowMock.mockReset();
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

  it('launches a session from agent context menu without a selected thread', async () => {
    renderWithClient(<ChatPage />);

    const alphaButton = await screen.findByLabelText(/Open terminal for Alpha \(offline\)/i);

    fireEvent.contextMenu(alphaButton);
    const launchItem = await screen.findByRole('menuitem', { name: /Launch session/i });
    fireEvent.click(launchItem);

    await waitFor(() => {
      const calls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u === '/api/sessions/launch')).toBe(true);
    });
  });

  it('renders Launch Session and previous sessions for the selected offline agent', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);

    expect(await screen.findByRole('button', { name: 'Launch Session' })).toBeInTheDocument();
    expect(await screen.findByText('No previous sessions for this agent yet.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Inline terminal for Alpha/i })).toBeNull();
  });

  it('renders the inline terminal surface for the selected online agent', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-2']);

    expect(
      await screen.findByRole('region', { name: /Inline terminal for Beta/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Launch Session' })).toBeNull();
  });
});

describe('ChatPage agent selection transport invariant', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('updates selected agent state without calling the chat API', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/agents?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'agent-1',
                name: 'Alpha',
                projectId: 'project-1',
                profileId: 'p1',
                isProjectOwner: false,
              },
              {
                id: 'agent-2',
                name: 'Beta',
                projectId: 'project-1',
                profileId: 'p1',
                isProjectOwner: false,
              },
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
      if (url.startsWith('/api/sessions?projectId=')) {
        return {
          ok: true,
          json: async () => [],
        } as Response;
      }
      if (url.startsWith('/api/chat/threads?projectId=')) {
        const isMainProjectUserThreads =
          url.includes('projectId=project-1') && url.includes('createdByType=user');
        return {
          ok: true,
          json: async () => ({
            items: isMainProjectUserThreads
              ? [
                  {
                    id: 'thread-main',
                    projectId: 'project-1',
                    title: 'Alpha',
                    isGroup: false,
                    createdByType: 'user',
                    createdByUserId: 'user-1',
                    createdByAgentId: null,
                    members: ['agent-1'],
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                  },
                ]
              : [],
            total: isMainProjectUserThreads ? 1 : 0,
            limit: 50,
            offset: 0,
          }),
        } as Response;
      }
      if (url.startsWith('/api/chat/threads/thread-main/messages?')) {
        return {
          ok: true,
          json: async () => ({
            items: [],
            total: 0,
            limit: 50,
            offset: 0,
          }),
        } as Response;
      }
      if (url.startsWith('/api/profiles?projectId=')) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url === '/api/providers') {
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
      if (url.startsWith('/api/projects/') && url.endsWith('/presets')) {
        return {
          ok: true,
          json: async () => ({ presets: [], activePreset: null }),
        } as Response;
      }

      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);

    const betaButton = await screen.findByLabelText(/Open terminal for Beta \(offline\)/i);
    await waitFor(() => {
      const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.startsWith('/api/chat'))).toBe(false);
    });

    (global.fetch as jest.Mock).mockClear();
    fireEvent.click(betaButton);

    await waitFor(() => expect(betaButton).toHaveAttribute('aria-current', 'true'));
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls.some(([input]) => String(input).startsWith('/api/chat'))).toBe(false);
    expect(
      calls.some(
        ([input, init]) => String(input).startsWith('/api/chat') && init?.method === 'POST',
      ),
    ).toBe(false);
  });
});

describe('ChatPage custom prompt Escape handling', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    appSocketEmitMock.mockReset();
    terminalWindowsMock.splice(0, terminalWindowsMock.length);
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
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
          json: async () => ({
            'agent-main-1': { online: true, sessionId: 'session-main-1' },
          }),
        } as Response;
      }
      if (url.includes('/transcript/summary')) {
        return {
          ok: true,
          json: async () => ({
            sessionId: 'session-main-1',
            providerName: 'claude',
            metrics: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: 0,
              totalContextConsumption: 0,
              compactionCount: 0,
              phaseBreakdowns: [],
              visibleContextTokens: 0,
              totalContextTokens: 0,
              contextWindowTokens: 200000,
              costUsd: 0,
              messageCount: 0,
            },
            isOngoing: true,
          }),
        } as Response;
      }
      if (url.startsWith('/api/sessions')) {
        return { ok: true, json: async () => [] } as Response;
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
      if (url.startsWith('/api/prompts?projectId=project-1')) {
        return { ok: true, json: async () => ({ items: [], total: 0 }) } as Response;
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('closes the prompt picker on Escape without forwarding Escape to the terminal', async () => {
    renderWithClient(<ChatPage />);

    fireEvent.click(await screen.findByLabelText(/Open terminal for Main Agent \(online\)/i));
    await screen.findByRole('region', { name: /Inline terminal for Main Agent/i });

    fireEvent.click(await screen.findByRole('button', { name: /Open custom prompts/i }));
    expect(
      await screen.findByRole('dialog', { name: /Insert custom prompt/i }),
    ).toBeInTheDocument();

    const searchInput = screen.getByRole('textbox', { name: /Search prompts/i });
    await waitFor(() => expect(searchInput).toHaveFocus());
    appSocketEmitMock.mockClear();

    fireEvent.keyDown(searchInput, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: /Insert custom prompt/i }),
      ).not.toBeInTheDocument();
    });
    expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:focus', expect.anything());
    expect(appSocketEmitMock).not.toHaveBeenCalledWith(
      'terminal:input',
      expect.objectContaining({ data: '\x1b' }),
    );
  });
});

describe('ChatPage agent Overrides dialog', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    toastSpy.mockReset();
    openTerminalWindowMock.mockReset();
    closeWindowMock.mockReset();
    terminalWindowsMock.splice(0, terminalWindowsMock.length);
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  /** Standard fetch mock for the Overrides dialog tests. */
  function setupFetch(overrides?: {
    mainAgents?: Array<Record<string, unknown>>;
    mainPresence?: Record<string, unknown>;
    mainProviderConfigs?: Array<Record<string, unknown>>;
    mainProviderModels?: Record<string, Array<Record<string, unknown>>>;
    mainProviderEfforts?: Record<string, unknown>;
  }) {
    const {
      mainAgents = [
        {
          id: 'agent-1',
          name: 'Main Agent',
          projectId: 'project-1',
          profileId: 'p1',
          providerConfigId: 'config-1',
          providerConfig: {
            id: 'config-1',
            name: 'Config A',
            providerId: 'provider-1',
            providerName: 'claude',
            model: null,
            effort: null,
          },
        },
      ],
      mainPresence = { 'agent-1': { online: true, sessionId: 'session-main-1' } },
      mainProviderConfigs = [
        { id: 'config-1', name: 'Config A', providerId: 'provider-1', model: null, effort: null },
        { id: 'config-2', name: 'Config B', providerId: 'provider-1', model: null, effort: null },
      ],
      mainProviderModels = { 'provider-1': [] },
      mainProviderEfforts = {
        'provider-1': { efforts: [], supportsEffort: true, requiresModelForEffort: false },
      },
    } = overrides ?? {};

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/runtime') {
        return { ok: true, json: async () => ({ mode: 'main', version: '1.0.0' }) } as Response;
      }
      if (url.startsWith('/api/agents?projectId=')) {
        return { ok: true, json: async () => ({ items: mainAgents }) } as Response;
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
      if (url.startsWith('/api/profiles/') && url.endsWith('/provider-configs')) {
        return { ok: true, json: async () => mainProviderConfigs } as Response;
      }
      if (url.startsWith('/api/providers/') && url.endsWith('/models')) {
        const match = url.match(/^\/api\/providers\/([^/]+)\/models$/);
        const providerId = match?.[1] ? decodeURIComponent(match[1]) : '';
        return {
          ok: true,
          json: async () => (providerId ? (mainProviderModels[providerId] ?? []) : []),
        } as Response;
      }
      if (url.startsWith('/api/providers/') && url.endsWith('/efforts')) {
        const match = url.match(/^\/api\/providers\/([^/]+)\/efforts$/);
        const providerId = match?.[1] ? decodeURIComponent(match[1]) : '';
        return {
          ok: true,
          json: async () =>
            (mainProviderEfforts as Record<string, unknown>)[providerId] ?? {
              efforts: [],
              supportsEffort: false,
              requiresModelForEffort: false,
            },
        } as Response;
      }
      // PUT for agent config update
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

  it('renders the short model override label, model·effort label, and config-name fallback', async () => {
    setupFetch({
      mainAgents: [
        {
          id: 'agent-model-only',
          name: 'Model Only Agent',
          projectId: 'project-1',
          profileId: 'p1',
          providerConfigId: 'config-1',
          providerConfig: {
            id: 'config-1',
            name: 'Config A',
            providerId: 'provider-1',
            providerName: 'claude',
            model: null,
            effort: null,
          },
          modelOverride: 'zai-coding-plan/glm-5',
          effortOverride: null,
        },
        {
          id: 'agent-model-effort',
          name: 'Model Effort Agent',
          projectId: 'project-1',
          profileId: 'p1',
          providerConfigId: 'config-1',
          providerConfig: {
            id: 'config-1',
            name: 'Config A',
            providerId: 'provider-1',
            providerName: 'claude',
            model: null,
            effort: null,
          },
          modelOverride: 'anthropic/opus',
          effortOverride: 'high',
        },
        {
          id: 'agent-default',
          name: 'Default Agent',
          projectId: 'project-1',
          profileId: 'p1',
          providerConfigId: 'config-1',
          providerConfig: {
            id: 'config-1',
            name: 'Config A',
            providerId: 'provider-1',
            providerName: 'claude',
            model: null,
            effort: null,
          },
          modelOverride: null,
          effortOverride: null,
        },
      ],
      mainPresence: {
        'agent-model-only': { online: true, sessionId: 's1' },
        'agent-model-effort': { online: true, sessionId: 's2' },
        'agent-default': { online: true, sessionId: 's3' },
      },
    });
    renderWithClient(<ChatPage />);

    const modelOnly = await screen.findByLabelText(
      /Open terminal for Model Only Agent \(online\)/i,
    );
    expect(within(modelOnly).getByText('glm-5')).toBeInTheDocument();

    const modelEffort = await screen.findByLabelText(
      /Open terminal for Model Effort Agent \(online\)/i,
    );
    const modelEffortLabel = within(modelEffort).getByText('opus · high');
    expect(modelEffortLabel).toBeInTheDocument();
    expect(modelEffortLabel).toHaveAttribute('title', 'model: anthropic/opus · effort: high');

    const defaultAgent = await screen.findByLabelText(
      /Open terminal for Default Agent \(online\)/i,
    );
    expect(within(defaultAgent).getByText('Config A')).toBeInTheDocument();
  });

  it('opens the Overrides dialog from a main agent and lazily loads its catalogs', async () => {
    setupFetch();
    renderWithClient(<ChatPage />);

    const agentButton = await screen.findByLabelText(/Open terminal for Main Agent \(online\)/i);
    fireEvent.contextMenu(agentButton);

    fireEvent.click(await screen.findByText('Overrides…'));

    expect(await screen.findByText('Overrides — Main Agent')).toBeInTheDocument();

    await waitFor(() => {
      const urls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
      expect(urls).toContain('/api/profiles/p1/provider-configs');
      expect(urls).toContain('/api/providers/provider-1/efforts');
    });
  });

  it('does not render the Overrides item for an agent without a profile', async () => {
    setupFetch({
      mainAgents: [
        {
          id: 'agent-no-profile',
          name: 'No Profile Agent',
          projectId: 'project-1',
          profileId: null,
        },
      ],
      mainPresence: { 'agent-no-profile': { online: true, sessionId: 'session-np' } },
    });
    renderWithClient(<ChatPage />);

    const agentButton = await screen.findByLabelText(
      /Open terminal for No Profile Agent \(online\)/i,
    );
    fireEvent.contextMenu(agentButton);

    await waitFor(() => {
      expect(screen.getByText(/Terminate session/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Overrides…')).not.toBeInTheDocument();
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
      expect(screen.getByLabelText(/Open terminal for Alpha \(offline\)/i)).toBeInTheDocument();
    });

    // Start button should be enabled when there are offline agents
    const startButton = screen.getByRole('button', { name: /^start/i });
    expect(startButton).not.toBeDisabled();

    {
      await waitFor(() => {
        expect(screen.getByLabelText(/Open terminal for Alpha \(offline\)/i)).toBeInTheDocument();
      });
      const stopButton = screen.getByRole('button', { name: /^stop/i });
      expect(stopButton).toBeDisabled();
    }
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
      expect(screen.getByLabelText(/Open terminal for Alpha \(online\)/i)).toBeInTheDocument();
    });

    // Start button should be disabled when no offline agents
    const startButton = screen.getByRole('button', { name: /^start/i });
    expect(startButton).toBeDisabled();
  });
});

describe('ChatPage context bar integration', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    toastSpy.mockReset();
    openTerminalWindowMock.mockReset();
    closeWindowMock.mockReset();
    terminalWindowsMock.splice(0, terminalWindowsMock.length);
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('renders context bar for online agent with active session and context data', async () => {
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
            'agent-2': { online: true, sessionId: 'session-2' },
          }),
        } as Response;
      }
      // Summary endpoint — must be before generic /api/sessions catch-all
      if (url.includes('/transcript/summary')) {
        return {
          ok: true,
          json: async () => ({
            sessionId: 'session-2',
            providerName: 'claude',
            metrics: {
              inputTokens: 30000,
              outputTokens: 10000,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: 40000,
              totalContextConsumption: 0,
              compactionCount: 0,
              phaseBreakdowns: [],
              visibleContextTokens: 0,
              totalContextTokens: 100000,
              contextWindowTokens: 200000,
              costUsd: 0,
            },
            messageCount: 5,
            isOngoing: true,
          }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
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

    renderWithClient(<ChatPage />);

    // Wait for agents to render
    await screen.findByLabelText(/Open terminal for Beta \(online\)/i);

    // Context bar should appear for the online agent with a session
    await waitFor(() => {
      const progressbars = screen.getAllByRole('progressbar');
      expect(progressbars.length).toBeGreaterThanOrEqual(1);
    });

    const progressbar = screen.getAllByRole('progressbar')[0];
    expect(progressbar).toHaveAttribute('aria-valuenow', '50');
    expect(progressbar).toHaveAttribute('aria-label', 'Context window usage');

    {
      const agentButton = await screen.findByLabelText(/Open terminal for Beta \(online\)/i);
      await waitFor(() => {
        expect(screen.getAllByRole('progressbar').length).toBeGreaterThanOrEqual(1);
      });
      fireEvent.contextMenu(agentButton);
      await waitFor(() => {
        expect(screen.getByText(/Terminate session/i)).toBeInTheDocument();
      });
    }
  });

  it('does not render context bar for offline agents', async () => {
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
        return {
          ok: true,
          json: async () => ({
            'agent-1': { online: false, sessionId: null },
          }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;

    renderWithClient(<ChatPage />);

    await screen.findByLabelText(/Open terminal for Alpha \(offline\)/i);

    // No context bar for offline agents (no session → no metrics query)
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  });
});

describe('ChatPage context bar toggle', () => {
  const originalFetch = global.fetch;
  const originalIntersectionObserver = global.IntersectionObserver;
  const LS_KEY = 'devchain:chatSidebar:contextBarHidden';

  beforeEach(() => {
    toastSpy.mockReset();
    openTerminalWindowMock.mockReset();
    closeWindowMock.mockReset();
    terminalWindowsMock.splice(0, terminalWindowsMock.length);
    window.localStorage.removeItem(LS_KEY);
    window.localStorage.removeItem('devchain:chatSidebar:mainExpanded');
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    window.localStorage.removeItem(LS_KEY);
    window.localStorage.removeItem('devchain:chatSidebar:mainExpanded');
    global.IntersectionObserver = originalIntersectionObserver;
  });

  /** Fetch mock for an online agent with non-zero context metrics */
  function setupContextBarFetch(overrides?: {
    agents?: Array<Record<string, unknown>>;
    presence?: Record<string, unknown>;
    summaryMetrics?: Record<string, unknown>;
  }) {
    const {
      agents = [{ id: 'agent-1', name: 'Alpha', projectId: 'project-1', profileId: 'p1' }],
      presence = { 'agent-1': { online: true, sessionId: 'session-1' } },
      summaryMetrics = {
        inputTokens: 30000,
        outputTokens: 10000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 40000,
        totalContextConsumption: 0,
        compactionCount: 0,
        phaseBreakdowns: [],
        visibleContextTokens: 0,
        totalContextTokens: 100000,
        contextWindowTokens: 200000,
        costUsd: 0,
      },
    } = overrides ?? {};

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/agents?projectId=')) {
        return { ok: true, json: async () => ({ items: agents }) } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        return { ok: true, json: async () => presence } as Response;
      }
      if (url.includes('/transcript/summary')) {
        return {
          ok: true,
          json: async () => ({
            sessionId: 'session-1',
            providerName: 'claude',
            metrics: summaryMetrics,
            messageCount: 5,
            isOngoing: true,
          }),
        } as Response;
      }
      if (url.startsWith('/api/threads?projectId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.includes('/api/profiles/') && url.endsWith('/provider-configs')) {
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
  }

  it('collapsed main section creates no summary request for its off-screen bars', async () => {
    window.localStorage.setItem('devchain:chatSidebar:mainExpanded', 'false');
    setupContextBarFetch();
    renderWithClient(<ChatPage />);

    await screen.findByRole('button', { name: /MAIN/i });
    await waitFor(() => {
      const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
      expect(urls.some((url: string) => url.startsWith('/api/sessions/agents/presence'))).toBe(
        true,
      );
    });

    const urls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(urls.some((url: string) => url.includes('/transcript/summary'))).toBe(false);
  });

  it('does not request metrics until a rendered context row intersects the viewport', async () => {
    let callback: IntersectionObserverCallback | undefined;
    class IntersectionObserverMock implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
      constructor(nextCallback: IntersectionObserverCallback) {
        callback = nextCallback;
      }
      disconnect = jest.fn();
      observe = jest.fn();
      takeRecords = jest.fn(() => []);
      unobserve = jest.fn();
    }
    global.IntersectionObserver = IntersectionObserverMock;
    setupContextBarFetch();
    renderWithClient(<ChatPage />);

    const agentButton = await screen.findByLabelText(/Open terminal for Alpha \(online\)/i);
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([url]) =>
        String(url).includes('/transcript/summary'),
      ),
    ).toBe(false);
    if (!callback) throw new Error('Context row observer was not registered');

    act(() => {
      callback!(
        [
          {
            target: agentButton,
            isIntersecting: true,
            intersectionRatio: 1,
            intersectionRect: new DOMRect(0, 0, 10, 10),
            boundingClientRect: new DOMRect(0, 0, 10, 10),
            rootBounds: null,
            time: 0,
          },
        ],
        {} as IntersectionObserver,
      );
    });

    await waitFor(() => {
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([url]) =>
          String(url).includes('/transcript/summary'),
        ),
      ).toBe(true);
    });
  });

  it('hides, persists across remount, and restores context tracking', async () => {
    setupContextBarFetch();
    const { unmount } = renderWithClient(<ChatPage />);

    const agentButton = await screen.findByLabelText(/Open terminal for Alpha \(online\)/i);
    await waitFor(() => {
      expect(screen.getAllByRole('progressbar').length).toBeGreaterThanOrEqual(1);
    });

    // Toggle off
    fireEvent.contextMenu(agentButton);
    const checkbox = await screen.findByRole('menuitemcheckbox', { name: /Context tracking/i });
    fireEvent.click(checkbox);

    await waitFor(() => expect(screen.queryAllByRole('progressbar')).toHaveLength(0));

    // Verify localStorage contains the agent key
    await waitFor(() => {
      const stored = window.localStorage.getItem(LS_KEY);
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!) as string[];
      expect(parsed).toContain('agent-1');
    });

    // Unmount and remount — bar should stay hidden
    unmount();
    (global.fetch as jest.Mock).mockClear();
    renderWithClient(<ChatPage />);

    const remountedAgentButton = await screen.findByLabelText(
      /Open terminal for Alpha \(online\)/i,
    );
    const remountUrls = (global.fetch as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(remountUrls.some((url: string) => url.includes('/transcript/summary'))).toBe(false);

    // Bar still hidden after remount
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
    fireEvent.contextMenu(remountedAgentButton);
    const restoredCheckbox = await screen.findByRole('menuitemcheckbox', {
      name: /Context tracking/i,
    });
    expect(restoredCheckbox).toHaveAttribute('data-state', 'unchecked');
    fireEvent.click(restoredCheckbox);

    // Enabling tracking creates the summary query and renders the bar.
    await waitFor(() => {
      expect(screen.getAllByRole('progressbar').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('menu item always enabled: checkbox not disabled even without active session', async () => {
    setupContextBarFetch({
      presence: { 'agent-1': { online: false, sessionId: null } },
    });
    renderWithClient(<ChatPage />);

    const agentButton = await screen.findByLabelText(/Open terminal for Alpha \(offline\)/i);
    fireEvent.contextMenu(agentButton);

    const checkbox = await screen.findByRole('menuitemcheckbox', { name: /Context tracking/i });
    expect(checkbox).not.toHaveAttribute('data-disabled');
    expect(checkbox).toHaveAttribute('data-state', 'checked');
  });
});

describe('ChatPage unlogged agent time', () => {
  const originalFetch = global.fetch;
  const EPIC_ID = '44444444-4444-4444-8444-444444444444';
  const bufferItem = {
    agentId: 'agent-2',
    snapshotToken: 'e'.repeat(64),
    minutes: 10,
    durationMs: 600_000,
    segmentCount: 2,
    oldestActivityAt: '2026-09-01T00:00:00.000Z',
    newestActivityAt: '2026-09-01T00:10:00.000Z',
  };
  let bufferItems: unknown[];
  let assignStatus: number;
  let resetStatus: number;
  let presencePayload: Record<string, unknown>;
  let activeSessionsPayload: unknown[];

  beforeEach(() => {
    toastSpy.mockReset();
    mockInlineTerminalHandle.focus.mockClear();
    openTerminalWindowMock.mockReset();
    closeWindowMock.mockReset();
    terminalWindowsMock.splice(0, terminalWindowsMock.length);
    bufferItems = [bufferItem];
    assignStatus = 200;
    resetStatus = 200;
    presencePayload = {
      'agent-1': { online: false, sessionId: null },
      'agent-2': { online: true, sessionId: 'session-2' },
    };
    activeSessionsPayload = [
      {
        id: 'session-2',
        agentId: 'agent-2',
        status: 'running',
        startedAt: '2026-09-01T00:00:00.000Z',
        lastActivityAt: '2026-09-01T00:05:00.000Z',
        transcriptPath: null,
      },
    ];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/agent-time-buffers?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ capturedAt: '2026-09-01T00:10:00.000Z', items: bufferItems }),
        } as Response;
      }
      if (url === `/api/agent-time-buffers/agent-2/assign`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          projectId: 'project-1',
          targetEpicId: EPIC_ID,
          capturedAt: '2026-09-01T00:10:00.000Z',
          snapshotToken: bufferItem.snapshotToken,
        });
        return {
          ok: assignStatus < 300,
          status: assignStatus,
          json: async () =>
            assignStatus < 300
              ? { workspaceId: '0defa017-0000-4000-8000-000000000001' }
              : { code: 'conflict' },
        } as Response;
      }
      if (url === `/api/agent-time-buffers/agent-2/reset`) {
        expect(JSON.parse(String(init?.body))).toEqual({
          projectId: 'project-1',
          capturedAt: '2026-09-01T00:10:00.000Z',
          snapshotToken: bufferItem.snapshotToken,
        });
        return {
          ok: resetStatus < 300,
          status: resetStatus,
          json: async () =>
            resetStatus < 300
              ? { workspaceId: '0defa017-0000-4000-8000-000000000001' }
              : { code: resetStatus === 409 ? 'conflict' : 'internal_error' },
        } as Response;
      }
      if (url.startsWith('/api/epics?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: EPIC_ID,
                title: 'Ship the API',
                statusId: 'status-1',
                updatedAt: '2026-09-01T00:00:00.000Z',
              },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/statuses?')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'status-1', label: 'In Progress', color: '#3b82f6' }],
          }),
        } as Response;
      }
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
          json: async () => presencePayload,
        } as Response;
      }
      // Summary endpoint — must come before the generic /api/sessions branches.
      if (url.includes('/transcript/summary')) {
        return {
          ok: true,
          json: async () => ({
            sessionId: 'session-2',
            providerName: 'claude',
            metrics: {
              inputTokens: 30_000,
              outputTokens: 10_000,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: 40_000,
              totalContextConsumption: 0,
              compactionCount: 0,
              phaseBreakdowns: [],
              visibleContextTokens: 0,
              totalContextTokens: 100_000,
              contextWindowTokens: 200_000,
              costUsd: 0,
              messageCount: 5,
            },
            messageCount: 5,
            isOngoing: true,
          }),
        } as Response;
      }
      if (url.startsWith('/api/sessions?')) {
        return {
          ok: true,
          json: async () => activeSessionsPayload,
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
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  function bufferReads(): string[] {
    return (global.fetch as jest.Mock).mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith('/api/agent-time-buffers?'));
  }

  async function openDialogFromHeader() {
    const action = await screen.findByRole('button', {
      name: /Log unlogged time to an Epic \(10m\)/i,
    });
    fireEvent.click(action);
    await waitFor(() => {
      expect(screen.getByText('Log time to an Epic.')).toBeInTheDocument();
    });
    return action;
  }

  async function confirmAssignment() {
    fireEvent.click(await screen.findByRole('option', { name: /Ship the API/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Log 10m.' }));
    await waitFor(() => {
      expect(screen.queryByText('Log time to an Epic.')).not.toBeInTheDocument();
    });
  }

  it('drives every row marker and the header action from one main-runtime read', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-2']);

    await screen.findByRole('button', { name: /Log unlogged time to an Epic \(10m\)/i });
    await screen.findByRole('listitem', {
      name: /Open terminal for Beta \(online\), 10m not logged to an Epic\./i,
    });

    const reads = bufferReads();
    expect(reads).toHaveLength(1);
    expect(reads[0]).toBe('/api/agent-time-buffers?projectId=project-1');
    // Alpha carries no buffered minutes and stays unmarked.
    const alphaRow = await screen.findByRole('listitem', {
      name: 'Open terminal for Alpha (offline)',
    });
    expect(alphaRow.querySelector('span.pointer-events-none')).toBeNull();
  });

  it('completes the frozen assignment, announces, invalidates, and refocuses the terminal', async () => {
    const { queryClient } = renderWithClient(<ChatPage />, ['/chat?agent=agent-2']);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    await openDialogFromHeader();
    expect(screen.getByText('10m from Beta.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'DevChain assigns time automatically when it can. Use this dialog for time that remains unassigned.',
      ),
    ).toBeInTheDocument();

    // Later polls never replace the open confirmation; the read stays frozen.
    bufferItems = [{ ...bufferItem, minutes: 9 }];
    expect(screen.getByText('10m from Beta.')).toBeInTheDocument();
    // The post-success invalidation re-reads the now-empty buffer.
    bufferItems = [];
    await confirmAssignment();

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Time logged',
        description: 'Logged 10m to Ship the API.',
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['agent-time-buffers'],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['epic-time-detail'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['epic-time-batch'] });

    // Terminal tab + inline terminal: the terminal itself receives focus
    // (resolved after the dialog unmount's focus restoration).
    await waitFor(() => {
      expect(mockInlineTerminalHandle.focus).toHaveBeenCalledTimes(1);
    });

    // The cleared buffer removes both the action and the marker after refresh.
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Log unlogged time to an Epic/i }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('listitem', {
          name: /Open terminal for Beta \(online\), 10m not logged/i,
        }),
      ).not.toBeInTheDocument();
    });
  });

  it.each(['Session tab', 'floating terminal'])(
    'focuses the stable header root with %s',
    async (mode) => {
      if (mode === 'floating terminal') terminalWindowsMock.push({ id: 'session-2' });
      renderWithClient(<ChatPage />, ['/chat?agent=agent-2']);
      if (mode === 'Session tab')
        fireEvent.click(await screen.findByRole('tab', { name: 'Session' }));
      await openDialogFromHeader();
      await confirmAssignment();
      expect(mockInlineTerminalHandle.focus).not.toHaveBeenCalled();
      const headerRoot = document.querySelector('div[tabindex="-1"].border-b');
      expect(headerRoot).not.toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(headerRoot));
    },
  );

  it('shows no marker or action once a poll fails after earlier success', async () => {
    const { queryClient } = renderWithClient(<ChatPage />, ['/chat?agent=agent-2']);

    await screen.findByRole('button', { name: /Log unlogged time to an Epic \(10m\)/i });
    await screen.findByRole('listitem', {
      name: /Open terminal for Beta \(online\), 10m not logged to an Epic\./i,
    });

    // The next read fails; retained cache data must not keep the UI alive.
    const fetchMockRef = global.fetch as jest.Mock;
    const originalImpl = fetchMockRef.getMockImplementation();
    fetchMockRef.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/agent-time-buffers?')) {
        return { ok: false, status: 503, json: async () => ({}) } as Response;
      }
      return originalImpl?.(input, init);
    });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['agent-time-buffers'] });
    });

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Log unlogged time to an Epic/i }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole('listitem', {
        name: /Open terminal for Beta \(online\), 10m not logged/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('completes a reset without an Epic selection, without an announcement, and refocuses the terminal', async () => {
    const { queryClient } = renderWithClient(<ChatPage />, ['/chat?agent=agent-2']);
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    await openDialogFromHeader();
    // The post-success invalidation re-reads the now-empty buffer.
    bufferItems = [];
    fireEvent.click(screen.getByRole('button', { name: 'Reset time' }));

    await waitFor(() => {
      expect(screen.queryByText('Log time to an Epic.')).not.toBeInTheDocument();
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['agent-time-buffers'],
    });
    // Reset touches no Epic-bound totals, so the detail and batch families
    // are not invalidated and no time-logged toast fires.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['epic-time-detail'] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['epic-time-batch'] });
    expect(toastSpy).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(mockInlineTerminalHandle.focus).toHaveBeenCalledTimes(1);
    });

    // The cleared buffer removes both the action and the marker after refresh.
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Log unlogged time to an Epic/i }),
      ).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('listitem', {
          name: /Open terminal for Beta \(online\), 10m not logged/i,
        }),
      ).not.toBeInTheDocument();
    });
  });

  it('removes the time marker but keeps the offline row once a termination-cleared buffer arrives', async () => {
    // Genuinely offline: the termination stopped agent-2's session, so no
    // running session and no online presence exist while the buffered
    // balance is still visible on the offline row.
    presencePayload = {
      'agent-1': { online: false, sessionId: null },
      'agent-2': { online: false, sessionId: null },
    };
    activeSessionsPayload = [];
    const { queryClient } = renderWithClient(<ChatPage />, ['/chat?agent=agent-2']);

    await screen.findByRole('listitem', {
      name: /Open terminal for Beta \(offline\), 10m not logged to an Epic\./,
    });

    // Session termination resets the balance server-side; the next buffer
    // read (poll or scope invalidation) publishes the empty snapshot.
    bufferItems = [];
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['agent-time-buffers'] });
    });

    // The offline row itself survives with its layout; only the time
    // marker is gone.
    const offlineRow = await screen.findByRole('listitem', {
      name: 'Open terminal for Beta (offline)',
    });
    expect(offlineRow).toBeInTheDocument();
    expect(
      screen.queryByRole('listitem', {
        name: /Open terminal for Beta \(offline\), \d+m not logged/i,
      }),
    ).not.toBeInTheDocument();
  });
});

describe('ChatPage Escape handler emit ordering (RTL)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    appSocketEmitMock.mockClear();
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
      renderWithClient(<ChatPage />);
    });

    appSocketEmitMock.mockClear();
    fireEvent.keyDown(document, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:focus', expect.anything());
    expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:input', expect.anything());
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });

    const focusCall = appSocketEmitMock.mock.calls.find(
      ([event]: [string]) => event === 'terminal:focus',
    );
    const inputCall = appSocketEmitMock.mock.calls.find(
      ([event]: [string]) => event === 'terminal:input',
    );

    expect(focusCall).toBeDefined();
    expect(inputCall).toBeDefined();
    expect(focusCall![1]).toEqual({ sessionId: 'focused-terminal-session' });
    expect(inputCall![1]).toEqual({ sessionId: 'focused-terminal-session', data: '\x1b' });

    const focusIndex = appSocketEmitMock.mock.calls.indexOf(focusCall!);
    const inputIndex = appSocketEmitMock.mock.calls.indexOf(inputCall!);
    expect(focusIndex).toBeLessThan(inputIndex);
  });

  it('does not emit when no focused window', async () => {
    focusedWindowIdMock.value = null;

    await act(async () => {
      renderWithClient(<ChatPage />);
    });

    appSocketEmitMock.mockClear();

    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });

    const focusCall = appSocketEmitMock.mock.calls.find(
      ([event]: [string]) => event === 'terminal:focus',
    );
    const inputCall = appSocketEmitMock.mock.calls.find(
      ([event]: [string]) => event === 'terminal:input',
    );

    expect(focusCall).toBeUndefined();
    expect(inputCall).toBeUndefined();
  });
});
