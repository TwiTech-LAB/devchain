import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TerminalWindowsProvider } from '@/ui/terminal-windows';
import type { SavePointAvailability, SessionTreeNode } from '@/ui/lib/sessions';
import { chatQueryKeys } from '@/ui/hooks/useChatQueries';
import { teamsQueryKeys } from '@/ui/lib/teams';
import { TEAM_FOLD_OVERRIDES_KEY } from '@/ui/components/chat/team-fold';
import { createAppQueryClient } from '@/ui/lib/query-client';
import { agentQueryKeys } from '@/ui/lib/agents';

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
        data-session-id={sessionId}
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
  useLowerTerminalWindows: jest.fn(),
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

function renderWithClient(
  ui: React.ReactNode,
  initialEntries: string[] = ['/chat'],
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
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

describe('ChatPage agent list without teams', () => {
  const originalFetch = global.fetch;
  let requestedUrls: string[] = [];

  beforeEach(() => {
    requestedUrls = [];
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
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('shows the flat agent list with no grouping controls', async () => {
    renderWithClient(<ChatPage />);

    const list = await screen.findByRole('list', { name: 'Agents' });
    expect(within(list).getByLabelText(/Open terminal for Alpha \(offline\)/i)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^MAIN$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/No teams configured/i)).not.toBeInTheDocument();
  });
});

describe('ChatPage team fold readiness', () => {
  const originalFetch = global.fetch;
  const OVERRIDES_KEY = TEAM_FOLD_OVERRIDES_KEY;
  const override = { 'team-1': { collapsed: true, whenActive: true } };
  const presenceKey = chatQueryKeys.agentPresence('project-1');
  const detailKey = teamsQueryKeys.detail('team-1');
  const online = (...ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { online: true, sessionId: `session-${id}` }]));
  const storedOverrides = () => JSON.parse(window.localStorage.getItem(OVERRIDES_KEY) ?? '{}');
  const memberToggle = () => screen.getByLabelText(/Toggle Alpha Team members/);

  /**
   * A server whose team membership and presence the test changes. Presence is
   * read when the request starts, so a held request answers with what the
   * server knew then.
   */
  function mockTeamFoldServer() {
    const server = {
      agentIds: ['agent-lead', 'agent-m1', 'agent-m2', 'agent-m3'],
      disabledIds: [] as string[],
      teamMemberIds: ['agent-lead', 'agent-m1'],
      presence: online('agent-m1') as Record<string, unknown>,
      presenceGate: Promise.resolve(),
      rosterGate: Promise.resolve(),
      rosterRequests: 0,
      failRoster: false,
      teamDetailGate: Promise.resolve(),
      failPresence: false,
      failTeamDetail: false,
    };
    const team = {
      id: 'team-1',
      projectId: 'project-1',
      name: 'Alpha Team',
      description: null,
      teamLeadAgentId: 'agent-lead',
      teamLeadAgentName: 'agent-lead',
      maxMembers: 5,
      maxConcurrentTasks: 3,
      allowTeamLeadCreateAgents: false,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const failure = { ok: false, status: 500, json: async () => ({ message: 'down' }) };

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/agents?projectId=')) {
        server.rosterRequests += 1;
        const agentIds = server.agentIds;
        const disabledIds = server.disabledIds;
        const fail = server.failRoster;
        await server.rosterGate;
        if (fail) return failure as Response;
        const agents = agentIds.map((id) => ({
          id,
          name: id,
          projectId: 'project-1',
          profileId: 'p1',
          disabled: disabledIds.includes(id),
        }));
        return { ok: true, json: async () => ({ items: agents }) } as Response;
      }
      if (url.startsWith('/api/sessions/agents/presence')) {
        const snapshot = server.presence;
        const fail = server.failPresence;
        await server.presenceGate;
        if (fail) return failure as Response;
        return { ok: true, json: async () => snapshot } as Response;
      }
      if (url.startsWith('/api/teams?')) {
        return {
          ok: true,
          json: async () => ({
            items: [{ ...team, memberCount: server.teamMemberIds.length }],
            total: 1,
            limit: 50,
            offset: 0,
          }),
        } as Response;
      }
      if (url === '/api/teams/team-1') {
        await server.teamDetailGate;
        if (server.failTeamDetail) return failure as Response;
        const memberIds = server.teamMemberIds;
        return {
          ok: true,
          json: async () => ({
            ...team,
            members: memberIds.map((agentId) => ({
              agentId,
              agentName: agentId,
              isLead: agentId === 'agent-lead',
              createdAt: '2024-01-01T00:00:00.000Z',
            })),
            profileIds: [],
            profileConfigSelections: [],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ items: [] }) } as Response;
    }) as unknown as typeof fetch;
    return server;
  }

  /** Renders the page with one saved fold of the team, whose member agent-m1 is online. */
  async function renderFoldedTeam(queryClient?: QueryClient) {
    window.localStorage.setItem(OVERRIDES_KEY, JSON.stringify(override));
    const server = mockTeamFoldServer();
    const utils = renderWithClient(<ChatPage />, ['/chat'], queryClient);
    expect(await screen.findByLabelText(/Toggle Alpha Team members/)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await screen.findByRole('button', { name: /Stop \(1\)/ });
    return { ...utils, server };
  }

  /** Runs `start` and waits until the query at `key` has a new response or an error. */
  async function untilAnswered(
    queryClient: QueryClient,
    key: readonly unknown[],
    start: () => void,
  ) {
    const before = queryClient.getQueryState(key);
    act(() => start());
    await waitFor(() => {
      const state = queryClient.getQueryState(key);
      expect(state?.fetchStatus).toBe('idle');
      expect(
        (state?.dataUpdateCount ?? 0) + (state?.errorUpdateCount ?? 0) >
          (before?.dataUpdateCount ?? 0) + (before?.errorUpdateCount ?? 0),
      ).toBe(true);
    });
    await act(async () => {});
  }

  function held() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { gate, release };
  }

  const refetch = (queryClient: QueryClient, key: readonly unknown[]) => () =>
    void queryClient.invalidateQueries({ queryKey: key });

  function expectFoldKept() {
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(storedOverrides()).toEqual(override);
  }

  afterEach(() => {
    window.localStorage.removeItem(OVERRIDES_KEY);
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('keeps a saved fold while presence refetches after a team change', async () => {
    const { queryClient, server } = await renderFoldedTeam();

    // The online member leaves the team; one who just started joins with an
    // offline one. The presence map on screen does not know the new member yet.
    let releasePresence!: () => void;
    server.presenceGate = new Promise((resolve) => (releasePresence = resolve));
    server.presence = online('agent-m1', 'agent-m2');
    server.teamMemberIds = ['agent-lead', 'agent-m2', 'agent-m3'];
    act(() => {
      void queryClient.invalidateQueries({ queryKey: presenceKey });
      void queryClient.invalidateQueries({ queryKey: detailKey });
    });

    // The sidebar has rendered the new team while presence is still pending.
    await screen.findByRole('button', { name: 'agent-m3, offline' });
    expect(queryClient.getQueryState(presenceKey)?.fetchStatus).toBe('fetching');
    expect(storedOverrides()).toEqual(override);

    // The UI now shows the confirmed presence: two sessions, the new member active.
    act(() => releasePresence());
    await screen.findByRole('button', { name: /Stop \(2\)/ });
    expectFoldKept();
  });

  describe('on tab refocus', () => {
    let visibility: DocumentVisibilityState = 'visible';

    beforeEach(() => {
      visibility = 'visible';
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
      });
    });

    afterEach(() => {
      delete (document as { visibilityState?: unknown }).visibilityState;
    });

    const setVisibility = (next: DocumentVisibilityState) => () => {
      visibility = next;
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    };

    it('clears the selection of an agent that another tab disabled', async () => {
      const server = mockTeamFoldServer();
      server.teamMemberIds = ['agent-lead', 'agent-m1', 'agent-m2'];
      server.presence = online('agent-m2');
      const { queryClient } = renderWithClient(
        <ChatPage />,
        ['/chat?agent=agent-m1'],
        createAppQueryClient(),
      );
      const row = await screen.findByLabelText(/Open terminal for agent-m1 \(offline\)/);
      await waitFor(() => expect(row).toHaveAttribute('aria-current', 'true'));

      // Another tab disables the offline member while this tab is hidden.
      act(setVisibility('hidden'));
      server.disabledIds = ['agent-m1'];
      await untilAnswered(
        queryClient,
        agentQueryKeys.withGuests('project-1'),
        setVisibility('visible'),
      );

      expect(await screen.findByLabelText('agent-m1 (disabled)')).not.toHaveAttribute(
        'aria-current',
      );
      expect(screen.queryByLabelText(/Open terminal for agent-m1/)).not.toBeInTheDocument();
    });

    it('keeps a saved fold when the team refetches before presence', async () => {
      const { queryClient, server } = await renderFoldedTeam(createAppQueryClient());

      // While the tab is hidden, agent-m2 starts and replaces agent-m1, so the
      // team has an online member all the time.
      act(setVisibility('hidden'));
      server.teamMemberIds = ['agent-lead', 'agent-m2'];
      server.presence = online('agent-m2');

      // Focus refetches the team and the roster; presence keeps its map from
      // before the swap.
      await untilAnswered(queryClient, detailKey, setVisibility('visible'));
      expect(queryClient.getQueryData(presenceKey)).toEqual(online('agent-m1'));
      expectFoldKept();

      const rosterRequests = server.rosterRequests;
      await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
      expectFoldKept();
      // A presence response that ends no fold does not refresh the roster.
      expect(server.rosterRequests).toBe(rosterRequests);

      // agent-m2 stops. Fresh presence shows the team inactive, but the roster
      // request started before the new team data arrived: the fold ends on a
      // new roster.
      const roster = held();
      server.rosterGate = roster.gate;
      server.presence = online();
      await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
      await waitFor(() => expect(server.rosterRequests).toBe(rosterRequests + 1));
      expectFoldKept();

      act(() => roster.release());
      await waitFor(() => expect(storedOverrides()).toEqual({}));
      expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('keeps a saved fold when presence fails after a team refetch', async () => {
    const { queryClient, server } = await renderFoldedTeam();
    server.teamMemberIds = ['agent-lead', 'agent-m2'];
    server.presence = online('agent-m2');

    await untilAnswered(queryClient, detailKey, refetch(queryClient, detailKey));
    server.failPresence = true;
    await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));

    expect(queryClient.getQueryState(presenceKey)?.status).toBe('error');
    expectFoldKept();
  });

  it('keeps a saved fold when a team refetch fails', async () => {
    const { queryClient, server } = await renderFoldedTeam();
    server.teamMemberIds = ['agent-lead', 'agent-m2'];
    server.presence = online('agent-m2');
    server.failTeamDetail = true;

    await untilAnswered(queryClient, detailKey, refetch(queryClient, detailKey));
    await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
    expect(queryClient.getQueryState(detailKey)?.status).toBe('error');
    expect(storedOverrides()).toEqual(override);

    // The team loads again: presence from before that response decides nothing.
    server.failTeamDetail = false;
    await untilAnswered(queryClient, detailKey, refetch(queryClient, detailKey));
    expectFoldKept();
    await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
    expectFoldKept();
  });

  it('keeps rows and a saved fold when the roster refresh fails, and retries it on the next presence', async () => {
    const { queryClient, server } = await renderFoldedTeam();
    server.teamMemberIds = ['agent-lead', 'agent-m2'];
    await untilAnswered(queryClient, detailKey, refetch(queryClient, detailKey));

    // agent-m2 stops; the roster refresh that the expiry asks for fails.
    server.presence = online();
    server.failRoster = true;
    const rosterRequests = server.rosterRequests;
    await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
    const rosterKey = agentQueryKeys.withGuests('project-1');
    await waitFor(() => expect(queryClient.getQueryState(rosterKey)?.status).toBe('error'));
    await act(async () => {});
    expect(server.rosterRequests).toBe(rosterRequests + 1);
    expect(screen.getByLabelText(/Open terminal for agent-lead/i)).toBeInTheDocument();
    expectFoldKept();

    server.failRoster = false;
    await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
    await waitFor(() => expect(storedOverrides()).toEqual({}));
    expect(server.rosterRequests).toBe(rosterRequests + 2);
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a saved fold when a later roster refresh fails after an earlier one succeeded', async () => {
    const { queryClient, server } = await renderFoldedTeam();
    const rosterKey = agentQueryKeys.withGuests('project-1');
    await untilAnswered(queryClient, detailKey, refetch(queryClient, detailKey));
    await untilAnswered(queryClient, rosterKey, refetch(queryClient, rosterKey));

    // The next background roster refresh fails; then agent-m1 stops.
    server.failRoster = true;
    await untilAnswered(queryClient, rosterKey, refetch(queryClient, rosterKey));
    expect(queryClient.getQueryState(rosterKey)?.status).toBe('error');
    server.presence = online();
    const rosterRequests = server.rosterRequests;
    await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
    await waitFor(() => expect(server.rosterRequests).toBe(rosterRequests + 1));
    await waitFor(() => expect(queryClient.getQueryState(rosterKey)?.fetchStatus).toBe('idle'));
    await act(async () => {});
    expect(screen.getByLabelText(/Open terminal for agent-lead/i)).toBeInTheDocument();
    expectFoldKept();
    expect(server.rosterRequests).toBe(rosterRequests + 1);

    server.failRoster = false;
    await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
    await waitFor(() => expect(storedOverrides()).toEqual({}));
  });

  it('shows the roster load error while a team detail request is pending', async () => {
    const server = mockTeamFoldServer();
    server.failRoster = true;
    const teamDetail = held();
    server.teamDetailGate = teamDetail.gate;
    const { queryClient } = renderWithClient(<ChatPage />);

    expect(await screen.findByText('Failed to load agents. Please try again.')).toBeInTheDocument();
    expect(queryClient.getQueryState(detailKey)?.fetchStatus).toBe('fetching');
    act(() => teamDetail.release());
  });

  it('keeps a saved fold until the roster lists a new team member', async () => {
    const { queryClient, server } = await renderFoldedTeam();
    // agent-m4 is created, joins the team and starts; agent-m1 leaves.
    server.agentIds = [...server.agentIds, 'agent-m4'];
    server.teamMemberIds = ['agent-lead', 'agent-m4'];
    server.presence = online('agent-m4');
    const roster = held();
    server.rosterGate = roster.gate;
    const rosterRequests = server.rosterRequests;

    await untilAnswered(queryClient, detailKey, refetch(queryClient, detailKey));
    await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
    await waitFor(() => expect(server.rosterRequests).toBe(rosterRequests + 1));
    // Until the roster lists agent-m4, the lead shows alone, with no fold control.
    expect(screen.queryByLabelText(/Toggle Alpha Team members/)).not.toBeInTheDocument();
    expect(storedOverrides()).toEqual(override);

    act(() => roster.release());
    await screen.findByLabelText(/Toggle Alpha Team members/);
    await act(async () => {});
    expectFoldKept();
  });

  it('ends a fold only on presence requested after the last of two team refetches', async () => {
    const { queryClient, server } = await renderFoldedTeam();

    // A presence request starts before the swap and is answered after both
    // team refetches, with a map in which the new member is offline.
    let releasePresence!: () => void;
    server.presenceGate = new Promise((resolve) => (releasePresence = resolve));
    act(refetch(queryClient, presenceKey));
    server.presenceGate = Promise.resolve();
    server.teamMemberIds = ['agent-lead', 'agent-m2'];
    server.presence = online('agent-m2');

    await untilAnswered(queryClient, detailKey, refetch(queryClient, detailKey));
    await untilAnswered(queryClient, detailKey, refetch(queryClient, detailKey));
    await untilAnswered(queryClient, presenceKey, releasePresence);
    expect(queryClient.getQueryData(presenceKey)).toEqual(online('agent-m1'));
    expectFoldKept();

    await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
    expectFoldKept();

    // The rule still ends the fold once fresh presence shows the team inactive.
    server.presence = online();
    await untilAnswered(queryClient, presenceKey, refetch(queryClient, presenceKey));
    await waitFor(() => expect(storedOverrides()).toEqual({}));
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');
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
      if (url === '/api/agents/agent-2/restart') {
        return {
          ok: true,
          json: async () => ({ session: { id: 'session-new', agentId: 'agent-2' } }),
        } as Response;
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
    expect(
      await screen.findByText("No previous sessions for this agent's family yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Inline terminal for Alpha/i })).toBeNull();
  });

  it('renders the inline terminal surface for the selected online agent', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-2']);

    expect(
      await screen.findByRole('region', { name: /Inline terminal for Beta/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Launch Session' })).toBeNull();
  });

  // Render the page with the real lifecycle controls to verify the bar's action wiring.
  it('restarts the displayed agent through the existing lifecycle handler', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-2']);

    const actions = await screen.findByRole('group', { name: 'Session actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Restart' }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/agents/agent-2/restart',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ projectId: 'project-1' }),
        }),
      ),
    );
  });

  it('stops the displayed session only after the existing confirmation is accepted', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-2']);

    const actions = await screen.findByRole('group', { name: 'Session actions' });
    fireEvent.click(within(actions).getByRole('button', { name: 'Stop' }));

    const dialog = await screen.findByRole('dialog', { name: 'Terminate session?' });
    expect(global.fetch).not.toHaveBeenCalledWith(
      '/api/sessions/session-2',
      expect.objectContaining({ method: 'DELETE' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terminate' }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/sessions/session-2?expectedAgentId=agent-2',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
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
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    window.localStorage.removeItem(LS_KEY);
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

  it('lets the Sessions modal close on Escape before forwarding later Escape keys', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const agent = { id: 'agent-1', name: 'Alpha', projectId: 'project-1', profileId: 'p1' };
      const data = url.startsWith('/api/agents?')
        ? { items: [agent] }
        : url.startsWith('/api/sessions/agents/presence')
          ? { [agent.id]: { online: true, sessionId: 'inline-session' } }
          : { items: [] };
      return { ok: true, json: async () => data } as Response;
    });
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);

    fireEvent.click(await screen.findByRole('button', { name: /Switch session, current session/ }));
    const sessions = await screen.findByRole('dialog', { name: 'Sessions' });

    appSocketEmitMock.mockClear();
    fireEvent.keyDown(sessions, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(sessions).not.toBeInTheDocument());
    expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:input', expect.anything());

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    expect(appSocketEmitMock).toHaveBeenCalledWith('terminal:input', {
      sessionId: 'inline-session',
      data: '\x1b',
    });
  });

  // The launch screen of an offline agent can show beside a focused floating terminal.
  it('lets launch-screen session UI close on Escape before forwarding later Escape keys', async () => {
    const node = {
      name: 'Previous run',
      kind: 'session',
      status: 'stopped',
      parentSessionId: null,
      providerSessionId: 'provider-previous',
      providerNameAtLaunch: 'claude',
      startedAt: '2026-03-21T12:34:00Z',
      endedAt: null,
      lastActivityAt: null,
      sizeBytes: null,
      transcriptAvailable: true,
      beforeRollback: false,
    };
    const items = [
      { ...node, id: 'previous-session' },
      {
        ...node,
        id: 'save-1',
        name: 'Checkpoint',
        kind: 'save_point',
        parentSessionId: 'previous-session',
      },
    ];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const agent = { id: 'agent-1', name: 'Alpha', projectId: 'project-1', profileId: 'p1' };
      const data = url.startsWith('/api/agents?')
        ? { items: [agent] }
        : url.startsWith('/api/sessions/agents/agent-1/tree')
          ? { items, hasMore: false, nextCursor: null, total: 1, savePoints: { available: true } }
          : { items: [] };
      return { ok: true, json: async () => data } as Response;
    });
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const row = await screen.findByRole('row', { name: /Previous run/ });

    async function expectEscapeCloses(open: () => Promise<HTMLElement>) {
      const layer = await open();
      appSocketEmitMock.mockClear();
      fireEvent.keyDown(layer, { key: 'Escape', code: 'Escape' });
      await waitFor(() => expect(layer).not.toBeInTheDocument());
      expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:input', expect.anything());
    }
    async function openList() {
      fireEvent.click(within(row).getByRole('button', { name: '1 save point' }));
      return screen.findByRole('list', { name: 'Save points' });
    }

    await expectEscapeCloses(openList);
    await expectEscapeCloses(async () => {
      fireEvent.click(within(await openList()).getByRole('button', { name: 'Roll back' }));
      return screen.findByRole('dialog', { name: 'Roll back session?' });
    });
    await expectEscapeCloses(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Delete session record' }));
      return screen.findByRole('dialog', { name: 'Delete session record?' });
    });

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    expect(appSocketEmitMock).toHaveBeenCalledWith('terminal:input', {
      sessionId: 'focused-terminal-session',
      data: '\x1b',
    });
  });
});

