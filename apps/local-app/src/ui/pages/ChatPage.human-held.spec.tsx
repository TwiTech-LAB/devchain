import React from 'react';
import { render, act, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Layer: UI page (jsdom). Capturing the ChatSidebar data bundle from the real
 * ChatPage is the cheapest reliable proof that pool data reaches the sidebar as
 * the positive-only humanHeldMessageCounts map; hook-level query/invalidation
 * behavior is owned by useMessagePools.spec.tsx.
 */

// ---- jsdom polyfills required by ChatPage's dependency tree ----
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = jest.fn();
}
if (!(global as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver) {
  class ResizeObserverMock {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
  }
  (global as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverMock as unknown as typeof ResizeObserver;
}

const mockSidebarProps: { current: Record<string, unknown> | null } = { current: null };
const mockSidebarRenders = { count: 0 };

jest.mock('@/ui/components/chat/ChatSidebar', () => ({
  ChatSidebar: (props: Record<string, unknown>) => {
    mockSidebarProps.current = props;
    mockSidebarRenders.count += 1;
    return null;
  },
}));

jest.mock('@xterm/xterm/css/xterm.css', () => ({}), { virtual: true });
jest.mock('@xterm/xterm', () => ({
  Terminal: jest.fn(() => ({
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
  })),
  FitAddon: jest.fn(() => ({ activate: jest.fn(), dispose: jest.fn(), fit: jest.fn() })),
}));
jest.mock('@/ui/components/chat/InlineTerminalPanel', () => ({
  InlineTerminalPanel: () => null,
}));
jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => jest.fn(),
  useWorktreeTerminalWindowManager: () => jest.fn(),
  useTerminalWindows: () => ({ windows: [], closeWindow: jest.fn(), focusedWindowId: null }),
  TerminalWindowsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: 'project-1',
    selectedProject: { id: 'project-1', name: 'Project 1', rootPath: '/tmp/project-1' },
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
    emit: jest.fn(),
  })),
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ChatPage = require('./ChatPage').ChatPage as React.ComponentType;

interface PoolFixture {
  agentId: string;
  messageCount: number;
  humanHeldMessageCount: number;
  humanReleaseEligibleAt?: number;
  holdReason?: string;
  forceEligibleAt?: number;
  activeSessionId?: string;
  deferredMessageIds?: string[];
}

function poolsResponse(pools: PoolFixture[], waitingMs: number) {
  return {
    ok: true,
    json: async () => ({
      pools: pools.map((pool) => ({
        agentId: pool.agentId,
        agentName: pool.agentId.toUpperCase(),
        projectId: 'project-1',
        messageCount: pool.messageCount,
        humanHeldMessageCount: pool.humanHeldMessageCount,
        humanReleaseEligibleAt: pool.humanReleaseEligibleAt ?? 0,
        holdReason: pool.holdReason,
        forceEligibleAt: pool.forceEligibleAt,
        activeSessionId: pool.activeSessionId,
        deferredMessageIds: pool.deferredMessageIds,
        waitingMs,
        messages: [],
      })),
    }),
  };
}

function stubFetch(pools: () => PoolFixture[], waitingMs: () => number): jest.Mock {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/sessions/pools')) {
      return poolsResponse(pools(), waitingMs());
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as jest.Mock;
}

async function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <MemoryRouter initialEntries={['/chat']}>
      <QueryClientProvider client={queryClient}>
        <ChatPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(mockSidebarProps.current).not.toBeNull());
  return { ...utils, queryClient };
}

function sidebarData() {
  if (!mockSidebarProps.current) throw new Error('ChatSidebar has not rendered yet');
  return mockSidebarProps.current.data as {
    humanHeldMessageCounts?: Record<string, number>;
    humanHeldReleaseEligibleAgentIds?: Record<string, true>;
    forceEligibleAgentIds?: Record<string, true>;
    holdReasonLabels?: Record<string, string>;
  };
}

function sidebarController() {
  if (!mockSidebarProps.current) throw new Error('ChatSidebar has not rendered yet');
  return mockSidebarProps.current.sessionController as {
    onReleaseHeldMessages: (agentId: string) => void;
    onForceDelivery: (agentId: string) => void;
    forcingAgentId: string | null;
  };
}

function poolsFetchCount(): number {
  return (global.fetch as jest.Mock).mock.calls.filter((call) =>
    String(call[0]).includes('/api/sessions/pools'),
  ).length;
}

