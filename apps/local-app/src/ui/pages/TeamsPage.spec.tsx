import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TeamsPage } from './TeamsPage';
import { ProviderGroupedConfigSelector } from '@/ui/components/team/ProviderGroupedConfigSelector';

// ── Mocks ────────────────────────────────────────────────

const toastSpy = jest.fn();
const useSelectedProjectMock = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

// ── Test Data ────────────────────────────────────────────

const mockTeam = {
  id: 'team-1',
  projectId: 'project-1',
  name: 'Backend Squad',
  description: 'Handles backend tasks',
  teamLeadAgentId: 'agent-1',
  teamLeadAgentName: 'Agent Alpha',
  memberCount: 2,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const mockTeamNoLead = {
  ...mockTeam,
  teamLeadAgentId: null,
  teamLeadAgentName: null,
};

const mockTeamDetail = {
  id: 'team-1',
  projectId: 'project-1',
  name: 'Backend Squad',
  description: 'Handles backend tasks',
  teamLeadAgentId: 'agent-1',
  teamLeadAgentName: 'Agent Alpha',
  members: [
    {
      agentId: 'agent-1',
      agentName: 'Agent Alpha',
      isLead: true,
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    {
      agentId: 'agent-2',
      agentName: 'Agent Beta',
      isLead: false,
      createdAt: '2024-01-01T00:00:00.000Z',
    },
  ],
  profileIds: ['profile-1'],
  profileConfigSelections: [{ profileId: 'profile-1', configIds: ['config-1'] }],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

const mockTeamDetailNoLead = {
  ...mockTeamDetail,
  teamLeadAgentId: null,
  teamLeadAgentName: null,
  members: mockTeamDetail.members.map((member) => ({ ...member, isLead: false })),
};

const mockAgents = [
  { id: 'agent-1', name: 'Agent Alpha' },
  { id: 'agent-2', name: 'Agent Beta' },
  { id: 'agent-3', name: 'Agent Gamma' },
  { id: 'agent-4', name: 'Agent Delta' },
];

const mockProfiles = [
  { id: 'profile-1', name: 'Profile Alpha' },
  { id: 'profile-2', name: 'Profile Beta' },
];

const mockProviderConfigs = [
  { id: 'config-1', name: 'Config One', description: null, options: null, providerName: 'claude' },
  { id: 'config-2', name: 'Config Two', description: null, options: null, providerName: 'codex' },
];

const projectSelectionValue = {
  projects: [],
  projectsLoading: false,
  projectsError: false,
  refetchProjects: jest.fn(),
  selectedProjectId: 'project-1',
  selectedProject: { id: 'project-1', name: 'Project Alpha' },
  setSelectedProjectId: jest.fn(),
};

// ── Helpers ──────────────────────────────────────────────

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data, status: 200 } as Response;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

function buildFetchMock(overrides?: {
  teams?: Array<typeof mockTeam | typeof mockTeamNoLead>;
  teamDetail?: typeof mockTeamDetail | typeof mockTeamDetailNoLead;
  teamDetailsMap?: Record<string, unknown>;
  agents?: Array<{ id: string; name: string }>;
}) {
  const teams = overrides?.teams ?? [mockTeam];
  const teamDetail = overrides?.teamDetail ?? mockTeamDetail;
  const agents = overrides?.agents ?? mockAgents;

  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method?.toUpperCase() ?? 'GET';

    if (method === 'GET' && url.startsWith('/api/teams?')) {
      return jsonResponse({ items: teams, total: teams.length, limit: 100, offset: 0 });
    }
    if (method === 'GET' && url.startsWith('/api/teams/')) {
      if (overrides?.teamDetailsMap) {
        const teamId = url.split('/api/teams/')[1]?.split('?')[0];
        if (teamId && teamId in overrides.teamDetailsMap) {
          return jsonResponse(overrides.teamDetailsMap[teamId]);
        }
      }
      return jsonResponse(teamDetail);
    }
    if (method === 'GET' && url.startsWith('/api/agents?')) {
      return jsonResponse({ items: agents, total: agents.length, limit: 100, offset: 0 });
    }
    if (method === 'GET' && /\/api\/profiles\/[^/]+\/provider-configs/.test(url)) {
      return jsonResponse(mockProviderConfigs);
    }
    if (method === 'GET' && url.startsWith('/api/profiles?')) {
      return jsonResponse({
        items: mockProfiles,
        total: mockProfiles.length,
        limit: 100,
        offset: 0,
      });
    }
    if (method === 'POST' && url === '/api/teams') {
      return jsonResponse(mockTeamDetail);
    }
    if (method === 'PUT' && url.startsWith('/api/teams/')) {
      return jsonResponse(mockTeamDetail);
    }
    if (method === 'DELETE' && url.startsWith('/api/teams/')) {
      return { ok: true, status: 200 } as Response;
    }
    return jsonResponse({});
  });
}

// ── Tests ────────────────────────────────────────────────