// The page test keeps the real modal, lifecycle hooks and fetchers to check the UI-to-API flow.
describe('ChatPage Sessions modal', () => {
  const originalFetch = global.fetch;
  const projectId = 'project-1';
  const agentId = 'agent-1';
  const firstLiveId = 'live-session';
  const date = '2026-03-21T12:34:00Z';
  const defaultSaveLabel = `Save point · ${new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  const record = (id: string, overrides: Partial<SessionTreeNode> = {}): SessionTreeNode => ({
    id,
    name: id,
    kind: 'session',
    status: 'stopped',
    providerSessionId: `provider-${id}`,
    providerNameAtLaunch: 'claude',
    transcriptAvailable: true,
    sizeBytes: null,
    startedAt: date,
    endedAt: null,
    lastActivityAt: null,
    parentSessionId: null,
    beforeRollback: false,
    ...overrides,
  });
  const otherRoot = record('other-root', { name: 'Unrelated history' });
  const otherSave = record('unrelated-save', {
    kind: 'save_point',
    name: 'Hidden branch',
    parentSessionId: otherRoot.id,
  });
  const moreRoot = record('older-root', { name: 'Older third page' });
  let liveId: string;
  let history: SessionTreeNode[];
  let availability: SavePointAvailability;
  let activity: 'idle' | 'busy';
  let requests: Array<{ path: string; body: unknown }>;
  let cursors: Array<string | null>;
  let singlePage: boolean;

  beforeEach(() => {
    liveId = firstLiveId;
    availability = { available: true };
    activity = 'idle';
    requests = [];
    cursors = [];
    singlePage = false;
    history = [
      record('origin-session', { name: 'Original session' }),
      record('origin-save', {
        kind: 'save_point',
        name: 'Parent save',
        parentSessionId: 'origin-session',
      }),
      record(liveId, {
        name: 'Current session',
        status: 'running',
        parentSessionId: 'origin-save',
      }),
      record('save-1', { name: 'Ready checkpoint', kind: 'save_point', parentSessionId: liveId }),
    ];
    appSocketEmitMock.mockClear();

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.pathname;
      const activeSession = (node: SessionTreeNode) => ({
        ...node,
        agentId,
        epicId: null,
        tmuxSessionId: 'tmux-active',
        createdAt: date,
        updatedAt: date,
      });
      const makeResponse = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
      if (path === '/api/agents')
        return makeResponse({
          items: [{ id: agentId, name: 'Alpha', projectId, profileId: 'p1' }],
        });
      if (path === '/api/sessions/agents/presence')
        return makeResponse({
          [agentId]: {
            online: Boolean(liveId),
            sessionId: liveId || null,
            activityState: activity,
          },
        });
      if (path === '/api/sessions')
        return makeResponse(history.filter((node) => node.id === liveId).map(activeSession));
      if (path === '/api/sessions/pools') return makeResponse({ pools: [] });
      if (path.endsWith('/transcript/summary')) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ message: 'Transcript unavailable' }),
        } as Response;
      }
      if (path === `/api/sessions/agents/${agentId}/tree`) {
        const cursor = url.searchParams.get('cursor');
        cursors.push(cursor);
        if (singlePage) {
          return makeResponse({
            items: history,
            nextCursor: null,
            hasMore: false,
            total: history.length,
            savePoints: availability,
          });
        }
        const items =
          cursor === null ? [otherRoot, otherSave] : cursor === 'live-page' ? history : [moreRoot];
        const nextCursor =
          cursor === null ? 'live-page' : cursor === 'live-page' ? 'older-page' : null;
        return makeResponse({
          items,
          nextCursor,
          hasMore: nextCursor !== null,
          total: 3,
          savePoints: availability,
        });
      }
      if (init?.method === 'POST' && path === `/api/agents/${agentId}/restart`) {
        requests.push({ path, body: JSON.parse(String(init.body)) });
        history = history.map((node) =>
          node.id === liveId ? { ...node, status: 'stopped' } : node,
        );
        liveId = 'restarted-session';
        const next = record(liveId, { status: 'running', name: 'Restarted session' });
        history = [next, ...history];
        return makeResponse({ session: activeSession(next), terminateStatus: 'success' });
      }
      if (init?.method === 'POST' && path === `/api/sessions/${liveId}/save-points`) {
        requests.push({ path, body: JSON.parse(String(init.body)) });
        const saved = record('new-save', {
          name: null,
          kind: 'save_point',
          parentSessionId: liveId,
        });
        history = [...history, saved];
        return makeResponse(saved);
      }
      if (init?.method === 'PATCH' && path.startsWith('/api/sessions/')) {
        const id = path.split('/').at(-1);
        const body = JSON.parse(String(init.body)) as { name: string | null };
        requests.push({ path, body });
        history = history.map((node) => (node.id === id ? { ...node, name: body.name } : node));
        return makeResponse(history.find((node) => node.id === id));
      }
      if (init?.method === 'POST' && path.endsWith('/rollback')) {
        requests.push({ path, body: JSON.parse(String(init.body)) });
        const id = path.split('/').at(-2)!;
        history = history.map((node) =>
          node.id === id
            ? { ...node, status: 'running' }
            : node.id === liveId
              ? { ...node, status: 'stopped' }
              : node,
        );
        liveId = id;
        return makeResponse(activeSession(history.find((node) => node.id === id)!));
      }
      if (init?.method === 'POST' && (path.endsWith('/start') || path.endsWith('/restore'))) {
        requests.push({ path, body: JSON.parse(String(init.body)) });
        history = history.map((node) =>
          node.id === liveId ? { ...node, status: 'stopped' } : node,
        );
        liveId = path.endsWith('/start') ? 'forked-session' : 'origin-session';
        const existing = history.find((node) => node.id === liveId);
        const next = existing
          ? { ...existing, status: 'running' as const }
          : record(liveId, {
              status: 'running',
              name: 'Forked session',
              parentSessionId: path.split('/').at(-2) ?? null,
            });
        history = [...history.filter((node) => node.id !== liveId), next];
        return makeResponse(activeSession(next));
      }
      return makeResponse({ items: [] });
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const saveCount = /^\d+ save points?$/;

  function findSessionTrigger() {
    return screen.findByRole('button', { name: /Switch session, current session/ });
  }

  async function openSwitcher() {
    fireEvent.click(await findSessionTrigger());
    return screen.findByRole('dialog', { name: 'Sessions' });
  }

  async function sessionRow(sessions: HTMLElement, label: string) {
    const name = await within(sessions).findByRole('button', { name: label });
    return name.closest('tr')!;
  }

  function showOfflineHistory() {
    liveId = '';
    singlePage = true;
    history = [
      record('previous-session', { name: 'Previous run' }),
      record('save-1', {
        name: 'Offline checkpoint',
        kind: 'save_point',
        parentSessionId: 'previous-session',
      }),
    ];
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
  }

  async function openRowSavePointList(row: HTMLElement) {
    fireEvent.click(within(row).getByRole('button', { name: saveCount }));
    return screen.findByRole('list', { name: 'Save points' });
  }

  it('starts from the offline tree without replacement and opens the new inline terminal', async () => {
    showOfflineHistory();
    const list = await openRowSavePointList(
      await screen.findByRole('row', { name: /Previous run/ }),
    );
    fireEvent.click(within(list).getByRole('button', { name: 'Fork from save point' }));

    expect(await screen.findByRole('region', { name: 'Inline terminal for Alpha' })).toBeVisible();
    expect(requests).toEqual([
      { path: '/api/sessions/save-1/start', body: { projectId, expectedAgentId: agentId } },
    ]);
  });

  it('confirms a rollback from the launch screen and replaces no session', async () => {
    showOfflineHistory();
    const list = await openRowSavePointList(
      await screen.findByRole('row', { name: /Previous run/ }),
    );
    fireEvent.click(within(list).getByRole('button', { name: 'Roll back' }));

    const dialog = await screen.findByRole('dialog', { name: 'Roll back session?' });
    expect(
      within(dialog).queryByText('The current session stops and stays in the list.'),
    ).toBeNull();
    expect(requests).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));

    await waitFor(() =>
      expect(requests).toEqual([
        {
          path: '/api/sessions/previous-session/rollback',
          body: { projectId, savePointId: 'save-1', keepCurrent: true, expectedAgentId: agentId },
        },
      ]),
    );
  });

  it('finds and expands the live path across pages and loads other roots on demand', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const sessions = await openSwitcher();
    // The live session is a fork of a save point of Original session, which is not a row.
    expect(await sessionRow(sessions, 'Current session')).toBeVisible();
    expect(within(sessions).queryByRole('button', { name: 'Parent save' })).toBeNull();
    expect(cursors).toContain('live-page');
    expect(cursors).not.toContain('older-page');

    expect(
      within(await sessionRow(sessions, 'Unrelated history')).getByRole('button', {
        name: '1 save point',
      }),
    ).toBeVisible();
    expect(within(sessions).queryByRole('button', { name: 'Hidden branch' })).toBeNull();
    fireEvent.click(within(sessions).getByRole('button', { name: 'Load more' }));
    expect(await sessionRow(sessions, 'Older third page')).toBeVisible();
  });

  it('lets the wheel scroll a row save point list inside the Sessions dialog', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const sessions = await openSwitcher();
    const list = await openRowSavePointList(await sessionRow(sessions, 'Current session'));
    // jsdom has no layout; the scroll lock reads these sizes to decide if the list can scroll.
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 });

    const wheel = new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true });
    within(list).getAllByRole('listitem')[0].dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(false);
  });

  it('refreshes a loaded one-page tree when Restart changes the live session', async () => {
    singlePage = true;
    history = history
      .filter((node) => node.id === firstLiveId || node.id === 'save-1')
      .map((node) => (node.id === firstLiveId ? { ...node, parentSessionId: null } : node));
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    expect(await screen.findByRole('button', { name: '1 save point' })).toBeVisible();
    const firstSwitcher = await openSwitcher();
    expect(await sessionRow(firstSwitcher, 'Current session')).toBeVisible();
    // The bar loads the tree, and opening Sessions loads it again.
    await waitFor(() => expect(cursors).toEqual([null, null]));
    fireEvent.keyDown(firstSwitcher, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(firstSwitcher).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Inline terminal for Alpha' })).toHaveAttribute(
        'data-session-id',
        'restarted-session',
      ),
    );

    await waitFor(() => expect(screen.queryByRole('button', { name: saveCount })).toBeNull());
    expect(cursors).toEqual([null, null, null]);
    const sessions = await openSwitcher();
    expect(await sessionRow(sessions, 'Restarted session')).toBeVisible();
    expect(
      within(await sessionRow(sessions, 'Current session')).getByRole('button', {
        name: 'Restore session',
      }),
    ).toBeVisible();
    await waitFor(() => expect(cursors).toEqual([null, null, null, null]));
    expect(requests).toEqual([{ path: `/api/agents/${agentId}/restart`, body: { projectId } }]);
  });

  it('adds a save under the live session, keeps the terminal mounted, and displays the renamed label', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const terminal = await screen.findByRole('region', { name: 'Inline terminal for Alpha' });
    expect(await screen.findByRole('button', { name: '1 save point' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save point' }));
    await screen.findByRole('button', { name: '2 save points' });
    expect(requests).toEqual([
      { path: `/api/sessions/${firstLiveId}/save-points`, body: { projectId } },
    ]);
    expect(screen.getByRole('region', { name: 'Inline terminal for Alpha' })).toBe(terminal);
    expect(terminal).toHaveAttribute('data-session-id', firstLiveId);

    const sessions = await openSwitcher();
    const list = await openRowSavePointList(await sessionRow(sessions, 'Current session'));
    fireEvent.click(within(list).getByRole('button', { name: defaultSaveLabel }));
    const rename = within(list).getByRole('textbox', { name: 'Session name' });
    fireEvent.change(rename, { target: { value: 'Named save' } });
    fireEvent.keyDown(rename, { key: 'Enter', code: 'Enter' });
    expect(await within(list).findByRole('button', { name: 'Named save' })).toBeVisible();
    expect(requests.at(-1)).toEqual({
      path: '/api/sessions/new-save',
      body: { projectId, name: 'Named save' },
    });
  });

  // The page is the first layer that wires the switcher selection and confirmation
  // to a request containing both the target and replacement session IDs.
  it.each([
    {
      label: 'Ready checkpoint',
      action: 'Fork',
      title: 'Fork session?',
      target: 'save-1/start',
      child: 'forked-session',
      inListOf: 'Current session',
    },
    {
      label: 'Original session',
      action: 'Fork',
      title: 'Fork session?',
      target: 'origin-session/start',
      child: 'forked-session',
    },
    {
      label: 'Failed session',
      action: 'Fork',
      title: 'Fork session?',
      target: 'failed-session/start',
      child: 'forked-session',
      failed: true,
    },
    {
      label: 'Original session',
      action: 'Restore',
      title: 'Restore session?',
      target: 'origin-session/restore',
      child: 'origin-session',
    },
  ])(
    'confirms $action before replacing the terminal session',
    async ({ label, action, title, target, child, failed, inListOf }) => {
      if (failed) {
        history.push(record('failed-session', { name: label, status: 'failed' }));
      }
      renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
      const actionName = action === 'Restore' ? 'Restore session' : action;
      async function startAction() {
        const sessions = await openSwitcher();
        if (inListOf) {
          const list = await openRowSavePointList(await sessionRow(sessions, inListOf));
          fireEvent.click(within(list).getByRole('button', { name: 'Fork from save point' }));
          return;
        }
        fireEvent.click(
          within(await sessionRow(sessions, label)).getByRole('button', { name: actionName }),
        );
      }
      await startAction();
      const dialog = await screen.findByRole('dialog', { name: title });
      expect(
        within(dialog).getByText('The current session stops and stays in the list.'),
      ).toBeVisible();
      expect(within(dialog).getByText(label)).toBeVisible();
      expect(within(dialog).getByText('Current session', { selector: 'strong' })).toBeVisible();
      expect(requests).toHaveLength(0);

      appSocketEmitMock.mockClear();
      fireEvent.keyDown(within(dialog).getByRole('button', { name: action }), {
        key: 'Escape',
        code: 'Escape',
      });
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      expect(requests).toHaveLength(0);
      expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:input', expect.anything());

      await startAction();
      fireEvent.click(
        within(await screen.findByRole('dialog', { name: title })).getByRole('button', {
          name: action,
        }),
      );

      await waitFor(() =>
        expect(screen.getByRole('region', { name: 'Inline terminal for Alpha' })).toHaveAttribute(
          'data-session-id',
          child,
        ),
      );
      expect(requests).toEqual([
        {
          path: `/api/sessions/${target}`,
          body: {
            projectId,
            [action === 'Restore' ? 'targetAgentId' : 'expectedAgentId']: agentId,
            replaceRunningSessionId: firstLiveId,
          },
        },
      ]);
    },
  );

  it('hides all save-point mutation controls for a team member', async () => {
    availability = { available: false, reason: 'TEAM_MEMBER' };
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    await screen.findByRole('button', { name: 'Switch session, current session Current session' });
    expect(screen.queryByRole('button', { name: 'Save point' })).toBeNull();
    expect(screen.queryByRole('button', { name: saveCount })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull();

    const sessions = await openSwitcher();
    expect(await sessionRow(sessions, 'Current session')).toBeVisible();
    expect(within(sessions).queryByRole('button', { name: saveCount })).toBeNull();
    expect(
      within(await sessionRow(sessions, 'Original session')).queryByRole('button', {
        name: 'Fork',
      }),
    ).toBeNull();
  });

  // The page combines presence with the tree response, which can report a stale status.
  it.each(['running', 'stopped'] as const)(
    'protects the live row with status %s',
    async (status) => {
      history = history.map((node) => (node.id === firstLiveId ? { ...node, status } : node));
      history.push(
        record('other-running-session', { name: 'Other running session', status: 'running' }),
      );
      renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);

      const sessions = await openSwitcher();
      const live = within(await sessionRow(sessions, 'Current session'));
      const otherRunning = within(await sessionRow(sessions, 'Other running session'));
      expect(live.getByText('Live')).toBe(within(sessions).getByText('Live'));
      for (const name of ['Fork', 'Restore session', 'Delete session record']) {
        expect(live.queryByRole('button', { name })).toBeNull();
        expect(otherRunning.queryByRole('button', { name })).toBeNull();
      }
      expect(live.queryByRole('button', { name: 'Read transcript' })).toBeNull();
      expect(otherRunning.getByRole('button', { name: 'Read transcript' })).toBeVisible();
    },
  );

  // The page is the cheapest layer with both the Radix capture listener and the terminal handler.
  it('cancels inline rename on the first Escape and closes Sessions on the next', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const sessions = await openSwitcher();
    fireEvent.click(await within(sessions).findByRole('button', { name: 'Original session' }));
    const rename = within(sessions).getByRole('textbox', { name: 'Session name' });
    fireEvent.change(rename, { target: { value: 'Discarded name' } });
    appSocketEmitMock.mockClear();

    fireEvent.keyDown(rename, { key: 'Escape', code: 'Escape' });

    expect(rename).not.toBeInTheDocument();
    expect(sessions).toBeVisible();
    expect(await sessionRow(sessions, 'Original session')).toBeVisible();
    expect(requests).toHaveLength(0);
    expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:input', expect.anything());

    fireEvent.keyDown(sessions, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(sessions).not.toBeInTheDocument());
    expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:input', expect.anything());
  });

  // The focus target and both dialog lifecycles are wired together by the page.
  it('returns focus to the bar trigger after cancelling replacement', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const trigger = await findSessionTrigger();
    const sessions = await openSwitcher();
    const onTriggerFocus = jest.fn();
    trigger.addEventListener('focus', onTriggerFocus);

    fireEvent.click(
      within(await sessionRow(sessions, 'Original session')).getByRole('button', {
        name: 'Restore session',
      }),
    );
    const confirm = await screen.findByRole('dialog', { name: 'Restore session?' });
    expect(confirm).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onTriggerFocus).toHaveBeenCalledTimes(1);
  });

  // The page keeps the parent dialog open while the nested confirmation handles Escape.
  it('keeps Sessions open behind the delete confirmation and returns focus to its row', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const sessions = await openSwitcher();
    const remove = within(await sessionRow(sessions, 'Original session')).getByRole('button', {
      name: 'Delete session record',
    });
    fireEvent.click(remove);

    const confirm = await screen.findByRole('dialog', { name: 'Delete session record?' });
    expect(sessions).toBeInTheDocument();
    appSocketEmitMock.mockClear();
    fireEvent.keyDown(confirm, { key: 'Escape', code: 'Escape' });

    await waitFor(() => expect(confirm).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Sessions' })).toBe(sessions);
    await waitFor(() => expect(remove).toHaveFocus());
    expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:input', expect.anything());
  });

  // ChatPage is the smallest layer with the Read dialog, bar trigger, and terminal Escape handler.
  it('hands focus directly to the transcript and reopens Sessions on dismissal', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const trigger = await findSessionTrigger();
    const sessions = await openSwitcher();
    const read = within(await sessionRow(sessions, 'Original session')).getByRole('button', {
      name: 'Read transcript',
    });
    const onTriggerFocus = jest.fn();
    trigger.addEventListener('focus', onTriggerFocus);

    jest.useFakeTimers();
    try {
      fireEvent.click(read);
      const transcript = screen.getByRole('dialog', { name: 'Session transcript' });
      const close = within(transcript).getByRole('button', { name: 'Close transcript viewer' });
      act(() => jest.advanceTimersByTime(0));
      expect(transcript).toContainElement(document.activeElement as HTMLElement);
      expect(onTriggerFocus).not.toHaveBeenCalled();

      appSocketEmitMock.mockClear();
      fireEvent.keyDown(close, { key: 'Escape', code: 'Escape' });

      const reopened = await screen.findByRole('dialog', { name: 'Sessions' });
      expect(transcript).not.toBeInTheDocument();
      act(() => jest.advanceTimersByTime(0));
      expect(reopened).toContainElement(document.activeElement as HTMLElement);
      expect(onTriggerFocus).not.toHaveBeenCalled();
      expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:input', expect.anything());
    } finally {
      jest.useRealTimers();
    }
  });

  async function openSavePointList() {
    fireEvent.click(await screen.findByRole('button', { name: saveCount }));
    return screen.findByRole('list', { name: 'Save points' });
  }

  function addBeforeRollbackRecord() {
    history.push(
      record('record-1', {
        name: null,
        kind: 'save_point',
        parentSessionId: firstLiveId,
        beforeRollback: true,
      }),
    );
  }

  it('lists the live save points from the bar chip with the Before rollback record first', async () => {
    addBeforeRollbackRecord();
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    fireEvent.click(await screen.findByRole('button', { name: '2 save points' }));
    const [first, second] = within(
      await screen.findByRole('list', { name: 'Save points' }),
    ).getAllByRole('listitem');

    expect(within(first).getByText(/^Before rollback · /)).toBeVisible();
    fireEvent.click(within(first).getByText(/^Before rollback · /));
    expect(within(first).queryByRole('textbox', { name: 'Session name' })).toBeNull();
    fireEvent.click(within(second).getByRole('button', { name: 'Ready checkpoint' }));
    expect(within(second).getByRole('textbox', { name: 'Session name' })).toHaveFocus();
    for (const item of [first, second]) {
      for (const name of ['Roll back', 'Fork from save point', 'Read transcript']) {
        expect(within(item).getByRole('button', { name })).toBeEnabled();
      }
    }
  });

  // The page is the first layer that joins the list, the confirmation and the request.
  it.each([
    { keepCurrent: true, clear: false },
    { keepCurrent: false, clear: true },
  ])(
    'rolls back the live session with keepCurrent $keepCurrent',
    async ({ keepCurrent, clear }) => {
      renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
      const list = await openSavePointList();
      fireEvent.click(within(list).getByRole('button', { name: 'Roll back' }));

      const dialog = await screen.findByRole('dialog', { name: 'Roll back session?' });
      const keep = within(dialog).getByRole('checkbox', { name: 'Keep the current conversation' });
      expect(keep).toBeChecked();
      if (clear) fireEvent.click(within(dialog).getByText('Keep the current conversation'));
      expect(keep).toHaveAttribute('aria-checked', String(keepCurrent));
      expect(requests).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));

      await waitFor(() =>
        expect(requests).toEqual([
          {
            path: `/api/sessions/${firstLiveId}/rollback`,
            body: {
              projectId,
              savePointId: 'save-1',
              keepCurrent,
              expectedAgentId: agentId,
              replaceRunningSessionId: firstLiveId,
            },
          },
        ]),
      );
      expect(await screen.findByRole('button', { name: saveCount })).toHaveFocus();
    },
  );

  it('rolls back a stopped session from its row and replaces the live session', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const sessions = await openSwitcher();
    const list = await openRowSavePointList(await sessionRow(sessions, 'Original session'));
    fireEvent.click(within(list).getByRole('button', { name: 'Roll back' }));

    const dialog = await screen.findByRole('dialog', { name: 'Roll back session?' });
    expect(
      within(dialog).getByText('The current session stops and stays in the list.'),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));

    await waitFor(() =>
      expect(requests).toEqual([
        {
          path: '/api/sessions/origin-session/rollback',
          body: {
            projectId,
            savePointId: 'origin-save',
            keepCurrent: true,
            expectedAgentId: agentId,
            replaceRunningSessionId: firstLiveId,
          },
        },
      ]),
    );
  });

  // The page is the first layer where presence can move the bar to another session mid-confirmation.
  it('keeps the rollback target and replacement ID of the open confirmation when the live session changes', async () => {
    history.push(record('next-live', { name: 'Next session', parentSessionId: 'origin-save' }));
    const { queryClient } = renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const list = await openSavePointList();
    fireEvent.click(within(list).getByRole('button', { name: 'Roll back' }));
    const dialog = await screen.findByRole('dialog', { name: 'Roll back session?' });

    history = history.map((node) =>
      node.id === firstLiveId
        ? { ...node, status: 'stopped' }
        : node.id === 'next-live'
          ? { ...node, status: 'running' }
          : node,
    );
    liveId = 'next-live';
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await screen.findByRole('button', {
      name: 'Switch session, current session Next session',
      hidden: true,
    });
    expect(within(dialog).getByText('Current session', { selector: 'strong' })).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));

    await waitFor(() =>
      expect(requests).toEqual([
        {
          path: `/api/sessions/${firstLiveId}/rollback`,
          body: {
            projectId,
            savePointId: 'save-1',
            keepCurrent: true,
            expectedAgentId: agentId,
            replaceRunningSessionId: firstLiveId,
          },
        },
      ]),
    );
  });

  // The page owns the Escape handler that types into the terminal.
  it('keeps Escape from the terminal while the list is open and cancels a rename first', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const list = await openSavePointList();
    fireEvent.click(within(list).getByRole('button', { name: 'Ready checkpoint' }));
    const rename = within(list).getByRole('textbox', { name: 'Session name' });
    fireEvent.change(rename, { target: { value: 'Discarded name' } });
    appSocketEmitMock.mockClear();

    fireEvent.keyDown(rename, { key: 'Escape', code: 'Escape' });
    expect(rename).not.toBeInTheDocument();
    expect(list).toBeVisible();

    fireEvent.keyDown(within(list).getByRole('button', { name: 'Ready checkpoint' }), {
      key: 'Escape',
      code: 'Escape',
    });
    await waitFor(() => expect(list).not.toBeInTheDocument());
    expect(requests).toHaveLength(0);
    expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:input', expect.anything());
  });

  it('does not reopen Sessions when a transcript read from the bar list closes', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const list = await openSavePointList();
    fireEvent.click(within(list).getByRole('button', { name: 'Read transcript' }));
    const transcript = await screen.findByRole('dialog', { name: 'Session transcript' });

    fireEvent.click(within(transcript).getByRole('button', { name: 'Close transcript viewer' }));

    await waitFor(() => expect(transcript).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: 'Sessions' })).toBeNull();
  });

  it.each([
    { unsupported: true, reason: 'Save points are not available for this provider yet.' },
    { unsupported: false, reason: 'Wait until the agent completes its turn.' },
    { action: 'Fork', reason: 'Wait until the agent completes its turn.' },
    {
      action: 'Fork',
      noConversation: true,
      reason: 'Send a message first so there is a conversation to fork.',
    },
    { action: 'Fork', savePending: true, reason: 'Wait until the current action completes.' },
  ])(
    'provides the disabled reason of $action on keyboard focus and sends nothing ($reason)',
    async ({ action = 'Save point', unsupported, noConversation, savePending, reason }) => {
      if (savePending) {
        const respond = global.fetch;
        global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
          String(input).endsWith('/save-points')
            ? new Promise<Response>(() => undefined)
            : respond(input, init),
        );
      }
      if (unsupported) availability = { available: false, reason: 'PROVIDER_UNSUPPORTED' };
      else if (noConversation) {
        history = history.map((node) =>
          node.id === firstLiveId ? { ...node, providerSessionId: null } : node,
        );
      } else if (!savePending) activity = 'busy';
      renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
      if (savePending) fireEvent.click(await screen.findByRole('button', { name: 'Save point' }));
      // The bar Fork waits for the live tree node; Save point does not.
      if (noConversation) await screen.findByRole('button', { name: saveCount });

      const button =
        action === 'Fork'
          ? await screen.findByRole('button', { name: 'Fork' })
          : await screen.findByRole('button', { name: action });
      expect(button).toBeDisabled();
      fireEvent.focus(button.parentElement!);
      expect(await screen.findByRole('tooltip')).toHaveTextContent(reason);
      fireEvent.click(button);
      expect(requests).toHaveLength(0);
    },
  );

  it.each([
    { type: 'discovered', when: 'after the page loaded' },
    { type: 'providerSessionId.discovered', when: 'after the page loaded' },
    // Presence gives the live ID, so the bar shows before the list of sessions loads.
    { type: 'discovered', when: 'while the session list loads', heldPath: '/api/sessions' },
    // The response of the first tree request is from before the binding and arrives after it.
    {
      type: 'discovered',
      when: 'while the tree loads',
      heldPath: `/api/sessions/agents/${agentId}/tree`,
    },
  ])(
    'enables the bar Fork when the live session gets its conversation $when ($type)',
    async ({ type, heldPath }) => {
      const { useAppSocket } = jest.requireMock('@/ui/hooks/useAppSocket') as {
        useAppSocket: jest.Mock;
      };
      const callsBefore = useAppSocket.mock.calls.length;
      history = history.map((node) =>
        node.id === firstLiveId ? { ...node, providerSessionId: null } : node,
      );
      const treeIsHeld = heldPath?.endsWith('/tree') ?? false;
      singlePage = treeIsHeld;
      const respond = global.fetch;
      let heldRequests = 0;
      let release = () => undefined as void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        // The response is made at the time of the request, then waits.
        const response = await respond(input, init);
        if (new URL(String(input), 'http://localhost').pathname === heldPath) {
          heldRequests += 1;
          if (heldRequests === 1) await released;
        }
        return response;
      });
      renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
      await screen.findByRole('group', { name: 'Session actions' });
      if (treeIsHeld) {
        await waitFor(() => expect(heldRequests).toBe(1));
      } else {
        await screen.findByRole('button', { name: saveCount });
        expect(await screen.findByRole('button', { name: 'Fork' })).toBeDisabled();
      }

      history = history.map((node) =>
        node.id === firstLiveId ? { ...node, providerSessionId: 'provider-bound' } : node,
      );
      const listeners = new Set<(envelope: unknown) => void>(
        useAppSocket.mock.calls
          .slice(callsBefore)
          .map(([handlers]) => handlers?.message)
          .filter(Boolean),
      );
      act(() => {
        for (const listener of listeners) {
          listener({ topic: `session/${firstLiveId}/transcript`, type, payload: {} });
        }
      });
      await act(async () => release());

      await waitFor(() => expect(screen.getByRole('button', { name: 'Fork' })).toBeEnabled());
    },
  );

  it('confirms a Fork of the live session from the bar and keeps Escape from the terminal', async () => {
    renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
    const openConfirmation = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Fork' }));
      return screen.findByRole('dialog', { name: 'Fork current session?' });
    };

    const dialog = await openConfirmation();
    expect(
      within(dialog).getByText(
        'The current session stops and stays in the list. A new session starts with a copy of this conversation.',
      ),
    ).toBeVisible();
    appSocketEmitMock.mockClear();
    fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Fork' }), {
      key: 'Escape',
      code: 'Escape',
    });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(appSocketEmitMock).not.toHaveBeenCalledWith('terminal:input', expect.anything());
    expect(requests).toHaveLength(0);

    fireEvent.click(within(await openConfirmation()).getByRole('button', { name: 'Fork' }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Inline terminal for Alpha' })).toHaveAttribute(
        'data-session-id',
        'forked-session',
      ),
    );
    expect(requests).toEqual([
      {
        path: `/api/sessions/${firstLiveId}/start`,
        body: { projectId, expectedAgentId: agentId, replaceRunningSessionId: firstLiveId },
      },
    ]);
  });

  it('ends the Fork confirmation and its Escape guard when the live session ends', async () => {
    focusedWindowIdMock.value = 'focused-terminal-session';
    try {
      const { queryClient } = renderWithClient(<ChatPage />, ['/chat?agent=agent-1']);
      fireEvent.click(await screen.findByRole('button', { name: 'Fork' }));
      await screen.findByRole('dialog', { name: 'Fork current session?' });

      history = history.map((node) =>
        node.id === firstLiveId ? { ...node, status: 'stopped' } : node,
      );
      liveId = '';
      await act(async () => {
        await queryClient.invalidateQueries();
      });
      await screen.findByRole('button', { name: 'Launch Session' });
      expect(screen.queryByRole('dialog', { name: 'Fork current session?' })).toBeNull();

      appSocketEmitMock.mockClear();
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
      expect(appSocketEmitMock).toHaveBeenCalledWith('terminal:input', {
        sessionId: 'focused-terminal-session',
        data: '\x1b',
      });
      expect(requests).toHaveLength(0);
    } finally {
      focusedWindowIdMock.value = null;
    }
  });
});
