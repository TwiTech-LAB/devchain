import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ChatSidebar } from './ChatSidebar';
import { packChatSidebarProps, type FlatChatSidebarProps } from './ChatSidebar.test-helpers';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';

const mockToast = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/ui/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onSelect} disabled={disabled} data-testid="context-menu-item">
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuSub: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuSubContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuRadioGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuRadioItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuCheckboxItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuLabel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

type GlobalWithDOMRect = typeof globalThis & {
  DOMRect?: typeof DOMRect;
};

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

const agent: AgentOrGuest = {
  id: 'agent-1',
  name: 'Alpha',
  profileId: 'profile-1',
  isProjectOwner: false,
};

function renderSidebar(overrides: Partial<FlatChatSidebarProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const defaultProps: FlatChatSidebarProps = {
    projectId: 'project-1',
    agents: [agent],
    guests: [],
    agentPresence: {},
    presenceReady: true,
    offlineAgents: [agent],
    agentsWithSessions: [],
    agentsLoading: false,
    agentsError: false,
    launchingAgentIds: {},
    restartingAgentId: null,
    startingAll: false,
    terminatingAll: false,
    selectedAgentId: null,
    hasSelectedProject: true,
    onSelectAgent: jest.fn(),
    onStartAllAgents: jest.fn(),
    onTerminateAllConfirm: jest.fn(),
    onLaunchSession: jest.fn(async () => ({ id: 'session-1' })),
    onRestartSession: jest.fn(async () => {}),
    onTerminateConfirm: jest.fn(),
    onReleaseHeldMessages: jest.fn(),
    releasingHeldAgentId: null,
    onForceDelivery: jest.fn(),
    forcingAgentId: null,
    getProviderForAgent: jest.fn(() => null),
    pendingRestartAgentIds: new Set<string>(),
    validatedPresets: [],
    activePreset: null,
    onApplyPreset: jest.fn(),
    applyingPreset: false,
    onSwitchConfig: jest.fn(),
    fetchProviderConfigsForProfile: jest.fn(async () => []),
    updatingConfigAgentIds: {},
    onCloneAgent: jest.fn(),
    onDeleteAgent: jest.fn(),
    pendingDeleteAgentId: null,
    onAddTeamAgent: jest.fn(),
    onEditTeam: jest.fn(),
  };

  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ChatSidebar {...packChatSidebarProps({ ...defaultProps, ...overrides })} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ChatSidebar header controls', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockToast.mockClear();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  // Layer: UI component (jsdom). Rendering ChatSidebar is the cheapest reliable
  // proof of React ownership and MAIN-only registration; browser pixel geometry
  // and hit-testing are covered by the dedicated Playwright spec.
  it('mounts the bus in the unchanged MAIN padding wrapper and registers only the MAIN row', () => {
    renderSidebar();

    const wrapper = screen.getByTestId('chat-main-agents-wrapper');
    const mainRegion = wrapper.querySelector('#chat-main-agents');
    const overlay = screen.getByTestId('agent-event-bus-svg');
    const lane = screen.getByLabelText('Agent event bus controls');
    const mainRow = screen.getByRole('listitem', { name: /Open terminal for Alpha/i });

    expect(mainRegion?.parentElement).toBe(wrapper);
    expect(overlay.parentElement).toBe(wrapper);
    expect(lane.parentElement).toBe(wrapper);
    expect(mainRegion).not.toContainElement(overlay);
    expect(mainRow).toHaveAttribute('data-agent-event-bus-key', 'all:agent-1');
    expect(mainRow).toHaveAttribute('data-agent-event-bus-agent-id', 'agent-1');
    expect(mainRow).not.toHaveAttribute('data-agent-event-bus-team-id');
    expect(wrapper.querySelectorAll('[data-agent-event-bus-agent-id]')).toHaveLength(1);
  });

  it('renders the agents panel actions with theme-safe bulk control styles and preset options', async () => {
    const onStartAllAgents = jest.fn();
    const onTerminateAllConfirm = jest.fn();

    renderSidebar({
      offlineAgents: [agent],
      agentsWithSessions: [agent],
      onStartAllAgents,
      onTerminateAllConfirm,
      validatedPresets: [
        {
          preset: { name: 'Tier A', agentConfigs: [] },
          available: true,
          missingConfigs: [],
        },
      ],
    });

    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select preset' })).toBeInTheDocument();

    const startButton = screen.getByRole('button', { name: /Start \(1\)/i });
    const stopButton = screen.getByRole('button', { name: /Stop \(1\)/i });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });

    expect(startButton).toHaveAttribute('title', 'Launch sessions for all offline agents');
    expect(stopButton).toHaveAttribute('title', 'Terminate all running sessions');

    fireEvent.click(screen.getByRole('button', { name: 'Select preset' }));
    expect(await screen.findByText('Presets')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tier A/i })).toBeEnabled();

    fireEvent.click(startButton);
    fireEvent.click(stopButton);

    expect(onStartAllAgents).toHaveBeenCalledTimes(1);
    expect(onTerminateAllConfirm).toHaveBeenCalledTimes(1);
  });

  it.each(['actions running', 'presence unresolved'])(
    'disables bulk controls for %s',
    async (reason) => {
      renderSidebar({
        offlineAgents: [agent],
        agentsWithSessions: [agent],
        startingAll: reason === 'actions running',
        terminatingAll: reason === 'actions running',
        presenceReady: reason !== 'presence unresolved',
      });

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
      });

      const startButton = screen.getByRole('button', { name: /Start \(1\)/i });
      const stopButton = screen.getByRole('button', { name: /Stop \(1\)/i });

      expect(startButton).toBeDisabled();
      expect(stopButton).toBeDisabled();
      if (reason === 'actions running') {
        expect(startButton.querySelector('.animate-spin')).not.toBeNull();
        expect(stopButton.querySelector('.animate-spin')).not.toBeNull();
      }
    },
  );
});