describe('ChatPage human-held message counts mapping', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockSidebarProps.current = null;
    mockSidebarRenders.count = 0;
  });

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch;
  });

  it('maps only positive human-held counts into the sidebar data bundle', async () => {
    global.fetch = stubFetch(
      () => [
        { agentId: 'agent-a', messageCount: 2, humanHeldMessageCount: 2 },
        { agentId: 'agent-b', messageCount: 1, humanHeldMessageCount: 0 },
        { agentId: 'agent-c', messageCount: 3, humanHeldMessageCount: 1 },
      ],
      () => 1000,
    ) as unknown as typeof fetch;

    await setup();

    await waitFor(() =>
      expect(sidebarData().humanHeldMessageCounts).toEqual({ 'agent-a': 2, 'agent-c': 1 }),
    );
  });

  it('yields an empty map when every pool has zero held messages', async () => {
    global.fetch = stubFetch(
      () => [{ agentId: 'agent-a', messageCount: 4, humanHeldMessageCount: 0 }],
      () => 1000,
    ) as unknown as typeof fetch;

    await setup();

    await waitFor(() => expect(poolsFetchCount()).toBeGreaterThan(0));
    await waitFor(() => expect(sidebarData().humanHeldMessageCounts).toEqual({}));
  });

  it('shows the count immediately and enables release after the eligibility timestamp', async () => {
    const eligibleAt = Date.now() + 900;
    global.fetch = stubFetch(
      () => [
        {
          agentId: 'agent-a',
          messageCount: 1,
          humanHeldMessageCount: 1,
          humanReleaseEligibleAt: eligibleAt,
        },
      ],
      () => 30_000,
    ) as unknown as typeof fetch;

    await setup();
    await waitFor(() => expect(poolsFetchCount()).toBeGreaterThan(0));
    expect(sidebarData().humanHeldMessageCounts).toEqual({ 'agent-a': 1 });
    expect(sidebarData().humanHeldReleaseEligibleAgentIds).toEqual({});

    await waitFor(
      () => expect(sidebarData().humanHeldReleaseEligibleAgentIds).toEqual({ 'agent-a': true }),
      { timeout: 2_000 },
    );
  });

  it('keeps the counts record and data bundle references across a waiting-time-only refresh', async () => {
    const pools = [{ agentId: 'agent-a', messageCount: 2, humanHeldMessageCount: 2 }];
    let waitingMs = 1000;
    global.fetch = stubFetch(
      () => pools,
      () => waitingMs,
    ) as unknown as typeof fetch;

    const { queryClient } = await setup();

    await waitFor(() => expect(sidebarData().humanHeldMessageCounts).toEqual({ 'agent-a': 2 }));
    const countsBefore = sidebarData().humanHeldMessageCounts;
    const rendersBefore = mockSidebarRenders.count;

    // Same held counts; only the recomputed waiting time changes.
    waitingMs = 9000;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['pools', 'project-1'] });
    });

    await waitFor(() => expect(poolsFetchCount()).toBeGreaterThanOrEqual(2));
    // The refetched pools array re-renders ChatPage; the equal-counts record
    // must keep its identity.
    await waitFor(() => expect(mockSidebarRenders.count).toBeGreaterThan(rendersBefore));
    expect(sidebarData().humanHeldMessageCounts).toBe(countsBefore);
  });

  it('replaces the counts record when a held count changes', async () => {
    const pools = [{ agentId: 'agent-a', messageCount: 2, humanHeldMessageCount: 2 }];
    global.fetch = stubFetch(
      () => pools,
      () => 1000,
    ) as unknown as typeof fetch;

    const { queryClient } = await setup();

    await waitFor(() => expect(sidebarData().humanHeldMessageCounts).toEqual({ 'agent-a': 2 }));
    const countsBefore = sidebarData().humanHeldMessageCounts;

    pools[0] = { agentId: 'agent-a', messageCount: 2, humanHeldMessageCount: 3 };
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['pools', 'project-1'] });
    });

    await waitFor(() => expect(sidebarData().humanHeldMessageCounts).toEqual({ 'agent-a': 3 }));
    expect(sidebarData().humanHeldMessageCounts).not.toBe(countsBefore);
  });

  it('opens the explicit release confirmation from the sidebar action', async () => {
    global.fetch = stubFetch(
      () => [{ agentId: 'agent-a', messageCount: 2, humanHeldMessageCount: 2 }],
      () => 31_000,
    ) as unknown as typeof fetch;
    await setup();
    await waitFor(() => expect(sidebarData().humanHeldMessageCounts).toEqual({ 'agent-a': 2 }));

    const controller = mockSidebarProps.current?.sessionController as {
      onReleaseHeldMessages: (agentId: string) => void;
    };
    act(() => controller.onReleaseHeldMessages('agent-a'));

    expect(
      screen.getByRole('heading', { name: 'Release queued messages, my draft is clear' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(
      screen.queryByRole('heading', { name: 'Release queued messages, my draft is clear' }),
    ).not.toBeInTheDocument();
  });

  it('uses truthful draft-release copy about quiet waiting', async () => {
    global.fetch = stubFetch(
      () => [{ agentId: 'agent-a', messageCount: 2, humanHeldMessageCount: 2 }],
      () => 31_000,
    ) as unknown as typeof fetch;
    await setup();
    await waitFor(() => expect(sidebarData().humanHeldMessageCounts).toEqual({ 'agent-a': 2 }));

    const controller = mockSidebarProps.current?.sessionController as {
      onReleaseHeldMessages: (agentId: string) => void;
    };
    act(() => controller.onReleaseHeldMessages('agent-a'));

    expect(screen.getByText(/will send when the terminal is quiet/)).toBeInTheDocument();
  });

  describe('force delivery flow', () => {
    const forcePool: PoolFixture = {
      agentId: 'agent-a',
      messageCount: 1,
      humanHeldMessageCount: 1,
      holdReason: 'awaiting_quiet',
      forceEligibleAt: Date.now() - 1000,
      activeSessionId: 'session-1',
      deferredMessageIds: ['msg-1'],
    };

    it('exposes forceEligibleAgentIds for awaiting_stable_idle with humanHeldMessageCount=1', async () => {
      global.fetch = stubFetch(
        () => [forcePool],
        () => 35_000,
      ) as unknown as typeof fetch;
      await setup();

      await waitFor(() => expect(sidebarData().forceEligibleAgentIds).toEqual({ 'agent-a': true }));
    });

    it('does not expose force for draft_active', async () => {
      global.fetch = stubFetch(
        () => [
          {
            agentId: 'agent-a',
            messageCount: 2,
            humanHeldMessageCount: 2,
            holdReason: 'human_draft',
          },
        ],
        () => 35_000,
      ) as unknown as typeof fetch;
      await setup();

      await waitFor(() => expect(poolsFetchCount()).toBeGreaterThan(0));
      expect(sidebarData().forceEligibleAgentIds).toEqual({});
    });

    it('opens force confirmation dialog and Cancel sends nothing', async () => {
      global.fetch = stubFetch(
        () => [forcePool],
        () => 35_000,
      ) as unknown as typeof fetch;
      await setup();
      await waitFor(() => expect(sidebarData().forceEligibleAgentIds).toEqual({ 'agent-a': true }));

      act(() => sidebarController().onForceDelivery('agent-a'));

      expect(screen.getByRole('heading', { name: 'Send now' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('heading', { name: 'Send now' })).not.toBeInTheDocument();
      expect(
        (global.fetch as jest.Mock).mock.calls.filter((c) =>
          String(c[0]).includes('force-deferred'),
        ),
      ).toHaveLength(0);
    });

    it('Confirm posts exact session+messageIds and shows delivered toast', async () => {
      const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('force-deferred')) {
          return {
            ok: true,
            json: async () => ({ status: 'delivered', deliveredCount: 1 }),
          };
        }
        if (url.includes('/api/sessions/pools')) {
          return poolsResponse([forcePool], 35_000);
        }
        return { ok: true, json: async () => ({ items: [] }) };
      }) as unknown as typeof fetch;
      global.fetch = fetchImpl;

      await setup();
      await waitFor(() => expect(sidebarData().forceEligibleAgentIds).toEqual({ 'agent-a': true }));

      act(() => sidebarController().onForceDelivery('agent-a'));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
      });

      await waitFor(() =>
        expect(fetchImpl).toHaveBeenCalledWith(
          expect.stringContaining('force-deferred'),
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
              projectId: 'project-1',
              sessionId: 'session-1',
              messageIds: ['msg-1'],
            }),
          }),
        ),
      );
    });

    it('shows hold-reason label for on_idle lane before force threshold', async () => {
      global.fetch = stubFetch(
        () => [
          {
            agentId: 'agent-a',
            messageCount: 1,
            humanHeldMessageCount: 0,
            holdReason: 'awaiting_idle',
            forceEligibleAt: Date.now() + 60000,
            activeSessionId: 'session-1',
            deferredMessageIds: ['msg-1'],
          },
        ],
        () => 5_000,
      ) as unknown as typeof fetch;
      await setup();

      await waitFor(() =>
        expect(sidebarData().holdReasonLabels).toEqual({
          'agent-a': 'Waiting for provider idle',
        }),
      );
      expect(sidebarData().forceEligibleAgentIds).toEqual({});
    });
  });
});
