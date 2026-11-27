import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ChatSidebar } from './ChatSidebar';
import { TEAM_FOLD_OVERRIDES_KEY } from './team-fold';
import { packChatSidebarProps, type FlatChatSidebarProps } from './ChatSidebar.test-helpers';
import { chatQueryKeys, type AgentOrGuest } from '@/ui/hooks/useChatQueries';
import { agentQueryKeys } from '@/ui/lib/agents';

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
  type: 'agent',
  modelOverride: null,
  effortOverride: null,
  id: 'agent-1',
  name: 'Alpha',
  profileId: 'profile-1',
  isProjectOwner: false,
  disabled: false,
};

function renderSidebar(overrides: Partial<FlatChatSidebarProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const defaultProps: FlatChatSidebarProps = {
    projectId: 'project-1',
    agents: [agent],
    guests: [],
    agentPresence: {},
    presenceReady: true,
    presenceSettled: true,
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
    updatingConfigAgentIds: {},
    onCloneAgent: jest.fn(),
    onDeleteAgent: jest.fn(),
    pendingDeleteAgentId: null,
    onAddTeamAgent: jest.fn(),
    onEditTeam: jest.fn(),
  };

  const tree = (next: Partial<FlatChatSidebarProps>) => {
    const props = { ...defaultProps, ...overrides, ...next };
    // ChatPage passes the presence map and roster its query cache holds; do the
    // same here. Each render counts as a fresh response of both.
    if (props.projectId) {
      const presenceKey = chatQueryKeys.agentPresence(props.projectId);
      queryClient.setQueryData(presenceKey, props.agentPresence);
      queryClient.setQueryData(agentQueryKeys.withGuests(props.projectId), { items: props.agents });
      props.agentPresence = queryClient.getQueryData(presenceKey) ?? props.agentPresence;
    }
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ChatSidebar {...packChatSidebarProps(props)} />
        </QueryClientProvider>
      </MemoryRouter>
    );
  };
  const utils = render(tree({}));
  return {
    ...utils,
    queryClient,
    rerenderSidebar: (next: Partial<FlatChatSidebarProps>) => utils.rerender(tree(next)),
  };
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
  // proof of React ownership and main-row-only registration; browser pixel geometry
  // and hit-testing are covered by the dedicated Playwright spec.
  it('mounts the bus in the unchanged padding wrapper and registers only the main row', async () => {
    renderSidebar();
    await screen.findByRole('list', { name: 'Agents' });

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
    expect(screen.queryByRole('button', { name: /^MAIN$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();

    const startButton = screen.getByRole('button', { name: /Start \(1\)/i });
    const stopButton = screen.getByRole('button', { name: /Stop \(1\)/i });

    await screen.findByRole('list', { name: 'Agents' });

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

      await screen.findByRole('list', { name: 'Agents' });

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

describe('ChatSidebar team view selection', () => {
  const originalFetch = global.fetch;

  function teamsFetch(teamCount: number, teamsList?: Promise<unknown>) {
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
        await teamsList;
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
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('shows the flat list without a no-teams box when the project has no teams', async () => {
    global.fetch = teamsFetch(0);
    renderSidebar();

    expect(await screen.findByRole('list', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.queryByText(/No teams configured/i)).not.toBeInTheDocument();
    expect(screen.queryByText('STANDALONE')).not.toBeInTheDocument();
  });

  it('shows the team view and never the flat list first when the project has teams', async () => {
    let releaseTeams!: () => void;
    global.fetch = teamsFetch(1, new Promise<void>((resolve) => (releaseTeams = resolve)));
    renderSidebar();

    expect(screen.queryByRole('list', { name: 'Agents' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Open terminal for Alpha/i)).not.toBeInTheDocument();

    await act(async () => releaseTeams());
    expect(await screen.findByText('Team 1')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Agents' })).not.toBeInTheDocument();
  });

  it('shows the flat list and one toast when the teams query fails', async () => {
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

    const { rerenderSidebar } = renderSidebar();

    expect(await screen.findByRole('list', { name: 'Agents' })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Unable to load teams view',
        description: 'Teams service unavailable Showing the agent list without teams.',
        variant: 'destructive',
      });
    });
    rerenderSidebar({ selectedAgentId: 'agent-1' });
    expect(mockToast).toHaveBeenCalledTimes(1);
  });

  it('shows the agents load error in a project with teams', async () => {
    global.fetch = teamsFetch(1);
    renderSidebar({ agents: [], offlineAgents: [], agentsError: true });

    expect(await screen.findByText('Failed to load agents. Please try again.')).toBeInTheDocument();
  });

  it('shows the agents load error while a team detail request is still pending', async () => {
    const listFetch = teamsFetch(1);
    const detailRequested = jest.fn();
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/teams/')) {
        detailRequested();
        return new Promise(() => {});
      }
      return listFetch(input);
    }) as unknown as typeof fetch;
    renderSidebar({ agents: [], offlineAgents: [], agentsError: true });

    await waitFor(() => expect(detailRequested).toHaveBeenCalled());
    expect(screen.getByText('Failed to load agents. Please try again.')).toBeInTheDocument();
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
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-z',
        name: 'Alpha',
        type: 'agent',
        isProjectOwner: false,
        disabled: false,
      },
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-owner',
        name: 'Zulu',
        type: 'agent',
        isProjectOwner: true,
        disabled: false,
      },
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-a',
        name: 'Alpha',
        type: 'agent',
        isProjectOwner: false,
        disabled: false,
      },
    ];

    renderSidebar({
      agents: unorderedAgents,
      offlineAgents: unorderedAgents,
      selectedAgentId: 'agent-a',
      onSelectAgent,
    });

    await screen.findByRole('list', { name: 'Agents' });
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

    await screen.findByRole('list', { name: 'Agents' });

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

    await screen.findByRole('list', { name: 'Agents' });

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

    await screen.findByRole('list', { name: 'Agents' });

    expect(screen.queryByLabelText('Idle')).not.toBeInTheDocument();
    expect(screen.queryByText('Idle')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Busy for/i)).not.toBeInTheDocument();
  });
});