describe('ChatSidebar agent grouping toggle', () => {
  const originalFetch = global.fetch;
  const PROJECT_ID = 'project-1';
  const TAB_KEY = `devchain:chat:agentTab:${PROJECT_ID}`;

  function mockFetchWithTeams(teamCount: number) {
    const teams = Array.from({ length: teamCount }, (_, i) => ({
      id: `team-${i + 1}`,
      name: `Team ${i + 1}`,
      description: null,
      teamLeadAgentId: null,
      teamLeadAgentName: null,
      memberCount: 1,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }));
    return jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/teams?')) {
        return {
          ok: true,
          json: async () => ({ items: teams, total: teams.length, limit: 50, offset: 0 }),
        };
      }
      if (url.startsWith('/api/teams/')) {
        return {
          ok: true,
          json: async () => ({
            ...teams[0],
            members: [
              {
                agentId: 'agent-1',
                agentName: 'Alpha',
                isLead: false,
                createdAt: '2024-01-01T00:00:00.000Z',
              },
            ],
            profileIds: [],
            profileConfigSelections: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    mockToast.mockClear();
    window.localStorage.removeItem(TAB_KEY);
    global.fetch = mockFetchWithTeams(0);
  });

  afterEach(() => {
    window.localStorage.removeItem(TAB_KEY);
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it.each([
    { stored: null, teams: 0, selected: 'All' },
    { stored: null, teams: 1, selected: 'Teams' },
    { stored: 'teams', teams: 0, selected: 'Teams' },
    { stored: 'all', teams: 1, selected: 'All' },
    { stored: 'invalid-value', teams: 1, selected: 'Teams' },
  ])(
    'initializes tab=$selected with stored=$stored teams=$teams',
    async ({ stored, teams, selected }) => {
      if (stored !== null) window.localStorage.setItem(TAB_KEY, stored);
      global.fetch = mockFetchWithTeams(teams);
      renderSidebar();
      await waitFor(() =>
        expect(screen.getByRole('tab', { name: selected })).toHaveAttribute(
          'aria-selected',
          'true',
        ),
      );
      expect(
        screen.getByRole('tab', { name: selected === 'All' ? 'Teams' : 'All' }),
      ).toHaveAttribute('aria-selected', 'false');
      if (stored === 'teams' && teams === 0)
        expect(await screen.findByText(/No teams configured/i)).toBeInTheDocument();
    },
  );

  it('switches to Teams, persists to project-scoped key, and renders no-teams state', async () => {
    global.fetch = mockFetchWithTeams(0);
    renderSidebar();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });

    const allTab = screen.getByRole('tab', { name: 'All' });

    await act(async () => {
      allTab.focus();
      fireEvent.keyDown(allTab, { key: 'ArrowRight', code: 'ArrowRight' });
    });

    await waitFor(() => {
      expect(screen.getByText(/No teams configured/i)).toBeInTheDocument();
    });
    expect(window.localStorage.getItem(TAB_KEY)).toBe('teams');
    expect(screen.getByRole('link', { name: /Open Teams/i })).toHaveAttribute('href', '/teams');
    expect(screen.queryByText('MAIN TEAMS')).not.toBeInTheDocument();
    expect(screen.getByText('STANDALONE')).toBeInTheDocument();
    expect(screen.queryByText('No Team')).not.toBeInTheDocument();
  });

  it('falls back to All tab and shows a toast when the Teams query fails', async () => {
    window.localStorage.setItem(TAB_KEY, 'teams');
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/teams?')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ message: 'Teams service unavailable' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderSidebar();

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Unable to load teams view',
        description: 'Teams service unavailable Falling back to All agents.',
        variant: 'destructive',
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });
  });
});