describe('TeamsPage', () => {
  let originalFetch: typeof global.fetch | undefined;

  beforeEach(() => {
    toastSpy.mockClear();
    useSelectedProjectMock.mockReturnValue(projectSelectionValue);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('renders team list when teams exist', async () => {
    global.fetch = buildFetchMock() as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');
    expect(screen.getByText('Handles backend tasks')).toBeInTheDocument();
    expect(screen.getByText('Agent Alpha')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    queryClient.clear();
  });

  it('shows "No lead assigned" for teams without a lead', async () => {
    global.fetch = buildFetchMock({
      teams: [mockTeamNoLead],
      teamDetail: mockTeamDetailNoLead,
    }) as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');
    expect(screen.getByText('No lead assigned')).toBeInTheDocument();

    queryClient.clear();
  });

  it('shows "Unknown" when a lead id exists but the lead name is unresolved', async () => {
    global.fetch = buildFetchMock({
      teams: [{ ...mockTeam, teamLeadAgentId: 'agent-missing', teamLeadAgentName: null }],
    }) as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');
    expect(screen.getByText('Unknown')).toBeInTheDocument();

    queryClient.clear();
  });

  it('renders empty state when no teams', async () => {
    global.fetch = buildFetchMock({ teams: [] }) as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('No teams yet');
    expect(
      screen.getByText('Create a team to organize your agents and coordinate their work.'),
    ).toBeInTheDocument();

    queryClient.clear();
  });

  it('shows loading skeleton during fetch', async () => {
    let resolveTeams!: () => void;
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method?.toUpperCase() ?? 'GET';

      if (method === 'GET' && url.startsWith('/api/teams?')) {
        return new Promise<Response>((resolve) => {
          resolveTeams = () =>
            resolve(jsonResponse({ items: [mockTeam], total: 1, limit: 100, offset: 0 }));
        });
      }
      if (method === 'GET' && url.startsWith('/api/agents?')) {
        return jsonResponse({ items: mockAgents, total: 3, limit: 100, offset: 0 });
      }
      if (method === 'GET' && url.startsWith('/api/profiles?')) {
        return jsonResponse({
          items: mockProfiles,
          total: mockProfiles.length,
          limit: 100,
          offset: 0,
        });
      }
      return jsonResponse({});
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { Wrapper, queryClient } = createWrapper();
    const { container } = render(<TeamsPage />, { wrapper: Wrapper });

    // Skeleton elements should be present while loading
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('Backend Squad')).not.toBeInTheDocument();

    // Resolve the teams fetch
    await act(async () => {
      resolveTeams();
    });

    await screen.findByText('Backend Squad');

    queryClient.clear();
  });

  it('opens create dialog, fills form, and submits', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');

    // Open create dialog
    fireEvent.click(screen.getAllByRole('button', { name: /create team/i })[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Create Team')).toBeInTheDocument();

    // Fill name
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'New Team' },
    });

    // Select members via checkboxes (use IDs to avoid index sensitivity)
    fireEvent.click(document.getElementById('member-agent-3')!);
    fireEvent.click(document.getElementById('member-agent-4')!);

    // Select team lead
    fireEvent.change(within(dialog).getByLabelText('Team Lead'), {
      target: { value: 'agent-3' },
    });

    // Submit
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/teams',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    // Verify the POST body
    const postCall = fetchMock.mock.calls.find(
      ([url, opts]: [string, RequestInit?]) => url === '/api/teams' && opts?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall![1]!.body as string);
    expect(body.name).toBe('New Team');
    expect(body.teamLeadAgentId).toBe('agent-3');
    expect(body.memberAgentIds).toEqual(expect.arrayContaining(['agent-3', 'agent-4']));

    queryClient.clear();
  });

  it('disables create when members selected but no lead chosen, shows hint after interaction', async () => {
    global.fetch = buildFetchMock() as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');

    fireEvent.click(screen.getAllByRole('button', { name: /create team/i })[0]);
    const dialog = await screen.findByRole('dialog');

    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Test Team' },
    });
    fireEvent.click(document.getElementById('member-agent-3')!); // Select Agent Gamma as member

    const createButton = within(dialog).getByRole('button', { name: /^create$/i });
    expect(createButton).toBeDisabled();

    expect(within(dialog).getByText('Team lead is required.')).toBeInTheDocument();

    queryClient.clear();
  });

  it('opens edit dialog pre-populated and submits update', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');

    // Click edit button on team card
    const card = screen.getByTestId('team-card-team-1');
    const buttons = within(card).getAllByRole('button');
    fireEvent.click(buttons[0]); // Edit button (first)

    // Wait for edit dialog to open and populate
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit Team')).toBeInTheDocument();

    const nameInput = (await within(dialog).findByLabelText('Name')) as HTMLInputElement;
    await waitFor(() => {
      expect(nameInput.value).toBe('Backend Squad');
    });

    // Change name
    fireEvent.change(nameInput, { target: { value: 'Updated Squad' } });

    // Submit
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([url, opts]: [string, RequestInit?]) =>
          typeof url === 'string' && url.startsWith('/api/teams/') && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.name).toBe('Updated Squad');
    });

    queryClient.clear();
  });

  it('disables Save when lead is cleared in edit mode', async () => {
    global.fetch = buildFetchMock() as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');

    const card = screen.getByTestId('team-card-team-1');
    fireEvent.click(within(card).getAllByRole('button')[0]);

    const dialog = await screen.findByRole('dialog');
    const leadSelect = (await within(dialog).findByLabelText('Team Lead')) as HTMLSelectElement;

    await waitFor(() => {
      expect(leadSelect.value).toBe('agent-1');
    });

    // Save should be enabled while lead is set
    expect(within(dialog).getByRole('button', { name: /^save$/i })).toBeEnabled();

    // Clear the lead
    fireEvent.change(leadSelect, { target: { value: '' } });

    // Save should now be disabled
    expect(within(dialog).getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(within(dialog).getByText('Team lead is required.')).toBeInTheDocument();

    queryClient.clear();
  });

  it('editing a legacy null-lead team: Save disabled until lead is picked', async () => {
    const nullLeadDetail = {
      ...mockTeamDetail,
      teamLeadAgentId: null,
      teamLeadAgentName: null,
      members: mockTeamDetail.members.map((m) => ({ ...m, isLead: false })),
    };
    global.fetch = buildFetchMock({ teamDetail: nullLeadDetail }) as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');

    const card = screen.getByTestId('team-card-team-1');
    fireEvent.click(within(card).getAllByRole('button')[0]);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe(
        'Backend Squad',
      );
    });

    // Save should be disabled (no lead)
    expect(within(dialog).getByRole('button', { name: /^save$/i })).toBeDisabled();

    // No validation hint yet (form not touched)
    expect(within(dialog).queryByText('Team lead is required.')).not.toBeInTheDocument();

    // Pick a lead
    fireEvent.change(within(dialog).getByLabelText('Team Lead'), {
      target: { value: 'agent-1' },
    });

    // Save should now be enabled
    expect(within(dialog).getByRole('button', { name: /^save$/i })).toBeEnabled();

    queryClient.clear();
  });

  it('shows disband confirmation and deletes on confirm', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');

    // Click disband button on team card
    const card = screen.getByTestId('team-card-team-1');
    const buttons = within(card).getAllByRole('button');
    fireEvent.click(buttons[1]); // Disband button (second)

    // Confirm dialog appears
    await screen.findByText('Disband Team');
    expect(screen.getByText(/Are you sure you want to disband Backend Squad/)).toBeInTheDocument();

    // Click confirm
    fireEvent.click(screen.getByRole('button', { name: /^disband$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/teams/team-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    queryClient.clear();
  });

  it('shows "Configure allowed configs" button when profiles are selected and hides it when none', async () => {
    global.fetch = buildFetchMock() as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');

    fireEvent.click(screen.getAllByRole('button', { name: /create team/i })[0]);
    const dialog = await screen.findByRole('dialog');

    // No profiles selected — button should not be visible
    expect(within(dialog).queryByText(/Configure allowed configs/)).not.toBeInTheDocument();

    // Select a profile
    const profileCheckbox = within(dialog).getByLabelText('Profile Alpha');
    fireEvent.click(profileCheckbox);

    // Button should now be visible
    expect(within(dialog).getByText(/Configure allowed configs/)).toBeInTheDocument();

    // Deselect the profile
    fireEvent.click(profileCheckbox);

    // Button should disappear again
    expect(within(dialog).queryByText(/Configure allowed configs/)).not.toBeInTheDocument();

    queryClient.clear();
  });

  it('drops profileSelections entry when a profile is deselected in the main dialog', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');

    // Open edit dialog — mockTeamDetail has profileIds: ['profile-1'] and profileConfigSelections
    const card = screen.getByTestId('team-card-team-1');
    fireEvent.click(within(card).getAllByRole('button')[0]);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe(
        'Backend Squad',
      );
    });

    // Profile Alpha should be checked (from mockTeamDetail.profileIds)
    const profileCheckbox = within(dialog).getByLabelText('Profile Alpha');
    expect(profileCheckbox).toBeChecked();

    // Badge should show "1/1 narrowed" (1 selection for 1 profile)
    expect(within(dialog).getByText(/Configure allowed configs/)).toBeInTheDocument();

    // Deselect Profile Alpha
    fireEvent.click(profileCheckbox);

    // Configure button should be gone (0 profiles selected)
    expect(within(dialog).queryByText(/Configure allowed configs/)).not.toBeInTheDocument();

    // Re-select Profile Alpha and submit — selections should have been cleared
    fireEvent.click(profileCheckbox);

    // Badge should show "0/1 narrowed" (selection was dropped on deselect)
    expect(within(dialog).getByText(/0\/1/)).toBeInTheDocument();

    queryClient.clear();
  });

  it('includes profileConfigSelections in the submit payload', async () => {
    const fetchMock = buildFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');

    // Open edit dialog
    const card = screen.getByTestId('team-card-team-1');
    fireEvent.click(within(card).getAllByRole('button')[0]);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe(
        'Backend Squad',
      );
    });

    // Submit with existing data (includes profileConfigSelections from hydration)
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([url, opts]: [string, RequestInit?]) =>
          typeof url === 'string' && url.startsWith('/api/teams/') && opts?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string);
      expect(body.profileConfigSelections).toEqual([
        { profileId: 'profile-1', configIds: ['config-1'] },
      ]);
      expect(body.profileIds).toEqual(['profile-1']);
    });

    queryClient.clear();
  });

  describe('ConfigureTeamConfigsModal (per-config + tri-state)', () => {
    async function openConfigModal(overrides?: Parameters<typeof buildFetchMock>[0]) {
      const fetchMock = buildFetchMock(overrides);
      global.fetch = fetchMock as unknown as typeof fetch;
      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('Backend Squad');

      const card = screen.getByTestId('team-card-team-1');
      fireEvent.click(within(card).getAllByRole('button')[0]);

      const dialog = await screen.findByRole('dialog');
      await waitFor(() => {
        expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe(
          'Backend Squad',
        );
      });

      fireEvent.click(within(dialog).getByText(/Configure allowed configs/));
      await screen.findByText('Configure Allowed Configs');

      return { queryClient, fetchMock };
    }

    it('renders provider headers + per-config checkboxes', async () => {
      const { queryClient } = await openConfigModal();

      await screen.findByLabelText('Select all claude configs');
      expect(screen.getByLabelText('Select all codex configs')).toBeInTheDocument();

      expect(screen.getByLabelText('Config One')).toBeInTheDocument();
      expect(screen.getByLabelText('Config Two')).toBeInTheDocument();

      queryClient.clear();
    });

    it('shows all providers and configs checked when profile has allow-all (no selections)', async () => {
      const { queryClient } = await openConfigModal({
        teamDetail: {
          ...mockTeamDetail,
          profileIds: ['profile-1'],
          profileConfigSelections: [],
        },
      });

      await screen.findByLabelText('Select all claude configs');
      expect(screen.getByLabelText('Select all claude configs')).toHaveAttribute(
        'data-state',
        'checked',
      );
      expect(screen.getByLabelText('Select all codex configs')).toHaveAttribute(
        'data-state',
        'checked',
      );
      expect(screen.getByLabelText('Config One')).toHaveAttribute('data-state', 'checked');
      expect(screen.getByLabelText('Config Two')).toHaveAttribute('data-state', 'checked');

      queryClient.clear();
    });

    it('shows subset: config-1 checked, config-2 unchecked, providers reflect state', async () => {
      const { queryClient } = await openConfigModal();

      await screen.findByLabelText('Select all claude configs');
      expect(screen.getByLabelText('Config One')).toHaveAttribute('data-state', 'checked');
      expect(screen.getByLabelText('Config Two')).toHaveAttribute('data-state', 'unchecked');
      expect(screen.getByLabelText('Select all claude configs')).toHaveAttribute(
        'data-state',
        'checked',
      );
      expect(screen.getByLabelText('Select all codex configs')).toHaveAttribute(
        'data-state',
        'unchecked',
      );

      queryClient.clear();
    });

    it('deselecting all providers emits remove (Rule 3 — no silent allow-all)', async () => {
      const { queryClient, fetchMock } = await openConfigModal();

      await screen.findByLabelText('Select all claude configs');
      fireEvent.click(screen.getByLabelText('Select all claude configs'));

      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        const putCall = (fetchMock as jest.Mock).mock.calls.find(
          ([url, opts]: [string, RequestInit?]) =>
            typeof url === 'string' && url.startsWith('/api/teams/') && opts?.method === 'PUT',
        );
        if (putCall) {
          const body = JSON.parse(putCall[1].body as string);
          expect(body.profileIds).not.toContain('profile-1');
        }
      });

      queryClient.clear();
    });

    it('indeterminate state when provider has partial config selection', async () => {
      const sameProviderConfigs = [
        {
          id: 'config-1',
          name: 'Config One',
          description: null,
          options: null,
          providerName: 'claude',
        },
        {
          id: 'config-2',
          name: 'Config Two',
          description: null,
          options: null,
          providerName: 'claude',
        },
      ];
      const fetchMock = buildFetchMock({
        teamDetail: {
          ...mockTeamDetail,
          profileIds: ['profile-1'],
          profileConfigSelections: [{ profileId: 'profile-1', configIds: ['config-1'] }],
        },
      });
      (fetchMock as jest.Mock).mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();
          const method = init?.method?.toUpperCase() ?? 'GET';
          if (method === 'GET' && /\/api\/profiles\/[^/]+\/provider-configs/.test(url)) {
            return { ok: true, json: async () => sameProviderConfigs, status: 200 } as Response;
          }
          return (
            buildFetchMock({
              teamDetail: {
                ...mockTeamDetail,
                profileIds: ['profile-1'],
                profileConfigSelections: [{ profileId: 'profile-1', configIds: ['config-1'] }],
              },
            }) as jest.Mock
          )(input, init);
        },
      );
      global.fetch = fetchMock as unknown as typeof fetch;
      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('Backend Squad');
      const card = screen.getByTestId('team-card-team-1');
      fireEvent.click(within(card).getAllByRole('button')[0]);
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => {
        expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe(
          'Backend Squad',
        );
      });
      fireEvent.click(within(dialog).getByText(/Configure allowed configs/));
      await screen.findByText('Configure Allowed Configs');
      await screen.findByLabelText('Select all claude configs');

      const claudeCheckbox = screen.getByLabelText('Select all claude configs');
      expect(claudeCheckbox).toHaveAttribute('data-state', 'indeterminate');

      expect(screen.getByLabelText('Config One')).toHaveAttribute('data-state', 'checked');
      expect(screen.getByLabelText('Config Two')).toHaveAttribute('data-state', 'unchecked');

      queryClient.clear();
    });

    it('name-mode: emits name-keyed selections when toggling provider', () => {
      const onChangeMock = jest.fn();
      const { Wrapper } = createWrapper();

      render(
        <Wrapper>
          <ProviderGroupedConfigSelector
            focusedProfileKey="Coder Profile"
            configsByProfile={{
              'Coder Profile': [
                { key: 'claude-local', label: 'Claude Local', providerName: 'claude' },
                { key: 'codex-local', label: 'Codex Local', providerName: 'codex' },
              ],
            }}
            selections={[{ profileKey: 'Coder Profile', mode: 'allow-all' }]}
            onChange={onChangeMock}
          />
        </Wrapper>,
      );

      const codexCheckbox = screen.getByLabelText('Provider codex');
      fireEvent.click(codexCheckbox);

      expect(onChangeMock).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            profileKey: 'Coder Profile',
            mode: 'subset',
            configKeys: ['claude-local'],
          }),
        ]),
      );
    });

    it('Rule 1 save: allow-all state emits zero profileConfigSelections in PUT', async () => {
      const { queryClient, fetchMock } = await openConfigModal({
        teamDetail: {
          ...mockTeamDetail,
          profileIds: ['profile-1'],
          profileConfigSelections: [],
        },
      });

      await screen.findByLabelText('Select all claude configs');
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        const putCall = (fetchMock as jest.Mock).mock.calls.find(
          ([url, opts]: [string, RequestInit?]) =>
            typeof url === 'string' && url.startsWith('/api/teams/') && opts?.method === 'PUT',
        );
        if (putCall) {
          const body = JSON.parse(putCall[1].body as string);
          expect(body.profileConfigSelections).toEqual([]);
          expect(body.profileIds).toContain('profile-1');
        }
      });

      queryClient.clear();
    });

    it('Rule 2 save: subset emits explicit config IDs in PUT', async () => {
      const { queryClient, fetchMock } = await openConfigModal();

      await screen.findByLabelText('Select all claude configs');
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        const putCall = (fetchMock as jest.Mock).mock.calls.find(
          ([url, opts]: [string, RequestInit?]) =>
            typeof url === 'string' && url.startsWith('/api/teams/') && opts?.method === 'PUT',
        );
        if (putCall) {
          const body = JSON.parse(putCall[1].body as string);
          expect(body.profileConfigSelections).toEqual([
            { profileId: 'profile-1', configIds: ['config-1'] },
          ]);
        }
      });

      queryClient.clear();
    });
  });

  it('shows duplicate team name warning', async () => {
    global.fetch = buildFetchMock() as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });

    await screen.findByText('Backend Squad');

    // Open create dialog
    fireEvent.click(screen.getAllByRole('button', { name: /create team/i })[0]);
    const dialog = await screen.findByRole('dialog');

    // Type existing team name
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Backend Squad' },
    });

    expect(within(dialog).getByText(/already exists/i)).toBeInTheDocument();

    queryClient.clear();
  });

  it('allowTeamLeadCreateAgents checkbox renders and defaults to false in create payload', async () => {
    const fetchMock = buildFetchMock() as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    const { Wrapper, queryClient } = createWrapper();
    render(<TeamsPage />, { wrapper: Wrapper });
    await screen.findByText('Backend Squad');

    fireEvent.click(screen.getAllByRole('button', { name: /create team/i })[0]);
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Allow team lead to create team agents')).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Flagged Team' },
    });

    // Select members by ID (not by index — the allow checkbox shifts indices)
    const memberGamma = document.getElementById('member-agent-3')!;
    const memberDelta = document.getElementById('member-agent-4')!;
    fireEvent.click(memberGamma);
    fireEvent.click(memberDelta);

    fireEvent.change(within(dialog).getByLabelText('Team Lead'), {
      target: { value: 'agent-3' },
    });

    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/teams',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const postCall = fetchMock.mock.calls.find(
      ([url, opts]: [string, RequestInit?]) => url === '/api/teams' && opts?.method === 'POST',
    );
    const body = JSON.parse(postCall![1]!.body as string);
    expect(body.allowTeamLeadCreateAgents).toBe(false);

    queryClient.clear();
  });

  describe('cross-team member filter', () => {
    const agentA = { id: 'agent-a', name: 'Agent A' };
    const agentB = { id: 'agent-b', name: 'Agent B' };
    const agentC = { id: 'agent-c', name: 'Agent C' };
    const agentD = { id: 'agent-d', name: 'Agent D' };

    const makeTeamList = (
      id: string,
      name: string,
      leadId: string,
      leadName: string,
      memberCount: number,
    ) => ({
      id,
      projectId: 'project-1',
      name,
      description: null,
      teamLeadAgentId: leadId,
      teamLeadAgentName: leadName,
      memberCount,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const makeTeamDetail = (
      id: string,
      name: string,
      leadId: string,
      leadName: string,
      memberAgents: Array<{ id: string; name: string }>,
    ) => ({
      id,
      projectId: 'project-1',
      name,
      description: null,
      teamLeadAgentId: leadId,
      teamLeadAgentName: leadName,
      members: memberAgents.map((m) => ({
        agentId: m.id,
        agentName: m.name,
        isLead: m.id === leadId,
        createdAt: '2024-01-01T00:00:00.000Z',
      })),
      profileIds: [] as string[],
      profileConfigSelections: [] as Array<{ profileId: string; configIds: string[] }>,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    it('create dialog hides agents already in another team', async () => {
      const teamXList = makeTeamList('team-x', 'Team X', 'agent-a', 'Agent A', 1);
      const teamXDetail = makeTeamDetail('team-x', 'Team X', 'agent-a', 'Agent A', [agentA]);

      global.fetch = buildFetchMock({
        teams: [teamXList],
        teamDetailsMap: { 'team-x': teamXDetail },
        agents: [agentA, agentB, agentC],
      }) as unknown as typeof fetch;
      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('Team X');

      fireEvent.click(screen.getAllByRole('button', { name: /create team/i })[0]);
      await screen.findByRole('dialog');

      // Agent A is in Team X → hidden
      expect(document.getElementById('member-agent-a')).toBeNull();
      // Agents B, C are unassigned → visible
      expect(document.getElementById('member-agent-b')).toBeTruthy();
      expect(document.getElementById('member-agent-c')).toBeTruthy();

      queryClient.clear();
    });

    it('edit dialog shows own team members plus unassigned agents', async () => {
      const teamXList = makeTeamList('team-x', 'Team X', 'agent-a', 'Agent A', 1);
      const teamXDetail = makeTeamDetail('team-x', 'Team X', 'agent-a', 'Agent A', [agentA]);

      global.fetch = buildFetchMock({
        teams: [teamXList],
        teamDetailsMap: { 'team-x': teamXDetail },
        agents: [agentA, agentB, agentC],
      }) as unknown as typeof fetch;
      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('Team X');

      const card = screen.getByTestId('team-card-team-x');
      fireEvent.click(within(card).getAllByRole('button')[0]);

      const dialog = await screen.findByRole('dialog');
      await waitFor(() => {
        expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Team X');
      });

      // Agent A (own member) → visible and checked
      const checkboxA = document.getElementById('member-agent-a')!;
      expect(checkboxA).toBeTruthy();
      expect(checkboxA).toHaveAttribute('data-state', 'checked');
      // Agents B, C (unassigned) → visible and unchecked
      expect(document.getElementById('member-agent-b')).toBeTruthy();
      expect(document.getElementById('member-agent-c')).toBeTruthy();

      queryClient.clear();
    });

    it('edit dialog hides agents belonging to other teams', async () => {
      const teamXList = makeTeamList('team-x', 'Team X', 'agent-a', 'Agent A', 1);
      const teamYList = makeTeamList('team-y', 'Team Y', 'agent-b', 'Agent B', 1);
      const teamXDetail = makeTeamDetail('team-x', 'Team X', 'agent-a', 'Agent A', [agentA]);
      const teamYDetail = makeTeamDetail('team-y', 'Team Y', 'agent-b', 'Agent B', [agentB]);

      global.fetch = buildFetchMock({
        teams: [teamXList, teamYList],
        teamDetailsMap: { 'team-x': teamXDetail, 'team-y': teamYDetail },
        agents: [agentA, agentB, agentC, agentD],
      }) as unknown as typeof fetch;
      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('Team X');

      const card = screen.getByTestId('team-card-team-x');
      fireEvent.click(within(card).getAllByRole('button')[0]);

      const dialog = await screen.findByRole('dialog');
      await waitFor(() => {
        expect((within(dialog).getByLabelText('Name') as HTMLInputElement).value).toBe('Team X');
      });

      // Agent A (own member) → visible
      expect(document.getElementById('member-agent-a')).toBeTruthy();
      // Agent B (in Team Y) → hidden
      expect(document.getElementById('member-agent-b')).toBeNull();
      // Agents C, D (unassigned) → visible
      expect(document.getElementById('member-agent-c')).toBeTruthy();
      expect(document.getElementById('member-agent-d')).toBeTruthy();

      queryClient.clear();
    });

    it('create dialog shows all agents when no teams exist', async () => {
      global.fetch = buildFetchMock({
        teams: [],
        agents: [agentA, agentB, agentC],
      }) as unknown as typeof fetch;
      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('No teams yet');

      fireEvent.click(screen.getAllByRole('button', { name: /create team/i })[0]);
      await screen.findByRole('dialog');

      expect(document.getElementById('member-agent-a')).toBeTruthy();
      expect(document.getElementById('member-agent-b')).toBeTruthy();
      expect(document.getElementById('member-agent-c')).toBeTruthy();

      queryClient.clear();
    });

    it('create dialog hides multiple agents from another team', async () => {
      const teamYList = makeTeamList('team-y', 'Team Y', 'agent-b', 'Agent B', 2);
      const teamYDetail = makeTeamDetail('team-y', 'Team Y', 'agent-b', 'Agent B', [
        agentB,
        agentC,
      ]);

      global.fetch = buildFetchMock({
        teams: [teamYList],
        teamDetailsMap: { 'team-y': teamYDetail },
        agents: [agentA, agentB, agentC, agentD],
      }) as unknown as typeof fetch;
      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('Team Y');

      fireEvent.click(screen.getAllByRole('button', { name: /create team/i })[0]);
      await screen.findByRole('dialog');

      // Agents B, C in Team Y → hidden
      expect(document.getElementById('member-agent-b')).toBeNull();
      expect(document.getElementById('member-agent-c')).toBeNull();
      // Agents A, D unassigned → visible
      expect(document.getElementById('member-agent-a')).toBeTruthy();
      expect(document.getElementById('member-agent-d')).toBeTruthy();

      queryClient.clear();
    });

    it('shows all agents while team details are loading', async () => {
      const teamXList = makeTeamList('team-x', 'Team X', 'agent-a', 'Agent A', 1);
      const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method?.toUpperCase() ?? 'GET';

        if (method === 'GET' && url.startsWith('/api/teams?')) {
          return jsonResponse({ items: [teamXList], total: 1, limit: 100, offset: 0 });
        }
        if (method === 'GET' && url.startsWith('/api/teams/')) {
          return new Promise<Response>(() => {});
        }
        if (method === 'GET' && url.startsWith('/api/agents?')) {
          return jsonResponse({
            items: [agentA, agentB, agentC, agentD],
            total: 4,
            limit: 100,
            offset: 0,
          });
        }
        if (method === 'GET' && /\/api\/profiles\/[^/]+\/provider-configs/.test(url)) {
          return jsonResponse(mockProviderConfigs);
        }
        if (method === 'GET' && url.startsWith('/api/profiles?')) {
          return jsonResponse({
            items: mockProfiles,
            total: mockProfiles.length,
            limit: 100,
            offset: 0,
          });
        }
        return jsonResponse({});
      });

      global.fetch = fetchMock as unknown as typeof fetch;
      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('Team X');

      fireEvent.click(screen.getAllByRole('button', { name: /create team/i })[0]);
      await screen.findByRole('dialog');

      // Filter hasn't activated — all agents visible
      expect(document.getElementById('member-agent-a')).toBeTruthy();
      expect(document.getElementById('member-agent-b')).toBeTruthy();
      expect(document.getElementById('member-agent-c')).toBeTruthy();
      expect(document.getElementById('member-agent-d')).toBeTruthy();

      queryClient.clear();
    });
  });

  describe('deferred-detail race', () => {
    const teamX = {
      ...mockTeam,
      id: 'team-x',
      name: 'Team X',
      teamLeadAgentId: 'agent-1',
      teamLeadAgentName: 'Agent Alpha',
      memberCount: 1,
    };
    const teamY = {
      ...mockTeam,
      id: 'team-y',
      name: 'Team Y',
      teamLeadAgentId: 'agent-2',
      teamLeadAgentName: 'Agent Beta',
      memberCount: 1,
    };

    const teamXDetail = {
      ...mockTeamDetail,
      id: 'team-x',
      name: 'Team X',
      teamLeadAgentId: 'agent-1',
      teamLeadAgentName: 'Agent Alpha',
      maxMembers: 5,
      maxConcurrentTasks: 5,
      allowTeamLeadCreateAgents: false,
      members: [
        { agentId: 'agent-1', agentName: 'Agent Alpha', isLead: true, createdAt: '2024-01-01' },
      ],
      profileIds: [],
      profileConfigSelections: [],
    };
    const teamYDetail = {
      ...mockTeamDetail,
      id: 'team-y',
      name: 'Team Y',
      teamLeadAgentId: 'agent-2',
      teamLeadAgentName: 'Agent Beta',
      maxMembers: 5,
      maxConcurrentTasks: 5,
      allowTeamLeadCreateAgents: false,
      members: [
        { agentId: 'agent-2', agentName: 'Agent Beta', isLead: true, createdAt: '2024-01-01' },
      ],
      profileIds: [],
      profileConfigSelections: [],
    };

    function createDeferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it('create flow: stale selection pruned after deferred team detail resolves', async () => {
      const teamYDeferred = createDeferred<Response>();

      const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method?.toUpperCase() ?? 'GET';
        if (method === 'GET' && url.startsWith('/api/teams?'))
          return jsonResponse({ items: [teamX, teamY], total: 2, limit: 100, offset: 0 });
        if (method === 'GET' && url.includes('/api/teams/team-x')) return jsonResponse(teamXDetail);
        if (method === 'GET' && url.includes('/api/teams/team-y')) return teamYDeferred.promise;
        if (method === 'GET' && url.startsWith('/api/agents?'))
          return jsonResponse({
            items: mockAgents,
            total: mockAgents.length,
            limit: 100,
            offset: 0,
          });
        if (method === 'GET' && url.startsWith('/api/profiles?'))
          return jsonResponse({
            items: mockProfiles,
            total: mockProfiles.length,
            limit: 100,
            offset: 0,
          });
        if (method === 'GET' && /\/api\/profiles\/[^/]+\/provider-configs/.test(url))
          return jsonResponse(mockProviderConfigs);
        if (method === 'POST' && url === '/api/teams') return jsonResponse(mockTeamDetail);
        return jsonResponse({});
      }) as unknown as typeof fetch;
      global.fetch = fetchMock;

      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });
      await screen.findByText('Team X');

      fireEvent.click(screen.getAllByRole('button', { name: /create team/i })[0]);
      const dialog = await screen.findByRole('dialog');

      expect(document.getElementById('member-agent-2')).toBeTruthy();
      fireEvent.click(document.getElementById('member-agent-2')!);
      fireEvent.click(document.getElementById('member-agent-3')!);
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'New Team' } });
      fireEvent.change(within(dialog).getByLabelText('Team Lead'), {
        target: { value: 'agent-2' },
      });

      expect(document.getElementById('member-agent-2')).toHaveAttribute('data-state', 'checked');

      await act(async () => {
        teamYDeferred.resolve(jsonResponse(teamYDetail));
      });

      await waitFor(() => {
        expect(document.getElementById('member-agent-2')).toBeNull();
      });

      const leadSelect = within(dialog).getByLabelText('Team Lead') as HTMLSelectElement;
      expect(leadSelect.value).not.toBe('agent-2');

      const submitBtn = within(dialog).getByRole('button', { name: /^create$/i });
      expect(submitBtn).toBeDisabled();

      queryClient.clear();
    });

    it('edit flow: editTeamDetail resolves before agentsData — original membership preserved', async () => {
      const agentsDeferred = createDeferred<Response>();

      const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method?.toUpperCase() ?? 'GET';
        if (method === 'GET' && url.startsWith('/api/teams?'))
          return jsonResponse({ items: [{ ...mockTeam }], total: 1, limit: 100, offset: 0 });
        if (method === 'GET' && url.startsWith('/api/teams/')) return jsonResponse(mockTeamDetail);
        if (method === 'GET' && url.startsWith('/api/agents?')) return agentsDeferred.promise;
        if (method === 'GET' && url.startsWith('/api/profiles?'))
          return jsonResponse({
            items: mockProfiles,
            total: mockProfiles.length,
            limit: 100,
            offset: 0,
          });
        if (method === 'GET' && /\/api\/profiles\/[^/]+\/provider-configs/.test(url))
          return jsonResponse(mockProviderConfigs);
        return jsonResponse({});
      }) as unknown as typeof fetch;
      global.fetch = fetchMock;

      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('Backend Squad');
      const card = screen.getByTestId('team-card-team-1');
      const buttons = within(card).getAllByRole('button');
      fireEvent.click(buttons[0]);
      const dialog = await screen.findByRole('dialog');

      const nameInput = within(dialog).getByLabelText('Name') as HTMLInputElement;
      await waitFor(() => expect(nameInput.value).toBe('Backend Squad'));

      await act(async () => {
        agentsDeferred.resolve(
          jsonResponse({ items: mockAgents, total: mockAgents.length, limit: 100, offset: 0 }),
        );
      });

      await waitFor(() => {
        expect(document.getElementById('member-agent-1')).toBeTruthy();
      });
      expect(document.getElementById('member-agent-1')).toHaveAttribute('data-state', 'checked');
      expect(document.getElementById('member-agent-2')).toHaveAttribute('data-state', 'checked');

      const leadSelect = within(dialog).getByLabelText('Team Lead') as HTMLSelectElement;
      expect(leadSelect.value).toBe('agent-1');

      const submitBtn = within(dialog).getByRole('button', { name: /^save$/i });
      expect(submitBtn).not.toBeDisabled();

      queryClient.clear();
    });

    it('edit flow: select cross-team agent while team-Y detail pending → resolve → pruned', async () => {
      const teamYDeferred = createDeferred<Response>();

      const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method?.toUpperCase() ?? 'GET';
        if (method === 'GET' && url.startsWith('/api/teams?'))
          return jsonResponse({ items: [teamX, teamY], total: 2, limit: 100, offset: 0 });
        if (method === 'GET' && url.includes('/api/teams/team-x')) return jsonResponse(teamXDetail);
        if (method === 'GET' && url.includes('/api/teams/team-y')) return teamYDeferred.promise;
        if (method === 'GET' && url.startsWith('/api/agents?'))
          return jsonResponse({
            items: mockAgents,
            total: mockAgents.length,
            limit: 100,
            offset: 0,
          });
        if (method === 'GET' && url.startsWith('/api/profiles?'))
          return jsonResponse({
            items: mockProfiles,
            total: mockProfiles.length,
            limit: 100,
            offset: 0,
          });
        if (method === 'GET' && /\/api\/profiles\/[^/]+\/provider-configs/.test(url))
          return jsonResponse(mockProviderConfigs);
        if (method === 'PUT' && url.startsWith('/api/teams/')) return jsonResponse(teamXDetail);
        return jsonResponse({});
      }) as unknown as typeof fetch;
      global.fetch = fetchMock;

      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });
      await screen.findByText('Team X');

      const card = screen.getByTestId('team-card-team-x');
      const buttons = within(card).getAllByRole('button');
      fireEvent.click(buttons[0]);
      await screen.findByRole('dialog');

      await waitFor(() => {
        expect(document.getElementById('member-agent-1')).toBeTruthy();
      });
      expect(document.getElementById('member-agent-1')).toHaveAttribute('data-state', 'checked');

      expect(document.getElementById('member-agent-2')).toBeTruthy();
      fireEvent.click(document.getElementById('member-agent-2')!);
      expect(document.getElementById('member-agent-2')).toHaveAttribute('data-state', 'checked');

      await act(async () => {
        teamYDeferred.resolve(jsonResponse(teamYDetail));
      });

      await waitFor(() => {
        expect(document.getElementById('member-agent-2')).toBeNull();
      });

      expect(document.getElementById('member-agent-1')).toHaveAttribute('data-state', 'checked');
      expect(document.getElementById('member-agent-3')).toBeTruthy();

      queryClient.clear();
    });
  });

  describe('form stability — editInitialData memoization', () => {
    it('edit dialog preserves user name edits across unrelated query refetch', async () => {
      const fetchMock = buildFetchMock();
      global.fetch = fetchMock as unknown as typeof fetch;

      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('Backend Squad');

      const card = screen.getByTestId('team-card-team-1');
      const buttons = within(card).getAllByRole('button');
      fireEvent.click(buttons[0]);
      const dialog = await screen.findByRole('dialog');

      const nameInput = within(dialog).getByLabelText('Name') as HTMLInputElement;
      await waitFor(() => expect(nameInput.value).toBe('Backend Squad'));

      fireEvent.change(nameInput, { target: { value: 'Renamed Squad' } });
      expect(nameInput.value).toBe('Renamed Squad');

      await act(async () => {
        queryClient.setQueryData(['teams-page-agents', 'project-1'], {
          items: mockAgents,
          total: mockAgents.length,
          limit: 100,
          offset: 0,
        });
      });

      expect(nameInput.value).toBe('Renamed Squad');

      queryClient.clear();
    });

    it('edit dialog preserves member selection across unrelated query refetch', async () => {
      const fetchMock = buildFetchMock();
      global.fetch = fetchMock as unknown as typeof fetch;

      const { Wrapper, queryClient } = createWrapper();
      render(<TeamsPage />, { wrapper: Wrapper });

      await screen.findByText('Backend Squad');

      const card = screen.getByTestId('team-card-team-1');
      const buttons = within(card).getAllByRole('button');
      fireEvent.click(buttons[0]);
      await screen.findByRole('dialog');

      await waitFor(() => {
        expect(document.getElementById('member-agent-1')).toHaveAttribute('data-state', 'checked');
      });

      fireEvent.click(document.getElementById('member-agent-3')!);
      expect(document.getElementById('member-agent-3')).toHaveAttribute('data-state', 'checked');

      await act(async () => {
        queryClient.setQueryData(['teams-page-agents', 'project-1'], {
          items: mockAgents,
          total: mockAgents.length,
          limit: 100,
          offset: 0,
        });
      });

      expect(document.getElementById('member-agent-3')).toHaveAttribute('data-state', 'checked');
      expect(document.getElementById('member-agent-1')).toHaveAttribute('data-state', 'checked');

      queryClient.clear();
    });
  });
});