describe('ChatSidebar team lead-as-header rendering', () => {
  const originalFetch = global.fetch;
  const OVERRIDES_KEY = TEAM_FOLD_OVERRIDES_KEY;
  const LEGACY_TEAM_GROUPS_KEY = 'devchain:chatSidebar:teamGroups';
  const online = (...ids: string[]) =>
    Object.fromEntries(
      ids.map((id) => [id, { online: true, sessionId: `session-${id}` }]),
    ) as unknown as FlatChatSidebarProps['agentPresence'];
  const memberToggle = () => screen.getByLabelText(/Toggle Alpha Team members/);
  const storedOverrides = () => JSON.parse(window.localStorage.getItem(OVERRIDES_KEY) ?? '{}');

  const agentLead: AgentOrGuest = {
    type: 'agent',
    modelOverride: null,
    effortOverride: null,
    id: 'agent-lead',
    name: 'Lead Agent',
    profileId: 'profile-1',
    isProjectOwner: false,
    disabled: false,
  };

  const agentMember: AgentOrGuest = {
    type: 'agent',
    modelOverride: null,
    effortOverride: null,
    id: 'agent-member',
    name: 'Member Agent',
    profileId: 'profile-1',
    isProjectOwner: false,
    disabled: false,
  };

  const agentIndependent: AgentOrGuest = {
    type: 'agent',
    modelOverride: null,
    effortOverride: null,
    id: 'agent-independent',
    name: 'Independent Agent',
    profileId: 'profile-1',
    isProjectOwner: false,
    disabled: false,
  };

  const guestAgent: AgentOrGuest = {
    type: 'agent',
    modelOverride: null,
    effortOverride: null,
    id: 'guest-1',
    name: 'Guest Agent',
    profileId: 'profile-guest',
    isProjectOwner: false,
    disabled: false,
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
    window.localStorage.removeItem(OVERRIDES_KEY);
  });

  afterEach(() => {
    window.localStorage.removeItem(OVERRIDES_KEY);
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
      offlineAgents: [agentLead],
      agentPresence: online('agent-member'),
      onAddTeamAgent: jest.fn(),
    });

    await screen.findByText(/Alpha Team/);

    const teamCard = screen.getByText(/Alpha Team/).closest('[class*="shadow-sm"]');
    expect(teamCard).toHaveClass('border-border', 'bg-card/80', 'shadow-sm');
    const teamMetaLine = screen.getByText('Alpha Team').parentElement;
    const addButton = screen.getByRole('button', { name: /Add agent to Alpha Team/i });
    const toggleButton = screen.getByLabelText(/Toggle Alpha Team members/);
    expect(teamMetaLine).toContainElement(addButton);
    expect(teamMetaLine).toContainElement(toggleButton);
    expect(teamMetaLine).not.toHaveTextContent(/member/i);

    // The add and fold controls share one right-aligned box, so they keep their place whether
    // or not the dots fill the row.
    const controls = within(teamMetaLine!).getByTestId('team-header-controls');
    expect(controls).toHaveClass('ml-auto');
    expect(controls).toContainElement(addButton);
    expect(controls).toContainElement(toggleButton);

    // An unfolded team shows its rows and no dots; folding it shows the dots in the header.
    expect(screen.getByLabelText(/Open terminal for Member Agent/i)).toBeInTheDocument();
    expect(screen.queryByTestId('team-status-dots')).not.toBeInTheDocument();
    fireEvent.click(toggleButton);
    expect(teamMetaLine).toContainElement(screen.getByTestId('team-status-dots'));
    expect(controls).toContainElement(toggleButton);
  });

  it('keeps the quick-add of a no-lead team in the right-aligned controls box', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: null,
      members: [{ agentId: 'agent-member', agentName: 'Member Agent' }],
      teamName: 'Legacy Team',
    });

    renderSidebar({
      agents: [agentMember],
      agentPresence: online('agent-member'),
      onAddTeamAgent: jest.fn(),
    });

    const addButton = await screen.findByRole('button', { name: /Add agent to Legacy Team/i });
    const controls = screen.getByTestId('team-header-controls');
    expect(controls).toHaveClass('ml-auto');
    expect(controls).toContainElement(addButton);
  });

  // Layer: UI component (Jest + Testing Library). Wiring the dots into the header, the click
  // isolation from the fold and the accessible names live in the React tree; jsdom covers
  // them. Layout is checked in the browser test in chat-agent-event-bus.spec.ts.
  describe('status dots', () => {
    const agentZed: AgentOrGuest = { ...agentMember, id: 'agent-zed', name: 'Zed Agent' };
    const agentOff: AgentOrGuest = { ...agentMember, id: 'agent-off', name: 'Off Agent' };
    const agentGone: AgentOrGuest = {
      ...agentMember,
      id: 'agent-gone',
      name: 'Gone Agent',
      disabled: true,
    };
    const dotTeam = {
      teamLeadAgentId: 'agent-lead',
      members: [
        { agentId: 'agent-zed', agentName: 'Zed Agent' },
        { agentId: 'agent-gone', agentName: 'Gone Agent' },
        { agentId: 'agent-lead', agentName: 'Lead Agent' },
        { agentId: 'agent-member', agentName: 'Member Agent' },
        { agentId: 'agent-off', agentName: 'Off Agent' },
      ],
    };
    const dotPresence = {
      'agent-lead': {
        online: true,
        sessionId: 's-lead',
        activityState: 'busy',
        pendingQuestion: true,
      },
      'agent-member': { online: true, sessionId: 's-member', activityState: 'busy' },
      'agent-zed': { online: true, sessionId: 's-zed', activityState: 'idle' },
    } as unknown as FlatChatSidebarProps['agentPresence'];
    const dotButtons = () => within(screen.getByTestId('team-status-dots')).getAllByRole('button');

    it('shows one dot per enabled member and none for the lead, with names and a summary', async () => {
      global.fetch = mockTeamFetch(dotTeam);
      renderSidebar({
        agents: [agentLead, agentMember, agentZed, agentOff, agentGone],
        agentPresence: dotPresence,
        onAddTeamAgent: jest.fn(),
      });
      await screen.findByText('Alpha Team');
      // Active members unfold the team; the dots show only once it is folded.
      expect(screen.queryByTestId('team-status-dots')).not.toBeInTheDocument();
      fireEvent.click(memberToggle());

      // The lead's row is always visible, so the lead has no dot and no place in the summary.
      expect(dotButtons().map((dot) => dot.getAttribute('aria-label'))).toEqual([
        'Member Agent, working',
        'Off Agent, offline',
        'Zed Agent, idle',
      ]);
      expect(
        screen.getByRole('group', { name: 'Alpha Team: 1 working, 1 idle, 1 offline' }),
      ).toBeInTheDocument();
      // A working dot pulses like the live dot in the terminal header; an idle dot does not.
      expect(screen.getByRole('button', { name: 'Member Agent, working' }).firstChild).toHaveClass(
        'animate-activity-pulse',
      );
      expect(screen.getByRole('button', { name: 'Zed Agent, idle' }).firstChild).not.toHaveClass(
        'animate-activity-pulse',
      );
    });

    it('selects the agent of a clicked dot without changing the fold', async () => {
      const onSelectAgent = jest.fn();
      global.fetch = mockTeamFetch(dotTeam);
      renderSidebar({
        agents: [agentLead, agentMember, agentZed, agentOff, agentGone],
        agentPresence: dotPresence,
        onAddTeamAgent: jest.fn(),
        onSelectAgent,
      });
      await screen.findByText('Alpha Team');
      fireEvent.click(memberToggle());
      const expandedBefore = memberToggle().getAttribute('aria-expanded');
      const overridesBefore = storedOverrides();

      fireEvent.click(screen.getByRole('button', { name: 'Off Agent, offline' }));

      expect(onSelectAgent).toHaveBeenCalledWith('agent-off');
      expect(memberToggle()).toHaveAttribute('aria-expanded', expandedBefore);
      expect(storedOverrides()).toEqual(overridesBefore);
    });
  });

  describe('disabled agents', () => {
    const disabledMember = { ...agentMember, disabled: true };
    const secondMember: AgentOrGuest = { ...agentMember, id: 'agent-zed', name: 'Zed Agent' };
    const teamMembers = [
      { agentId: 'agent-lead', agentName: 'Lead Agent' },
      { agentId: 'agent-member', agentName: 'Member Agent' },
      { agentId: 'agent-zed', agentName: 'Zed Agent' },
    ];

    it('sorts disabled members after enabled ones and restores the order on Enable', async () => {
      global.fetch = mockTeamFetch({ teamLeadAgentId: 'agent-lead', members: teamMembers });
      const { rerenderSidebar } = renderSidebar({
        agents: [agentLead, disabledMember, secondMember],
        agentPresence: online('agent-zed'),
        onAddTeamAgent: jest.fn(),
      });
      const memberOrder = () =>
        screen
          .getAllByRole('listitem')
          .map((el) => el.getAttribute('aria-label') ?? '')
          .filter((l) => /Member Agent|Zed Agent/.test(l));

      await screen.findByText(/Alpha Team/);
      expect(memberOrder()).toEqual([
        expect.stringContaining('Zed Agent'),
        'Member Agent (disabled)',
      ]);

      rerenderSidebar({ agents: [agentLead, agentMember, secondMember] });
      await waitFor(() =>
        expect(memberOrder()).toEqual([
          expect.stringContaining('Open terminal for Member Agent'),
          expect.stringContaining('Open terminal for Zed Agent'),
        ]),
      );
    });

    it.each([
      {
        place: 'a team member',
        name: 'Member Agent',
        parked: [agentLead, disabledMember],
        enabled: [agentLead, agentMember],
        id: 'agent-member',
        teams: true,
      },
      {
        place: 'a standalone agent',
        name: 'Independent Agent',
        parked: [agentLead, agentMember, { ...agentIndependent, disabled: true }],
        enabled: [agentLead, agentMember, agentIndependent],
        id: 'agent-independent',
        teams: true,
      },
      {
        place: 'an agent in the flat list',
        name: 'Independent Agent',
        parked: [{ ...agentIndependent, disabled: true }],
        enabled: [agentIndependent],
        id: 'agent-independent',
        teams: false,
      },
    ])(
      'observes the metrics row of $place after Enable and Start',
      async ({ name, parked, enabled, id, teams }) => {
        const observers: Array<Set<Element>> = [];
        const OriginalObserver = global.IntersectionObserver;
        global.IntersectionObserver = class {
          private readonly observed = new Set<Element>();
          constructor() {
            observers.push(this.observed);
          }
          observe(element: Element) {
            this.observed.add(element);
          }
          unobserve() {}
          disconnect() {}
          takeRecords() {
            return [];
          }
        } as unknown as typeof IntersectionObserver;
        try {
          // The team is open by the user's choice, so the member row is mounted while disabled.
          window.localStorage.setItem(
            OVERRIDES_KEY,
            JSON.stringify({ 'team-1': { collapsed: false, whenActive: false } }),
          );
          global.fetch = teams
            ? mockTeamFetch({
                teamLeadAgentId: 'agent-lead',
                members: [
                  { agentId: 'agent-lead', agentName: 'Lead Agent' },
                  { agentId: 'agent-member', agentName: 'Member Agent' },
                ],
              })
            : (jest.fn(async () => ({
                ok: true,
                json: async () => ({ items: [], total: 0, limit: 50, offset: 0 }),
              })) as unknown as typeof fetch);
          const { rerenderSidebar } = renderSidebar({ agents: parked, offlineAgents: [] });
          await screen.findByLabelText(`${name} (disabled)`);

          rerenderSidebar({ agents: enabled, agentPresence: online(id) });

          const row = await screen.findByLabelText(new RegExp(`Open terminal for ${name}`, 'i'));
          await waitFor(() => {
            expect(row).toHaveAttribute('data-context-metrics-key');
            expect(observers[observers.length - 1].has(row)).toBe(true);
          });
        } finally {
          global.IntersectionObserver = OriginalObserver;
        }
      },
    );

    it('hides Disable on a member row of an agent that leads another team', async () => {
      const teamDetail = (id: string, name: string, leadId: string, memberIds: string[]) => ({
        id,
        name,
        description: null,
        teamLeadAgentId: leadId,
        maxMembers: 5,
        maxConcurrentTasks: 3,
        allowTeamLeadCreateAgents: true,
        members: memberIds.map((agentId) => ({
          agentId,
          agentName: agentId,
          isLead: agentId === leadId,
          createdAt: '2024-01-01T00:00:00.000Z',
        })),
        profileIds: [],
        profileConfigSelections: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      // agent-member leads Beta and is an ordinary member of Alpha.
      const alpha = teamDetail('team-1', 'Alpha Team', 'agent-lead', [
        'agent-lead',
        'agent-member',
      ]);
      const beta = teamDetail('team-2', 'Beta Team', 'agent-member', ['agent-member', 'agent-zed']);
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('/api/teams?')) {
          const items = [alpha, beta].map(({ members, ...team }) => ({
            ...team,
            teamLeadAgentName: team.teamLeadAgentId,
            memberCount: members.length,
          }));
          return { ok: true, json: async () => ({ items, total: 2, limit: 50, offset: 0 }) };
        }
        if (url.startsWith('/api/teams/team-1')) return { ok: true, json: async () => alpha };
        if (url.startsWith('/api/teams/team-2')) return { ok: true, json: async () => beta };
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;

      renderSidebar({
        agents: [agentLead, agentMember, secondMember],
        agentPresence: online('agent-member', 'agent-zed'),
        onAddTeamAgent: jest.fn(),
        onDisableAgent: jest.fn(),
      });
      await screen.findByText(/Beta Team/);
      await waitFor(() =>
        expect(screen.getAllByLabelText(/Open terminal for Member Agent/)).toHaveLength(2),
      );

      // Only Zed (an ordinary member of Beta) can be disabled.
      const disableItems = screen.getAllByText('Disable');
      expect(disableItems).toHaveLength(1);
      const menu = disableItems[0].closest('[data-testid="context-menu-content"]');
      expect(menu?.previousElementSibling?.textContent).toContain('Zed Agent');
    });

    it('folds a team whose only member is disabled but still has stale online presence', async () => {
      global.fetch = mockTeamFetch({
        teamLeadAgentId: 'agent-lead',
        members: teamMembers.slice(0, 2),
      });
      renderSidebar({
        agents: [agentLead, disabledMember],
        agentPresence: online('agent-lead', 'agent-member'),
        onAddTeamAgent: jest.fn(),
      });
      await screen.findByText(/Alpha Team/);

      expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByLabelText('Member Agent (disabled)')).not.toBeInTheDocument();
      fireEvent.click(memberToggle());
      expect(await screen.findByLabelText('Member Agent (disabled)')).toBeInTheDocument();
      expect(storedOverrides()['team-1']).toEqual({ collapsed: false, whenActive: false });
    });

    it('offers Disable on a non-lead team member only', async () => {
      global.fetch = mockTeamFetch({
        teamLeadAgentId: 'agent-lead',
        members: teamMembers.slice(0, 2),
      });
      renderSidebar({
        agents: [agentLead, agentMember, agentIndependent],
        agentPresence: online('agent-member'),
        onAddTeamAgent: jest.fn(),
        onDisableAgent: jest.fn(),
      });
      await screen.findByText(/Alpha Team/);

      // Lead and standalone rows render menus too; only the member's has Disable.
      const disableItems = screen.getAllByText('Disable');
      expect(disableItems).toHaveLength(1);
      const menu = disableItems[0].closest('[data-testid="context-menu-content"]');
      const row = menu?.previousElementSibling ?? menu?.parentElement;
      expect(row?.textContent).toContain('Member Agent');
    });

    it('never offers Disable for the Project Owner', async () => {
      const owner = { ...agentMember, isProjectOwner: true };
      global.fetch = mockTeamFetch({
        teamLeadAgentId: 'agent-lead',
        members: teamMembers.slice(0, 2),
      });
      renderSidebar({
        agents: [agentLead, owner],
        agentPresence: online('agent-member'),
        onAddTeamAgent: jest.fn(),
        onDisableAgent: jest.fn(),
      });
      await screen.findByText(/Alpha Team/);
      expect(screen.getByLabelText(/Open terminal for Member Agent/)).toBeInTheDocument();
      expect(screen.queryByText('Disable')).not.toBeInTheDocument();
    });

    it('shows the Enable-only menu for a disabled standalone agent', async () => {
      const onEnableAgent = jest.fn();
      global.fetch = mockTeamFetch({
        teamLeadAgentId: 'agent-lead',
        members: teamMembers.slice(0, 2),
      });
      renderSidebar({
        agents: [agentLead, agentMember, { ...agentIndependent, disabled: true }],
        agentPresence: online('agent-member'),
        onAddTeamAgent: jest.fn(),
        onEnableAgent,
      });
      await screen.findByText(/Alpha Team/);
      expect(screen.getByLabelText('Independent Agent (disabled)')).toBeInTheDocument();

      const enable = screen.getByText('Enable');
      const menu = enable.closest('[data-testid="context-menu-content"]')!;
      expect(within(menu as HTMLElement).getAllByTestId('context-menu-item')).toHaveLength(1);
      fireEvent.click(enable);
      expect(onEnableAgent).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-independent' }),
      );
    });

    it('does not select a disabled row on click', async () => {
      const onSelectAgent = jest.fn();
      global.fetch = mockTeamFetch({
        teamLeadAgentId: 'agent-lead',
        members: teamMembers.slice(0, 2),
      });
      renderSidebar({
        agents: [agentLead, disabledMember],
        agentPresence: online('agent-lead'),
        onAddTeamAgent: jest.fn(),
        onSelectAgent,
      });
      await screen.findByText(/Alpha Team/);
      fireEvent.click(memberToggle());
      fireEvent.click(await screen.findByLabelText('Member Agent (disabled)'));
      expect(onSelectAgent).not.toHaveBeenCalled();
    });

    it('keeps the chevron and unfolds a team whose members are all disabled', async () => {
      global.fetch = mockTeamFetch({
        teamLeadAgentId: 'agent-lead',
        members: teamMembers.slice(0, 2),
      });
      renderSidebar({
        agents: [agentLead, disabledMember],
        agentPresence: online('agent-lead'),
        onAddTeamAgent: jest.fn(),
      });
      await screen.findByText(/Alpha Team/);

      expect(screen.queryByLabelText('Member Agent (disabled)')).not.toBeInTheDocument();
      fireEvent.click(memberToggle());
      expect(await screen.findByLabelText('Member Agent (disabled)')).toBeInTheDocument();
    });
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

    await screen.findByText(/Alpha Team/);

    expect(screen.queryByText('TEAMS')).not.toBeInTheDocument();
    expect(screen.queryByText('1 team')).not.toBeInTheDocument();
    expect(screen.getByText('STANDALONE')).toBeInTheDocument();
    expect(screen.getByText('1 agent')).toBeInTheDocument();
    expect(screen.getByText('GUESTS')).toBeInTheDocument();
    expect(screen.getByText('1 guest')).toBeInTheDocument();
    expect(screen.queryByText('No Team')).not.toBeInTheDocument();
    expect(screen.getByText('STANDALONE').closest('button')).toBeNull();
    expect(screen.getByText('GUESTS').closest('button')).toBeNull();
  });

  it('hides chevron on lone-lead team but shows team name sub-label', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: 'agent-lead',
      members: [{ agentId: 'agent-lead', agentName: 'Lead Agent' }],
    });

    renderSidebar({ agents: [agentLead], offlineAgents: [agentLead] });

    await screen.findByText(/Alpha Team/);

    expect(screen.queryByLabelText(/Toggle Alpha Team members/)).not.toBeInTheDocument();
  });

  it('folds an offline no-lead team and opens it on click', async () => {
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
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText(/Open terminal for Lead Agent/i)).not.toBeInTheDocument();

    expect(container.querySelectorAll('button button')).toHaveLength(0);
    const dots = within(screen.getByTestId('team-status-dots')).getAllByRole('button');
    expect(dots).toHaveLength(2);
    dots.forEach((dot) => expect(toggleBtn).not.toContainElement(dot));
    fireEvent.click(toggleBtn);

    expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText(/Open terminal for Lead Agent/i)).toBeInTheDocument();
  });

  it('preserves the team bucket while sorting its agent collection canonically', async () => {
    const teamAgents: AgentOrGuest[] = [
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-z',
        name: 'Alpha',
        type: 'agent',
        isProjectOwner: false,
        disabled: false,
      },
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-owner',
        name: 'Zulu',
        type: 'agent',
        isProjectOwner: true,
        disabled: false,
      },
      {
        profileId: null,
        modelOverride: null,
        effortOverride: null,
        id: 'agent-a',
        name: 'Alpha',
        type: 'agent',
        isProjectOwner: false,
        disabled: false,
      },
    ];
    global.fetch = mockTeamFetch({
      teamLeadAgentId: null,
      members: [
        { agentId: 'agent-z', agentName: 'Alpha' },
        { agentId: 'agent-owner', agentName: 'Zulu' },
        { agentId: 'agent-a', agentName: 'Alpha' },
      ],
    }) as unknown as typeof fetch;

    renderSidebar({ agents: teamAgents, offlineAgents: [], agentPresence: online('agent-a') });

    const rows = within(
      await screen.findByRole('list', { name: 'Alpha Team agents' }),
    ).getAllByRole('listitem');
    expect(rows.map((row) => row.dataset.agentEventBusAgentId)).toEqual([
      'agent-owner',
      'agent-a',
      'agent-z',
    ]);
  });

  const leadTeam = {
    teamLeadAgentId: 'agent-lead',
    members: [
      { agentId: 'agent-lead', agentName: 'Lead Agent' },
      { agentId: 'agent-member', agentName: 'Member Agent' },
    ],
  };

  it.each([
    { state: 'no online member', presence: online(), expanded: false },
    { state: 'an online non-lead member', presence: online('agent-member'), expanded: true },
    { state: 'only the lead online', presence: online('agent-lead'), expanded: false },
  ])('sets the team open=$expanded with $state', async ({ presence, expanded }) => {
    global.fetch = mockTeamFetch(leadTeam);
    renderSidebar({ agents: [agentLead, agentMember], offlineAgents: [], agentPresence: presence });

    await screen.findByText(/Alpha Team/);
    expect(memberToggle()).toHaveAttribute('aria-expanded', String(expanded));
    expect(screen.getByLabelText(/Open terminal for Lead Agent/i)).toBeInTheDocument();
    expect(Boolean(screen.queryByLabelText(/Open terminal for Member Agent/i))).toBe(expanded);
  });

  it('keeps a fold of an active team until all members go offline', async () => {
    window.localStorage.setItem(LEGACY_TEAM_GROUPS_KEY, JSON.stringify({ 'team-1': false }));
    global.fetch = mockTeamFetch(leadTeam);
    const props = { agents: [agentLead, agentMember], offlineAgents: [] };
    const first = renderSidebar({ ...props, agentPresence: online('agent-member') });

    await screen.findByText(/Alpha Team/);
    expect(window.localStorage.getItem(LEGACY_TEAM_GROUPS_KEY)).toBeNull();
    fireEvent.click(memberToggle());
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(storedOverrides()).toEqual({ 'team-1': { collapsed: true, whenActive: true } });

    first.unmount();
    const { rerenderSidebar } = renderSidebar({ ...props, agentPresence: online('agent-member') });
    await screen.findByText(/Alpha Team/);
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');

    rerenderSidebar({ agentPresence: online() });
    await waitFor(() => expect(storedOverrides()).toEqual({}));
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');

    rerenderSidebar({ agentPresence: online('agent-member') });
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'true');
  });

  describe('with two sidebars on different projects', () => {
    const betaLead = { ...agentLead, id: 'beta-lead', name: 'Beta Lead' };
    const betaMember = { ...agentMember, id: 'beta-member', name: 'Beta Member' };
    const alphaFold = { 'team-1': { collapsed: true, whenActive: true } };
    const betaFold = { 'team-2': { collapsed: true, whenActive: true } };
    const toggle = (teamName: string) => screen.getByLabelText(`Toggle ${teamName} members`);

    function mockTwoProjectTeamFetch() {
      const teams: Record<string, { id: string; name: string; leadId: string; memberId: string }> =
        {
          'project-1': {
            id: 'team-1',
            name: 'Alpha Team',
            leadId: agentLead.id,
            memberId: agentMember.id,
          },
          'project-2': {
            id: 'team-2',
            name: 'Beta Team',
            leadId: betaLead.id,
            memberId: betaMember.id,
          },
        };
      const base = (team: (typeof teams)[string]) => ({
        id: team.id,
        name: team.name,
        description: null,
        teamLeadAgentId: team.leadId,
        maxMembers: 5,
        maxConcurrentTasks: 3,
        allowTeamLeadCreateAgents: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      return jest.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        const listed = teams[url.searchParams.get('projectId') ?? ''];
        if (url.pathname === '/api/teams' && listed) {
          const item = { ...base(listed), teamLeadAgentName: null, memberCount: 2 };
          return {
            ok: true,
            json: async () => ({ items: [item], total: 1, limit: 50, offset: 0 }),
          };
        }
        const detail = Object.values(teams).find(
          (team) => url.pathname === `/api/teams/${team.id}`,
        );
        if (detail) {
          const members = [detail.leadId, detail.memberId].map((agentId) => ({
            agentId,
            agentName: agentId,
            isLead: agentId === detail.leadId,
            createdAt: '2024-01-01T00:00:00.000Z',
          }));
          return {
            ok: true,
            json: async () => ({
              ...base(detail),
              members,
              profileIds: [],
              profileConfigSelections: [],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      }) as unknown as typeof fetch;
    }

    async function renderBoth() {
      global.fetch = mockTwoProjectTeamFetch();
      const alpha = renderSidebar({
        agents: [agentLead, agentMember],
        offlineAgents: [],
        agentPresence: online(agentMember.id),
      });
      const beta = renderSidebar({
        projectId: 'project-2',
        agents: [betaLead, betaMember],
        offlineAgents: [],
        agentPresence: online(betaMember.id),
      });
      await screen.findByLabelText('Toggle Alpha Team members');
      await screen.findByLabelText('Toggle Beta Team members');
      return { alpha, beta };
    }

    it("keeps the other sidebar's stored fold when a team is folded", async () => {
      await renderBoth();

      fireEvent.click(toggle('Alpha Team'));
      fireEvent.click(toggle('Beta Team'));

      expect(storedOverrides()).toEqual({ ...alphaFold, ...betaFold });
      expect(toggle('Alpha Team')).toHaveAttribute('aria-expanded', 'false');
      expect(toggle('Beta Team')).toHaveAttribute('aria-expanded', 'false');
    });

    it("removes only the expired team's stored fold", async () => {
      window.localStorage.setItem(OVERRIDES_KEY, JSON.stringify(alphaFold));
      const { alpha } = await renderBoth();
      fireEvent.click(toggle('Beta Team'));
      expect(storedOverrides()).toEqual({ ...alphaFold, ...betaFold });

      alpha.rerenderSidebar({ agentPresence: online() });

      await waitFor(() => expect(storedOverrides()).toEqual(betaFold));
      expect(toggle('Alpha Team')).toHaveAttribute('aria-expanded', 'false');
      expect(toggle('Beta Team')).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('keeps an opened idle team open until a member starts and stops', async () => {
    global.fetch = mockTeamFetch(leadTeam);
    const { rerenderSidebar } = renderSidebar({
      agents: [agentLead, agentMember],
      offlineAgents: [],
      agentPresence: online(),
    });

    await screen.findByText(/Alpha Team/);
    fireEvent.click(memberToggle());
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(storedOverrides()).toEqual({ 'team-1': { collapsed: false, whenActive: false } });

    rerenderSidebar({ agentPresence: online('agent-member') });
    await waitFor(() => expect(storedOverrides()).toEqual({}));
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'true');

    rerenderSidebar({ agentPresence: online() });
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('deletes no override while presence is loading', async () => {
    const override = { 'team-1': { collapsed: true, whenActive: true } };
    window.localStorage.setItem(OVERRIDES_KEY, JSON.stringify(override));
    global.fetch = mockTeamFetch(leadTeam);
    const { rerenderSidebar } = renderSidebar({
      agents: [agentLead, agentMember],
      offlineAgents: [],
      agentPresence: online(),
      presenceReady: false,
    });

    await waitFor(() =>
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([url]) => String(url) === '/api/teams/team-1'),
      ).toBe(true),
    );
    await act(async () => {});
    expect(screen.queryByText(/Alpha Team/)).not.toBeInTheDocument();
    expect(storedOverrides()).toEqual(override);

    rerenderSidebar({ presenceReady: true, agentPresence: online('agent-member') });
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(storedOverrides()).toEqual(override);
  });

  it('keeps a saved fold after a failed presence load until a successful snapshot', async () => {
    const override = { 'team-1': { collapsed: true, whenActive: true } };
    window.localStorage.setItem(OVERRIDES_KEY, JSON.stringify(override));
    global.fetch = mockTeamFetch(leadTeam);
    const { rerenderSidebar } = renderSidebar({
      agents: [agentLead, agentMember],
      offlineAgents: [],
      agentPresence: online(),
      presenceReady: true,
      presenceSettled: false,
    });

    await screen.findByText(/Alpha Team/);
    await act(async () => {});
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(storedOverrides()).toEqual(override);

    rerenderSidebar({ presenceSettled: true, agentPresence: online('agent-member') });
    expect(memberToggle()).toHaveAttribute('aria-expanded', 'false');
    expect(storedOverrides()).toEqual(override);
  });

  it('keeps a saved fold while the presence prop claims settled but a request is in flight', async () => {
    const override = { 'team-1': { collapsed: true, whenActive: true } };
    window.localStorage.setItem(OVERRIDES_KEY, JSON.stringify(override));
    global.fetch = mockTeamFetch(leadTeam);
    const { queryClient, rerenderSidebar } = renderSidebar({
      agents: [agentLead, agentMember],
      offlineAgents: [],
      agentPresence: online('agent-member'),
    });
    await screen.findByText(/Alpha Team/);

    const presenceKey = chatQueryKeys.agentPresence('project-1');
    void queryClient.fetchQuery({ queryKey: presenceKey, queryFn: () => new Promise(() => {}) });
    rerenderSidebar({ agentPresence: online() });
    await act(async () => {});

    expect(queryClient.isFetching({ queryKey: presenceKey })).toBe(1);
    expect(storedOverrides()).toEqual(override);
    await queryClient.cancelQueries({ queryKey: presenceKey });
  });

  it('keeps one metrics observer while presence updates leave the rendered rows unchanged', async () => {
    const created = jest.fn();
    const OriginalObserver = global.IntersectionObserver;
    global.IntersectionObserver = class {
      constructor() {
        created();
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    try {
      global.fetch = mockTeamFetch(leadTeam);
      const props = { agents: [agentLead, agentMember], offlineAgents: [] };
      const { rerenderSidebar } = renderSidebar({
        ...props,
        agentPresence: online('agent-member'),
      });
      await screen.findByLabelText(/Open terminal for Member Agent/i);
      const createdBefore = created.mock.calls.length;

      rerenderSidebar({ agentPresence: online('agent-member') });
      rerenderSidebar({ agentPresence: online('agent-member', 'agent-lead') });
      expect(created).toHaveBeenCalledTimes(createdBefore);

      rerenderSidebar({ agentPresence: online('agent-lead') });
      expect(screen.queryByLabelText(/Open terminal for Member Agent/i)).not.toBeInTheDocument();
      expect(created).toHaveBeenCalledTimes(createdBefore + 1);
    } finally {
      global.IntersectionObserver = OriginalObserver;
    }
  });

  it('observes the remounted rows after a lead change swaps the lead and a member', async () => {
    const observers: Array<Set<Element>> = [];
    const OriginalObserver = global.IntersectionObserver;
    global.IntersectionObserver = class {
      private readonly observed = new Set<Element>();
      constructor() {
        observers.push(this.observed);
      }
      observe(element: Element) {
        this.observed.add(element);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    try {
      global.fetch = mockTeamFetch(leadTeam);
      const { queryClient } = renderSidebar({
        agents: [agentLead, agentMember],
        offlineAgents: [],
        agentPresence: online('agent-lead', 'agent-member'),
      });
      await screen.findByLabelText(/Open terminal for Member Agent/i);

      global.fetch = mockTeamFetch({ ...leadTeam, teamLeadAgentId: 'agent-member' });
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['teams'] });
      });
      await waitFor(() => {
        const members = screen.getByRole('list', { name: 'Alpha Team members' });
        expect(within(members).getByLabelText(/Open terminal for Lead Agent/i)).toBeInTheDocument();
      });

      const mounted = Array.from(document.querySelectorAll('[data-context-metrics-key]'));
      const latest = observers[observers.length - 1];
      expect(mounted).toHaveLength(2);
      mounted.forEach((element) => expect(latest.has(element)).toBe(true));
    } finally {
      global.IntersectionObserver = OriginalObserver;
    }
  });

  it('requests context metrics only for members of an open team', async () => {
    window.localStorage.setItem(
      OVERRIDES_KEY,
      JSON.stringify({ 'team-1': { collapsed: true, whenActive: true } }),
    );
    const teamFetch = mockTeamFetch(leadTeam);
    const summaryRequests: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/transcript/summary')) {
        summaryRequests.push(url);
        return { ok: true, json: async () => ({ metrics: null, isOngoing: false }) };
      }
      return teamFetch(input);
    }) as unknown as typeof fetch;

    const { rerenderSidebar } = renderSidebar({
      agents: [agentLead, agentMember],
      offlineAgents: [],
      agentPresence: online('agent-lead', 'agent-member'),
    });

    await screen.findByText(/Alpha Team/);
    await waitFor(() =>
      expect(summaryRequests.some((url) => url.includes('session-agent-lead'))).toBe(true),
    );
    expect(summaryRequests.some((url) => url.includes('session-agent-member'))).toBe(false);

    rerenderSidebar({ agentPresence: online('agent-lead') });
    await waitFor(() => expect(storedOverrides()).toEqual({}));
    rerenderSidebar({ agentPresence: online('agent-lead', 'agent-member') });

    expect(memberToggle()).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(summaryRequests.some((url) => url.includes('session-agent-member'))).toBe(true),
    );
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
      offlineAgents: [],
      agentPresence: online(sharedAgent.id),
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
    type: 'agent',
    modelOverride: null,
    effortOverride: null,
    id: 'agent-1',
    name: 'Alpha',
    profileId: 'profile-1',
    isProjectOwner: false,
    disabled: false,
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

    await screen.findByRole('list', { name: 'Agents' });

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
    modelOverride: null,
    effortOverride: null,
    id: 'guest-1',
    name: 'Guest Agent',
    profileId: null,
    isProjectOwner: false,
    disabled: false,
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
    modelOverride: null,
    effortOverride: null,
    id: 'guest-1',
    name: 'Guest Agent',
    profileId: null,
    isProjectOwner: false,
    disabled: false,
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

  it('marks main agent rows in the flat list with the unlogged phrase', async () => {
    renderSidebar({ unloggedTimeMinutes: { 'agent-1': 10 } });

    const row = await screen.findByRole('listitem', {
      name: 'Open terminal for Alpha (offline), 10m not logged to an Epic.',
    });
    expect(row.querySelector('[data-unlogged-time-marker]')).not.toBeNull();
  });

  it('marks main agent rows in the team view', async () => {
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

    renderSidebar({
      unloggedTimeMinutes: { 'agent-1': 90 },
      agentPresence: {
        'agent-1': { online: true, sessionId: 'session-1' },
      } as unknown as FlatChatSidebarProps['agentPresence'],
    });

    const row = await screen.findByRole('listitem', {
      name: 'Open terminal for Alpha (online), 1h 30m not logged to an Epic.',
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
    const mainRow = await screen.findByRole('listitem', {
      name: 'Open terminal for Alpha (offline)',
    });
    expect(mainRow.querySelector('span.pointer-events-none')).toBeNull();
  });
});