describe('ChatSidebar canonical agent rendering', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders Project Owner first, then name and stable ID order, with agent identity selected', async () => {
    const onSelectAgent = jest.fn();
    const unorderedAgents: AgentOrGuest[] = [
      { id: 'agent-z', name: 'Alpha', type: 'agent', isProjectOwner: false },
      { id: 'agent-owner', name: 'Zulu', type: 'agent', isProjectOwner: true },
      { id: 'agent-a', name: 'Alpha', type: 'agent', isProjectOwner: false },
    ];

    renderSidebar({
      agents: unorderedAgents,
      offlineAgents: unorderedAgents,
      selectedAgentId: 'agent-a',
      onSelectAgent,
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });
    const rows = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Open terminal for Zulu (offline)',
      'Open terminal for Alpha (offline)',
      'Open terminal for Alpha (offline)',
    ]);
    expect(rows.map((row) => row.dataset.agentEventBusAgentId)).toEqual([
      'agent-owner',
      'agent-a',
      'agent-z',
    ]);
    expect(rows[1]).toHaveAttribute('aria-current', 'true');

    fireEvent.click(rows[2]);
    expect(onSelectAgent).toHaveBeenCalledWith('agent-z');
  });

  it('keeps the existing agents load-error state visible', async () => {
    renderSidebar({
      agents: [],
      offlineAgents: [],
      agentsError: true,
      agentsLoading: false,
    });

    expect(await screen.findByText('Failed to load agents. Please try again.')).toBeInTheDocument();
  });
});

describe('ChatSidebar activity badges', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('shows only the busy timer text while preserving the accessible busy label', async () => {
    renderSidebar({
      agentPresence: {
        [agent.id]: {
          online: true,
          sessionId: 'session-1',
          activityState: 'busy',
          busySince: new Date(Date.now()).toISOString(),
        },
      } as unknown as FlatChatSidebarProps['agentPresence'],
      agentsWithSessions: [agent],
      offlineAgents: [],
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });

    const badge = screen.getByLabelText(/Busy for/i);
    expect(badge).toHaveTextContent(/^\d+s$/);
    expect(badge).not.toHaveTextContent(/Busy/i);
  });

  it('shows only whole minutes after the busy timer reaches one minute', async () => {
    renderSidebar({
      agentPresence: {
        [agent.id]: {
          online: true,
          sessionId: 'session-1',
          activityState: 'busy',
          busySince: new Date(Date.now() - 90_000).toISOString(),
        },
      } as unknown as FlatChatSidebarProps['agentPresence'],
      agentsWithSessions: [agent],
      offlineAgents: [],
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });

    const badge = screen.getByLabelText('Busy for 1m');
    expect(badge).toHaveTextContent(/^1m$/);
  });

  // Layer: UI component (jsdom). Rendering the sidebar is the cheapest reliable
  // proof that idle presence produces no activity marker in the agent list.
  it('hides the activity badge while an online agent is idle', async () => {
    renderSidebar({
      agentPresence: {
        [agent.id]: {
          online: true,
          sessionId: 'session-1',
          activityState: 'idle',
        },
      } as unknown as FlatChatSidebarProps['agentPresence'],
      agentsWithSessions: [agent],
      offlineAgents: [],
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });

    expect(screen.queryByLabelText('Idle')).not.toBeInTheDocument();
    expect(screen.queryByText('Idle')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Busy for/i)).not.toBeInTheDocument();
  });
});

