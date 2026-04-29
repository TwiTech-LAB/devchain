import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ChatSidebar, normalizeModelOverrideSelection, type ChatSidebarProps } from './ChatSidebar';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
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
  projectId: 'project-1',
} as AgentOrGuest;

function renderSidebar(overrides: Partial<ChatSidebarProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const defaultProps: ChatSidebarProps = {
    projectId: 'project-1',
    agents: [agent],
    guests: [],
    worktreeAgentGroups: [],
    worktreeAgentGroupsLoading: false,
    agentPresence: {},
    userThreads: [],
    agentThreads: [],
    presenceReady: true,
    offlineAgents: [agent],
    agentsWithSessions: [],
    agentsLoading: false,
    agentsError: false,
    userThreadsLoading: false,
    agentThreadsLoading: false,
    launchingAgentIds: {},
    restartingAgentId: null,
    startingAll: false,
    terminatingAll: false,
    isLaunchingChat: false,
    selectedThreadId: null,
    selectedWorktreeAgent: null,
    hasSelectedProject: true,
    onSelectThread: jest.fn(),
    onLaunchChat: jest.fn(),
    onLaunchWorktreeAgentChat: jest.fn(),
    onLaunchWorktreeSession: jest.fn(async () => {}),
    onRestartWorktreeSession: jest.fn(async () => {}),
    onTerminateWorktreeSession: jest.fn(async () => {}),
    onCreateGroup: jest.fn(),
    onStartAllAgents: jest.fn(),
    onTerminateAllConfirm: jest.fn(),
    onLaunchSession: jest.fn(async () => ({ id: 'session-1' })),
    onRestartSession: jest.fn(async () => {}),
    onTerminateConfirm: jest.fn(),
    getProviderForAgent: jest.fn(() => null),
    pendingRestartAgentIds: new Set<string>(),
    onMarkForRestart: jest.fn(),
    worktreeSessionActionsByAgentKey: {},
    validatedPresets: [],
    activePreset: null,
    onApplyPreset: jest.fn(),
    applyingPreset: false,
    onSwitchConfig: jest.fn(),
    fetchProviderConfigsForProfile: jest.fn(async () => []),
    updatingConfigAgentIds: {},
    onSwitchWorktreeConfig: jest.fn(),
    updatingWorktreeConfigKey: null,
    createGroupPending: false,
  };

  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ChatSidebar {...defaultProps} {...overrides} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('normalizeModelOverrideSelection', () => {
  it('returns undefined for the none-selected sentinel', () => {
    expect(normalizeModelOverrideSelection('__none_selected__')).toBeUndefined();
  });

  it('returns null for default model override option', () => {
    expect(normalizeModelOverrideSelection('__default_no_override__')).toBeNull();
  });

  it('passes through explicit model values', () => {
    expect(normalizeModelOverrideSelection('openai/gpt-4.1')).toBe('openai/gpt-4.1');
  });
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
    window.localStorage.removeItem(TAB_KEY);
    global.fetch = mockFetchWithTeams(0);
  });

  afterEach(() => {
    window.localStorage.removeItem(TAB_KEY);
    if (originalFetch) {
      global.fetch = originalFetch;
    }
  });

  it('defaults to All tab when project has 0 teams', async () => {
    global.fetch = mockFetchWithTeams(0);
    renderSidebar();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'false');
  });

  it('defaults to Teams tab when project has ≥1 team', async () => {
    global.fetch = mockFetchWithTeams(1);
    renderSidebar();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'true');
    });
  });

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
  });

  it('initializes from project-scoped localStorage on first render', async () => {
    window.localStorage.setItem(TAB_KEY, 'teams');
    global.fetch = mockFetchWithTeams(0);

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'true');
    });
    expect(await screen.findByText(/No teams configured/i)).toBeInTheDocument();
  });

  it('persisted All overrides default Teams rule', async () => {
    window.localStorage.setItem(TAB_KEY, 'all');
    global.fetch = mockFetchWithTeams(1);

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('ignores invalid stored values and applies default rule', async () => {
    window.localStorage.setItem(TAB_KEY, 'invalid-value');
    global.fetch = mockFetchWithTeams(1);

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'true');
    });
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
    projectId: 'project-1',
  } as AgentOrGuest;

  const agentMember: AgentOrGuest = {
    id: 'agent-member',
    name: 'Member Agent',
    profileId: 'profile-1',
    projectId: 'project-1',
  } as AgentOrGuest;

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

    renderSidebar({ agents: [agentLead, agentMember], offlineAgents: [agentLead, agentMember] });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'true');
    });

    await waitFor(() => {
      expect(screen.getByText(/Alpha Team/)).toBeInTheDocument();
    });

    expect(screen.getByLabelText(/Toggle Alpha Team members/)).toBeInTheDocument();
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

  it('falls back to old group header rendering for legacy null-lead teams', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: null,
      members: [{ agentId: 'agent-lead', agentName: 'Lead Agent' }],
      teamName: 'Legacy Team',
    });

    renderSidebar({ agents: [agentLead], offlineAgents: [agentLead] });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Teams' })).toHaveAttribute('aria-selected', 'true');
    });

    await waitFor(() => {
      expect(screen.getByText('Legacy Team')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Legacy Team/i })).toHaveAttribute('aria-expanded');
  });

  it('no-lead header has no nested buttons', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: null,
      members: [{ agentId: 'agent-lead', agentName: 'Lead Agent' }],
      teamName: 'NoNest Team',
    });

    const { container } = renderSidebar({
      agents: [agentLead],
      offlineAgents: [agentLead],
    });

    await waitFor(() => {
      expect(screen.getByText('NoNest Team')).toBeInTheDocument();
    });

    const nestedButtons = container.querySelectorAll('button button');
    expect(nestedButtons).toHaveLength(0);
  });

  it('no-lead toggle button expands/collapses team group', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: null,
      members: [
        { agentId: 'agent-lead', agentName: 'Lead Agent' },
        { agentId: 'agent-member', agentName: 'Member Agent' },
      ],
      teamName: 'Toggle Team',
    });

    renderSidebar({
      agents: [agentLead, agentMember],
      offlineAgents: [agentLead, agentMember],
    });

    await waitFor(() => {
      expect(screen.getByText('Toggle Team')).toBeInTheDocument();
    });

    const toggleBtn = screen.getByRole('button', { name: /Toggle Toggle Team members/i });
    expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    });
  });

  it('expands to show indented member rows when chevron is clicked', async () => {
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

    expect(screen.queryByLabelText(/Chat with Member Agent/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Toggle Alpha Team members/));

    await waitFor(() => {
      expect(screen.getByLabelText(/Chat with Member Agent/i)).toBeInTheDocument();
    });
  });

  it('onEditTeam payload includes allowTeamLeadCreateAgents=true from team detail', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: 'agent-lead',
      members: [{ agentId: 'agent-lead', agentName: 'Lead Agent' }],
      maxMembers: 8,
      maxConcurrentTasks: 4,
      allowTeamLeadCreateAgents: true,
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
      maxMembers: 8,
      maxConcurrentTasks: 4,
      allowTeamLeadCreateAgents: true,
    });
  });

  it('onEditTeam payload includes allowTeamLeadCreateAgents=false from team detail', async () => {
    global.fetch = mockTeamFetch({
      teamLeadAgentId: 'agent-lead',
      members: [{ agentId: 'agent-lead', agentName: 'Lead Agent' }],
      maxMembers: 6,
      maxConcurrentTasks: 2,
      allowTeamLeadCreateAgents: false,
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
      maxMembers: 6,
      maxConcurrentTasks: 2,
      allowTeamLeadCreateAgents: false,
    });
  });
});