describe('ChatSidebar team lead-as-header rendering', () => {
  const originalFetch = global.fetch;
  const TAB_KEY = 'devchain:chat:agentTab:project-1';
  const TEAM_GROUPS_KEY = 'devchain:chatSidebar:teamGroups';

  const agentLead: AgentOrGuest = {
    id: 'agent-lead',
    name: 'Lead Agent',
    profileId: 'profile-1',
    isProjectOwner: false,
  };

  const agentMember: AgentOrGuest = {
    id: 'agent-member',
    name: 'Member Agent',
    profileId: 'profile-1',
    isProjectOwner: false,
  };

  const agentIndependent: AgentOrGuest = {
    id: 'agent-independent',
    name: 'Independent Agent',
    profileId: 'profile-1',
    isProjectOwner: false,
  };

  const guestAgent: AgentOrGuest = {
    id: 'guest-1',
    name: 'Guest Agent',
    profileId: 'profile-guest',
    isProjectOwner: false,
  };

  function mockTeamFetch(opts: {
    teamLeadAgentId: string | null;
    members: Array<{ agentId: string; agentName: string }>;
    teamName?: string;
    maxMembers?: number;
    maxConcurrentTasks?: number;
    allowTeamLeadCreateAgents?: boolean;
  }) {
    const teamName = opts.teamName ?? 'Alpha Team';
    const maxMembers = opts.maxMembers ?? 5;
    const maxConcurrentTasks = opts.maxConcurrentTasks ?? 3;
    const allowTeamLeadCreateAgents = opts.allowTeamLeadCreateAgents ?? true;
    return jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/teams?')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'team-1',
                name: teamName,
                description: null,
                teamLeadAgentId: opts.teamLeadAgentId,
                teamLeadAgentName: opts.teamLeadAgentId
                  ? (opts.members.find((m) => m.agentId === opts.teamLeadAgentId)?.agentName ??
                    null)
                  : null,
                maxMembers,
                maxConcurrentTasks,
                allowTeamLeadCreateAgents,
                memberCount: opts.members.length,
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          }),
        };
      }
      if (url.startsWith('/api/teams/')) {
        return {
          ok: true,
          json: async () => ({
            id: 'team-1',
            name: teamName,
            description: null,
            teamLeadAgentId: opts.teamLeadAgentId,
            maxMembers,
            maxConcurrentTasks,
            allowTeamLeadCreateAgents,
            members: opts.members.map((m) => ({
              ...m,
              isLead: m.agentId === opts.teamLeadAgentId,
              createdAt: '2024-01-01T00:00:00.000Z',
            })),
            profileIds: [],
            profileConfigSelections: [],
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    window.localStorage.removeItem(TAB_KEY);
    window.localStorage.removeItem(TEAM_GROUPS_KEY);
  });

  afterEach(() => {
    window.localStorage.removeItem(TAB_KEY);
    window.localStorage.removeItem(TEAM_GROUPS_KEY);
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('renders lead as primary row with team name sub-label and chevron when team has lead + members', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: 'agent-lead',
      members: [
        { agentId: 'agent-lead', agentName: 'Lead Agent' },
        { agentId: 'agent-member', agentName: 'Member Agent' },
      ],
    });

    renderSidebar({
      agents: [agentLead, agentMember],
      offlineAgents: [agentLead, agentMember],
      onAddTeamAgent: jest.fn(),
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'true');
    });

    await waitFor(() => {
      expect(screen.getByText(/Alpha Team/)).toBeInTheDocument();
    });

    const teamCard = screen.getByText(/Alpha Team/).closest('[class*="shadow-sm"]');
    expect(teamCard).toHaveClass('border-border', 'bg-card/80', 'shadow-sm');
    const teamMetaLine = screen.getByText('Alpha Team · 1 member').parentElement;
    const addButton = screen.getByRole('button', { name: /Add agent to Alpha Team/i });
    const toggleButton = screen.getByLabelText(/Toggle Alpha Team members/);
    expect(teamMetaLine).toContainElement(addButton);
    expect(teamMetaLine).toContainElement(toggleButton);

    {
      await waitFor(() => {
        expect(screen.getByText(/Alpha Team/)).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByLabelText(/Open terminal for Member Agent/i)).toBeInTheDocument();
      });
    }
  });

  it('renders secondary Teams-mode section headers without adding section collapse controls', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: 'agent-lead',
      members: [
        { agentId: 'agent-lead', agentName: 'Lead Agent' },
        { agentId: 'agent-member', agentName: 'Member Agent' },
      ],
    });

    renderSidebar({
      agents: [agentLead, agentMember, agentIndependent],
      guests: [guestAgent],
      offlineAgents: [agentLead, agentMember, agentIndependent],
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'true');
    });

    expect(screen.queryByText('TEAMS')).not.toBeInTheDocument();
    expect(screen.queryByText('1 team')).not.toBeInTheDocument();
    expect(screen.getByText('STANDALONE')).toBeInTheDocument();
    expect(screen.getByText('1 agent')).toBeInTheDocument();
    expect(screen.getByText('GUESTS')).toBeInTheDocument();
    expect(screen.getByText('1 guest')).toBeInTheDocument();
    expect(screen.queryByText('No Team')).not.toBeInTheDocument();
    expect(screen.getByText('STANDALONE').closest('button')).toBeNull();
    expect(screen.getByText('GUESTS').closest('button')).toBeNull();
    expect(screen.getByRole('button', { name: /^MAIN$/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('hides chevron on lone-lead team but shows team name sub-label', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: 'agent-lead',
      members: [{ agentId: 'agent-lead', agentName: 'Lead Agent' }],
    });

    renderSidebar({ agents: [agentLead], offlineAgents: [agentLead] });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'true');
    });

    await waitFor(() => {
      expect(screen.getByText(/Alpha Team/)).toBeInTheDocument();
    });

    expect(screen.queryByLabelText(/Toggle Alpha Team members/)).not.toBeInTheDocument();
  });

  it('opens no-lead team groups by default and preserves toggle behavior', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: null,
      members: [
        { agentId: 'agent-lead', agentName: 'Lead Agent' },
        { agentId: 'agent-member', agentName: 'Member Agent' },
      ],
      teamName: 'Legacy Team',
    });

    const { container } = renderSidebar({
      agents: [agentLead, agentMember],
      offlineAgents: [agentLead, agentMember],
    });

    await waitFor(() => {
      expect(screen.getByText('Legacy Team')).toBeInTheDocument();
    });

    const toggleBtn = screen.getByRole('button', { name: /Toggle Legacy Team members/i });
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

    expect(container.querySelectorAll('button button')).toHaveLength(0);
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('preserves the team bucket while sorting its agent collection canonically', async () => {
    const teamAgents: AgentOrGuest[] = [
      { id: 'agent-z', name: 'Alpha', type: 'agent', isProjectOwner: false },
      { id: 'agent-owner', name: 'Zulu', type: 'agent', isProjectOwner: true },
      { id: 'agent-a', name: 'Alpha', type: 'agent', isProjectOwner: false },
    ];
    global.fetch = mockTeamFetch({
      teamLeadAgentId: null,
      members: [
        { agentId: 'agent-z', agentName: 'Alpha' },
        { agentId: 'agent-owner', agentName: 'Zulu' },
        { agentId: 'agent-a', agentName: 'Alpha' },
      ],
    }) as unknown as typeof fetch;

    renderSidebar({ agents: teamAgents, offlineAgents: teamAgents });
    fireEvent.click(await screen.findByRole('tab', { name: 'Teams' }));

    const rows = within(
      await screen.findByRole('list', { name: 'Alpha Team agents' }),
    ).getAllByRole('listitem');
    expect(rows.map((row) => row.dataset.agentEventBusAgentId)).toEqual([
      'agent-owner',
      'agent-a',
      'agent-z',
    ]);
  });

  it('preserves persisted collapsed team group state', async () => {
    window.localStorage.setItem(TEAM_GROUPS_KEY, JSON.stringify({ 'team-1': true }));
    global.fetch = mockTeamFetch({
      teamLeadAgentId: 'agent-lead',
      members: [
        { agentId: 'agent-lead', agentName: 'Lead Agent' },
        { agentId: 'agent-member', agentName: 'Member Agent' },
      ],
    });

    renderSidebar({ agents: [agentLead, agentMember], offlineAgents: [agentLead, agentMember] });

    await waitFor(() => {
      expect(screen.getByText(/Alpha Team/)).toBeInTheDocument();
    });

    expect(screen.getByLabelText(/Toggle Alpha Team members/)).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByLabelText(/Open terminal for Member Agent/i)).not.toBeInTheDocument();
  });

  it.each([
    [true, 8, 4],
    [false, 6, 2],
  ] as const)(
    'passes creation policy=%s in team edit payload',
    async (allow, maxMembers, maxConcurrentTasks) => {
      global.fetch = mockTeamFetch({
        teamLeadAgentId: 'agent-lead',
        members: [{ agentId: 'agent-lead', agentName: 'Lead Agent' }],
        maxMembers,
        maxConcurrentTasks,
        allowTeamLeadCreateAgents: allow,
      });

      const onEditTeam = jest.fn();
      renderSidebar({
        agents: [agentLead],
        offlineAgents: [agentLead],
        onEditTeam,
      });

      await waitFor(() => {
        expect(screen.getByText(/Alpha Team/)).toBeInTheDocument();
      });

      const editButtons = screen.getAllByText('Edit team');
      fireEvent.click(editButtons[0]);

      expect(onEditTeam).toHaveBeenCalledWith({
        teamId: 'team-1',
        teamName: 'Alpha Team',
        maxMembers,
        maxConcurrentTasks,
        allowTeamLeadCreateAgents: allow,
      });
    },
  );

  // Layer: UI component (jsdom). Rendering the sidebar with two mocked team
  // responses is the cheapest reliable proof that React preserves both mounted
  // copies and assigns stable team-scoped keys.
  it('retains duplicate mounted copies with stable team-scoped registration keys', async () => {
    const sharedAgent = agentMember;
    const teams = [
      { id: 'team-a', name: 'Team A' },
      { id: 'team-b', name: 'Team B' },
    ];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/teams?')) {
        return {
          ok: true,
          json: async () => ({
            items: teams.map((team) => ({
              ...team,
              description: null,
              teamLeadAgentId: null,
              teamLeadAgentName: null,
              maxMembers: 5,
              maxConcurrentTasks: 3,
              allowTeamLeadCreateAgents: false,
              memberCount: 1,
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            })),
            total: teams.length,
            limit: 50,
            offset: 0,
          }),
        };
      }
      const team = teams.find((candidate) => url.endsWith(`/api/teams/${candidate.id}`));
      if (team) {
        return {
          ok: true,
          json: async () => ({
            ...team,
            projectId: 'project-1',
            description: null,
            teamLeadAgentId: null,
            teamLeadAgentName: null,
            maxMembers: 5,
            maxConcurrentTasks: 3,
            allowTeamLeadCreateAgents: false,
            members: [
              {
                agentId: sharedAgent.id,
                agentName: sharedAgent.name,
                isLead: false,
                createdAt: '2024-01-01T00:00:00.000Z',
              },
            ],
            profileIds: [],
            profileConfigSelections: [],
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const { container } = renderSidebar({
      agents: [sharedAgent],
      offlineAgents: [sharedAgent],
    });

    await waitFor(() => {
      expect(
        screen.getAllByRole('listitem', { name: /Open terminal for Member Agent/i }),
      ).toHaveLength(2);
    });

    const anchors = Array.from(
      container.querySelectorAll<HTMLElement>('[data-agent-event-bus-agent-id="agent-member"]'),
    );
    expect(anchors.map((row) => row.dataset.agentEventBusKey)).toEqual([
      'team-a:agent-member',
      'team-b:agent-member',
    ]);
    expect(anchors.map((row) => row.dataset.agentEventBusTeamId)).toEqual(['team-a', 'team-b']);
  });
});

describe('ChatSidebar human-held message badges', () => {
  const originalFetch = global.fetch;

  const mainAgent: AgentOrGuest = {
    id: 'agent-1',
    name: 'Alpha',
    profileId: 'profile-1',
    isProjectOwner: false,
  };

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('maps a positive held count onto the main agent row badge and accessible name', async () => {
    const onReleaseHeldMessages = jest.fn();
    renderSidebar({
      agents: [mainAgent],
      offlineAgents: [mainAgent],
      humanHeldMessageCounts: { [mainAgent.id]: 2 },
      humanHeldReleaseEligibleAgentIds: { [mainAgent.id]: true },
      onReleaseHeldMessages,
    });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });

    expect(
      screen.getByRole('listitem', {
        name: 'Open terminal for Alpha (offline), 2 messages waiting for you to finish typing',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('2 waiting')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: `Release 2 queued messages for ${mainAgent.name}` }),
    );
    expect(onReleaseHeldMessages).toHaveBeenCalledWith(mainAgent.id);
  });
});

describe('ChatSidebar guest compatibility', () => {
  const originalFetch = global.fetch;

  const guestAgent: AgentOrGuest = {
    id: 'guest-1',
    name: 'Guest Agent',
    profileId: null,
    isProjectOwner: false,
    type: 'guest',
  };

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('keeps guest rows non-actionable with theme-safe guest styling', async () => {
    const onSelectAgent = jest.fn();
    renderSidebar({
      agents: [],
      offlineAgents: [],
      guests: [guestAgent],
      onSelectAgent,
    });

    await waitFor(() => {
      expect(screen.getByText('GUESTS')).toBeInTheDocument();
    });

    const guestRow = screen.getByRole('listitem', { name: 'Guest: Guest Agent (online)' });
    expect(guestRow).toHaveAttribute('type', 'button');

    expect(guestRow).not.toHaveAttribute('data-agent-event-bus-agent-id');

    fireEvent.click(guestRow);
    expect(onSelectAgent).not.toHaveBeenCalled();

    const badge = screen.getByLabelText('Guest type');
    expect(badge).toHaveTextContent('Guest');
  });
});

describe('ChatSidebar unlogged time markers', () => {
  const originalFetch = global.fetch;
  const guestAgent: AgentOrGuest = {
    id: 'guest-1',
    name: 'Guest Agent',
    profileId: null,
    isProjectOwner: false,
    type: 'guest',
  };

  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('marks main agent rows on the All path with the unlogged phrase', () => {
    renderSidebar({ unloggedTimeMinutes: { 'agent-1': 10 } });

    const row = screen.getByRole('listitem', {
      name: 'Open terminal for Alpha (offline), 10m not logged to an Epic.',
    });
    expect(row.querySelector('[data-unlogged-time-marker]')).not.toBeNull();
  });

  it('marks main agent rows on the Teams path', async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/teams?')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'team-1',
                name: 'Team 1',
                description: null,
                teamLeadAgentId: null,
                teamLeadAgentName: null,
                memberCount: 1,
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          }),
        };
      }
      if (url.startsWith('/api/teams/')) {
        return {
          ok: true,
          json: async () => ({
            id: 'team-1',
            name: 'Team 1',
            description: null,
            teamLeadAgentId: null,
            teamLeadAgentName: null,
            memberCount: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            members: [
              {
                agentId: 'agent-1',
                agentName: 'Alpha',
                isLead: false,
                createdAt: '2024-01-01T00:00:00.000Z',
              },
            ],
            profileIds: [],
            profileConfigSelections: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    renderSidebar({ unloggedTimeMinutes: { 'agent-1': 90 } });

    const row = await screen.findByRole('listitem', {
      name: 'Open terminal for Alpha (offline), 1h 30m not logged to an Epic.',
    });
    expect(row.querySelector('[data-unlogged-time-marker]')).not.toBeNull();
  });

  it('never marks guest rows even when their ids carry minutes', async () => {
    renderSidebar({
      guests: [guestAgent],
      unloggedTimeMinutes: { 'guest-1': 19, 'agent-1': 9 },
    });

    const guestRow = await screen.findByRole('listitem', { name: 'Guest: Guest Agent (online)' });
    expect(guestRow.textContent).not.toContain('not logged');
    expect(guestRow.querySelector('span.pointer-events-none')).toBeNull();
    // A main agent below ten whole minutes stays unmarked too.
    const mainRow = screen.getByRole('listitem', { name: 'Open terminal for Alpha (offline)' });
    expect(mainRow.querySelector('span.pointer-events-none')).toBeNull();
  });
});
