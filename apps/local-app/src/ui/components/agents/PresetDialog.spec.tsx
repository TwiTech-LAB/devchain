import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PresetDialog } from './PresetDialog';

// ResizeObserver mock for Radix components
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Mock useToast
const mockToast = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Mock fetch
const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

// Helper to mock profile configs response
const mockProfileConfigs = (
  profileConfigs: Record<
    string,
    Array<{ id: string; name: string; providerId?: string; model?: string }>
  >,
  providerModels: Record<string, Array<{ id?: string; name: string }>> = {},
  providerEfforts: Record<
    string,
    {
      efforts: Array<{ name: string }>;
      supportsEffort: boolean;
      requiresModelForEffort: boolean;
    }
  > = {},
) => {
  mockFetch.mockImplementation((url: string) => {
    if (url.startsWith('/api/teams?')) {
      return Promise.resolve({ ok: true, json: async () => ({ items: [], total: 0 }) });
    }
    if (url.includes('/provider-configs')) {
      // Extract profileId from URL like /api/profiles/{profileId}/provider-configs
      const match = url.match(/\/profiles\/([^\/]+)\/provider-configs/);
      if (match) {
        const profileId = match[1];
        const configs = profileConfigs[profileId] || [];
        return Promise.resolve({
          ok: true,
          json: async () => configs,
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => [],
      });
    }
    if (url.includes('/providers/') && url.includes('/models')) {
      const match = url.match(/\/providers\/([^\/]+)\/models/);
      if (match) {
        const providerId = match[1];
        return Promise.resolve({
          ok: true,
          json: async () => providerModels[providerId] || [],
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => [],
      });
    }
    if (url.includes('/providers/') && url.includes('/efforts')) {
      const match = url.match(/\/providers\/([^\/]+)\/efforts/);
      if (match) {
        const providerId = match[1];
        return Promise.resolve({
          ok: true,
          json: async () => {
            const catalog = providerEfforts[providerId] || {
              efforts: [],
              supportsEffort: false,
              requiresModelForEffort: false,
            };
            return {
              ...catalog,
              efforts: catalog.efforts.map((effort, index) => ({
                id: `effort-${index}`,
                providerId,
                position: index,
                createdAt: '2026-10-08T00:00:00.000Z',
                updatedAt: '2026-10-08T00:00:00.000Z',
                ...effort,
              })),
            };
          },
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          efforts: [],
          supportsEffort: false,
          requiresModelForEffort: false,
        }),
      });
    }
    // Preset create/update API
    return Promise.resolve({
      ok: true,
      json: async () => ({ name: 'new-preset', description: null, agentConfigs: [] }),
    });
  });
};

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const mockAgents = [
  {
    id: 'agent-1',
    name: 'Coder',
    profileId: 'profile-1',
    providerConfigId: 'config-1',
    modelOverride: 'anthropic/claude-sonnet-4-5',
    providerConfig: { id: 'config-1', name: 'claude-config' },
  },
  {
    id: 'agent-2',
    name: 'Reviewer',
    profileId: 'profile-1',
    providerConfigId: 'config-2',
    modelOverride: null,
    providerConfig: { id: 'config-2', name: 'codex-config' },
  },
  {
    id: 'agent-3',
    name: 'Tester',
    profileId: 'profile-2',
    providerConfigId: null,
    providerConfig: null,
  },
];

describe('PresetDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    projectId: 'project-123',
    agents: mockAgents,
    existingPresetNames: ['existing-preset'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  describe('team allowed configs', () => {
    const hint =
      'This is a template preset. A template import or upgrade replaces it. Rename it to keep your changes.';

    beforeEach(() => {
      mockProfileConfigs({
        'coder-profile': [
          { id: 'opus-id', name: 'opus' },
          { id: 'sonnet-id', name: 'sonnet' },
        ],
        'reviewer-profile': [{ id: 'review-id', name: 'review' }],
      });
      const fallback = mockFetch.getMockImplementation()!;
      const teams = {
        builders: {
          id: 'builders',
          name: 'Builders',
          profileIds: ['coder-profile', 'reviewer-profile'],
          profileConfigSelections: [{ profileId: 'coder-profile', configIds: ['opus-id'] }],
        },
        observers: {
          id: 'observers',
          name: 'Observers',
          profileIds: ['reviewer-profile'],
          profileConfigSelections: [],
        },
        unlinked: {
          id: 'unlinked',
          name: 'Unlinked',
          profileIds: [],
          profileConfigSelections: [],
        },
      };
      const reads: Record<string, unknown> = {
        '/api/teams?projectId=project-123': {
          items: [teams.builders, teams.observers],
          total: 3,
        },
        '/api/teams?projectId=project-123&offset=2': { items: [teams.unlinked], total: 3 },
        '/api/teams/builders': teams.builders,
        '/api/teams/observers': teams.observers,
        '/api/teams/unlinked': teams.unlinked,
        '/api/profiles?projectId=project-123': {
          items: [
            { id: 'coder-profile', name: 'Coder' },
            { id: 'reviewer-profile', name: 'Reviewer' },
          ],
        },
      };
      mockFetch.mockImplementation((url: string, init?: RequestInit) =>
        Object.hasOwn(reads, url)
          ? Promise.resolve({ ok: true, json: async () => reads[url] })
          : fallback(url, init),
      );
    });

    function savedBody(method: string): unknown {
      const call = mockFetch.mock.calls.find(
        ([url, init]) => url === '/api/projects/project-123/presets' && init?.method === method,
      );
      return call ? JSON.parse(call[1].body) : undefined;
    }

    // The dialog boundary verifies that fetched ID selections become names in the save payload.
    it('seeds linked teams from current configs and saves checked teams only', async () => {
      const user = userEvent.setup();
      renderWithQueryClient(<PresetDialog {...defaultProps} agents={[]} />);

      expect(await screen.findByRole('checkbox', { name: 'Include Builders' })).toBeChecked();
      const observers = screen.getByRole('checkbox', { name: 'Include Observers' });
      expect(observers).toBeChecked();
      expect(screen.getByText('Coder: opus · Reviewer: All')).toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: 'Include Unlinked' })).toBeNull();
      await user.click(observers);
      await user.type(screen.getByLabelText('Name *'), 'Team preset');
      await user.click(screen.getByRole('button', { name: 'Save Preset' }));

      await waitFor(() =>
        expect(savedBody('POST')).toEqual({
          name: 'Team preset',
          description: null,
          agentConfigs: [],
          teamConfigs: [
            {
              teamName: 'Builders',
              profileSelections: [{ profileName: 'Coder', configNames: ['opus'] }],
            },
          ],
        }),
      );
    });

    it('saves an edited team-only preset with resolved names and omits missing entries', async () => {
      const user = userEvent.setup();
      renderWithQueryClient(
        <PresetDialog
          {...defaultProps}
          agents={[]}
          presetToEdit={{
            name: 'Team preset',
            agentConfigs: [],
            teamConfigs: [
              {
                teamName: 'builders',
                profileSelections: [
                  { profileName: 'Coder', configNames: ['opus'] },
                  { profileName: ' coder ', configNames: [' SONNET ', 'retired'] },
                  { profileName: 'Removed', configNames: ['old'] },
                ],
              },
              { teamName: 'builders', profileSelections: [] },
              { teamName: 'Gone', profileSelections: [] },
            ],
          }}
        />,
      );

      expect(await screen.findByRole('checkbox', { name: 'Include Builders' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: 'Include Observers' })).not.toBeChecked();
      expect(screen.getByText('Missing team: Gone')).toBeInTheDocument();
      expect(screen.getByText('Missing profile: Removed (builders)')).toBeInTheDocument();
      expect(screen.getByText(/Missing config: retired/)).toBeInTheDocument();
      expect(screen.getByText('Coder: opus, sonnet · Reviewer: All')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Configure Builders' }));
      const modal = within(
        await screen.findByRole('dialog', { name: 'Configure Allowed Configs' }),
      );
      expect(modal.getByRole('checkbox', { name: 'opus' })).toBeChecked();
      expect(modal.getByRole('checkbox', { name: 'sonnet' })).toBeChecked();
      await user.click(modal.getByRole('button', { name: 'Cancel' }));
      await user.click(screen.getByRole('checkbox', { name: 'Include Observers' }));
      await user.click(screen.getByRole('button', { name: 'Update Preset' }));

      await waitFor(() =>
        expect(savedBody('PATCH')).toEqual({
          presetName: 'Team preset',
          updates: {
            name: 'Team preset',
            description: null,
            agentConfigs: [],
            teamConfigs: [
              {
                teamName: 'Builders',
                profileSelections: [{ profileName: 'Coder', configNames: ['opus', 'sonnet'] }],
              },
              { teamName: 'Observers', profileSelections: [] },
            ],
          },
        }),
      );
    });

    // The dialog is the layer that turns the stored names into the saved payload.
    it('keeps a stored restriction when none of its config names resolve', async () => {
      const user = userEvent.setup();
      const teamConfigs = [
        {
          teamName: 'Builders',
          profileSelections: [{ profileName: 'Coder', configNames: ['retired'] }],
        },
      ];
      renderWithQueryClient(
        <PresetDialog
          {...defaultProps}
          agents={[]}
          presetToEdit={{ name: 'Team preset', agentConfigs: [], teamConfigs }}
        />,
      );

      expect(await screen.findByText('Coder: retired · Reviewer: All')).toBeInTheDocument();
      expect(screen.getByText('Missing config: retired (Builders / Coder)')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Update Preset' }));

      await waitFor(() =>
        expect(savedBody('PATCH')).toEqual({
          presetName: 'Team preset',
          updates: { name: 'Team preset', description: null, agentConfigs: [], teamConfigs },
        }),
      );
    });

    it('requires a config for every linked profile before saving the preset modal', async () => {
      const user = userEvent.setup();
      renderWithQueryClient(<PresetDialog {...defaultProps} />);
      await user.click(await screen.findByRole('button', { name: 'Configure Builders' }));
      const modal = within(
        await screen.findByRole('dialog', { name: 'Configure Allowed Configs' }),
      );
      await user.click(modal.getByRole('checkbox', { name: 'opus' }));
      expect(modal.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(modal.getByRole('button', { name: 'Coder 0 selected' })).toBeInTheDocument();
      await user.click(modal.getByRole('checkbox', { name: 'sonnet' }));
      await user.click(modal.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Coder: sonnet · Reviewer: All')).toBeInTheDocument();
    });

    it.each([undefined, 'user'] as const)(
      'shows the template hint based on origin %s',
      (origin) => {
        renderWithQueryClient(
          <PresetDialog
            {...defaultProps}
            presetToEdit={{ name: 'Existing', agentConfigs: [], origin }}
          />,
        );
        expect(screen.queryByText(hint) !== null).toBe(origin !== 'user');
      },
    );
  });

  describe('rendering - create mode', () => {
    beforeEach(() => {
      mockProfileConfigs({
        'profile-1': [
          { id: 'config-1', name: 'claude-config' },
          { id: 'config-2', name: 'codex-config' },
        ],
        'profile-2': [{ id: 'config-3', name: 'gpt-config' }],
      });
    });

    it('shows create preset fields, selection count and disabled save', () => {
      renderWithQueryClient(<PresetDialog {...defaultProps} />);
      {
        expect(screen.getByText('Save as Preset')).toBeInTheDocument();
      }
      {
        expect(screen.getByText('Agent Configurations')).toBeInTheDocument();
        expect(screen.getByText('2 selected')).toBeInTheDocument();
      }
      {
        expect(screen.getByRole('button', { name: 'Save Preset' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      }
      {
        const saveButton = screen.getByRole('button', { name: 'Save Preset' });
        expect(saveButton).toBeDisabled();
      }
    });

    it('shows all profiled agents with controls and assigned selection', async () => {
      mockProfileConfigs({
        'profile-1': [
          { id: 'config-1', name: 'claude-config' },
          { id: 'config-2', name: 'codex-config' },
        ],
        'profile-2': [{ id: 'config-3', name: 'gpt-config' }],
      });
      renderWithQueryClient(<PresetDialog {...defaultProps} />);
      {
        await waitFor(() => {
          expect(screen.getByText('Coder')).toBeInTheDocument();
          expect(screen.getByText('Reviewer')).toBeInTheDocument();
          expect(screen.getByText('Tester')).toBeInTheDocument(); // Unassigned agent now shown
        });
      }
      {
        await waitFor(() => {
          expect(screen.getByText('Coder')).toBeInTheDocument();
        });
        const checkboxes = screen.getAllByRole('checkbox');
        expect(checkboxes).toHaveLength(3);
        const selects = screen.getAllByRole('combobox');
        expect(selects).toHaveLength(3);
      }
      {
        await waitFor(() => {
          expect(screen.getByText('Coder')).toBeInTheDocument();
        });
        const checkboxes = screen.getAllByRole('checkbox');
        expect(checkboxes[0]).toBeChecked();
        expect(checkboxes[1]).toBeChecked();
        expect(checkboxes[2]).not.toBeChecked();
      }
    });
  });

  describe('rendering - edit mode', () => {
    beforeEach(() => {
      mockProfileConfigs({
        'profile-1': [
          { id: 'config-1', name: 'claude-config' },
          { id: 'config-2', name: 'codex-config' },
        ],
        'profile-2': [{ id: 'config-3', name: 'gpt-config' }],
      });
    });

    const mockPreset = {
      name: 'existing-preset',
      description: 'Test preset description',
      agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
    };

    it('shows edit preset fields, selection count and update action', () => {
      renderWithQueryClient(<PresetDialog {...defaultProps} presetToEdit={mockPreset} />);
      {
        expect(screen.getByText('Edit Preset')).toBeInTheDocument();
      }
      {
        expect(screen.getByLabelText('Name *')).toHaveValue('existing-preset');
        expect(screen.getByLabelText('Description')).toHaveValue('Test preset description');
      }
      {
        expect(screen.getByText('1 selected')).toBeInTheDocument();
      }
      {
        expect(screen.getByRole('button', { name: 'Update Preset' })).toBeInTheDocument();
      }
      {
        expect(
          screen.queryByText('A preset with this name already exists'),
        ).not.toBeInTheDocument();
      }
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      mockProfileConfigs({
        'profile-1': [
          { id: 'config-1', name: 'claude-config' },
          { id: 'config-2', name: 'codex-config' },
        ],
        'profile-2': [{ id: 'config-3', name: 'gpt-config' }],
      });
    });

    it('shows validation error for empty name', async () => {
      renderWithQueryClient(<PresetDialog {...defaultProps} />);

      const saveButton = screen.getByRole('button', { name: 'Save Preset' });
      await userEvent.click(saveButton);

      expect(screen.getByText('Name is required')).toBeInTheDocument();
    });

    it('shows validation error for duplicate name', async () => {
      renderWithQueryClient(<PresetDialog {...defaultProps} />);

      const nameInput = screen.getByLabelText('Name *');
      await userEvent.type(nameInput, 'existing-preset');

      const saveButton = screen.getByRole('button', { name: 'Save Preset' });
      await userEvent.click(saveButton);

      expect(screen.getByText('A preset with this name already exists')).toBeInTheDocument();
    });
  });

  describe('create mode interactions', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockProfileConfigs({
        'profile-1': [
          { id: 'config-1', name: 'claude-config' },
          { id: 'config-2', name: 'codex-config' },
        ],
        'profile-2': [{ id: 'config-3', name: 'gpt-config' }],
      });
    });

    it('allows entering name and description', async () => {
      renderWithQueryClient(<PresetDialog {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Name *')).toBeInTheDocument();
      });

      const nameInput = screen.getByLabelText('Name *');
      const descInput = screen.getByLabelText('Description');

      await userEvent.type(nameInput, 'my-preset');
      await userEvent.type(descInput, 'My test preset');

      expect(nameInput).toHaveValue('my-preset');
      expect(descInput).toHaveValue('My test preset');
    });
  });

  describe('model override selection', () => {
    beforeEach(() => {
      mockProfileConfigs(
        {
          'profile-1': [
            { id: 'config-1', name: 'claude-config', providerId: 'provider-claude' },
            {
              id: 'config-2',
              name: 'codex-config',
              providerId: 'provider-codex',
              model: 'gpt-4o',
            },
          ],
          'profile-2': [{ id: 'config-3', name: 'gpt-config', providerId: 'provider-openai' }],
        },
        {
          'provider-claude': [
            { id: 'm1', name: 'anthropic/claude-sonnet-4-5' },
            { id: 'm2', name: 'anthropic/claude-opus-4-1' },
          ],
          'provider-codex': [{ id: 'm3', name: 'gpt-4o' }],
        },
      );
    });

    it('shows model selectors with the current override selected', async () => {
      renderWithQueryClient(<PresetDialog {...defaultProps} />);
      {
        await waitFor(() => {
          expect(screen.getByTestId('preset-model-select-agent-1')).toBeInTheDocument();
          expect(screen.getByTestId('preset-model-select-agent-2')).toBeInTheDocument();
        });
      }
      {
        await waitFor(() => {
          expect(screen.getByTestId('preset-model-select-agent-1')).toHaveTextContent(
            'claude-sonnet-4-5',
          );
        });
      }
    });

    it('hides model select when provider has no models', async () => {
      mockProfileConfigs({
        'profile-1': [
          { id: 'config-1', name: 'claude-config', providerId: 'provider-claude' },
          { id: 'config-2', name: 'codex-config', providerId: 'provider-codex' },
        ],
      });

      renderWithQueryClient(<PresetDialog {...defaultProps} />);

      await waitFor(() => {
        expect(screen.queryByTestId('preset-model-select-agent-1')).not.toBeInTheDocument();
      });
    });

    it('preselects saved model override in edit mode', async () => {
      const presetToEdit = {
        name: 'preset-with-model',
        description: 'Preset with model override',
        agentConfigs: [
          {
            agentName: 'Coder',
            providerConfigName: 'claude-config',
            modelOverride: 'anthropic/claude-opus-4-1',
          },
        ],
      };

      renderWithQueryClient(<PresetDialog {...defaultProps} presetToEdit={presetToEdit} />);

      await waitFor(() => {
        expect(screen.getByTestId('preset-model-select-agent-1')).toHaveTextContent(
          'claude-opus-4-1',
        );
      });
    });

    it('resets model override to the Default of the new provider config, named by its model', async () => {
      renderWithQueryClient(<PresetDialog {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('preset-config-select-agent-1')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByTestId('preset-config-select-agent-1'));
      await userEvent.click(await screen.findByRole('option', { name: 'codex-config' }));

      await waitFor(() => {
        expect(screen.getByTestId('preset-model-select-agent-1')).toHaveTextContent(
          'Default (gpt-4o)',
        );
      });
    });

    it('saves modelOverride values in preset payload', async () => {
      renderWithQueryClient(<PresetDialog {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('2 selected')).toBeInTheDocument();
      });

      const nameInput = await screen.findByLabelText('Name *');
      await userEvent.type(nameInput, 'preset-with-model-overrides');
      const saveButton = screen.getByRole('button', { name: 'Save Preset' });
      await waitFor(() => {
        expect(saveButton).toBeEnabled();
      });
      await userEvent.click(saveButton);

      await waitFor(() => {
        const createCall = mockFetch.mock.calls.find(
          ([url, init]) =>
            typeof url === 'string' &&
            url.endsWith('/api/projects/project-123/presets') &&
            typeof init === 'object' &&
            init !== null &&
            (init as { method?: string }).method === 'POST',
        );
        expect(createCall).toBeDefined();

        const body = JSON.parse((createCall![1] as { body: string }).body);
        expect(body.agentConfigs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              agentName: 'Coder',
              providerConfigName: 'claude-config',
              modelOverride: 'anthropic/claude-sonnet-4-5',
            }),
            expect.objectContaining({
              agentName: 'Reviewer',
              providerConfigName: 'codex-config',
              modelOverride: null,
            }),
          ]),
        );
      });
    });
  });

  describe('missing config handling', () => {
    const mockPresetWithMissingConfig = {
      name: 'broken-preset',
      description: 'Preset with deleted config',
      agentConfigs: [
        { agentName: 'Coder', providerConfigName: 'deleted-config' }, // This config doesn't exist
      ],
    };

    beforeEach(() => {
      mockProfileConfigs({
        'profile-1': [
          { id: 'config-1', name: 'claude-config' },
          { id: 'config-2', name: 'codex-config' },
        ],
        'profile-2': [],
      });
    });

    it('agent stays selected when config is missing so user can fix', async () => {
      renderWithQueryClient(
        <PresetDialog {...defaultProps} presetToEdit={mockPresetWithMissingConfig} />,
      );

      await waitFor(() => {
        expect(screen.getByText('Coder')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');
      const coderCheckbox = checkboxes[0];

      // Agent should remain checked even with missing config
      expect(coderCheckbox).toBeChecked();

      // The select should exist and be interactive (has other options available)
      const coderSelect = screen.getAllByRole('combobox')[0];
      await waitFor(() => expect(coderSelect).not.toBeDisabled());
    });
  });

  describe('no configs available', () => {
    beforeEach(() => {
      // Mock empty configs for profile
      mockFetch.mockImplementation((url: string) => {
        if (url.startsWith('/api/teams?')) {
          return Promise.resolve({ ok: true, json: async () => ({ items: [], total: 0 }) });
        }
        if (url.includes('/provider-configs')) {
          return Promise.resolve({
            ok: true,
            json: async () => [], // No configs available
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ name: 'new-preset', description: null, agentConfigs: [] }),
        });
      });
    });

    it('shows disabled select when profile has no configs', async () => {
      renderWithQueryClient(<PresetDialog {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Coder')).toBeInTheDocument();
      });

      const selects = screen.getAllByRole('combobox');
      const coderSelect = selects[0];

      // Select should be disabled when no configs available
      expect(coderSelect).toBeDisabled();
    });
  });

  describe('effortOverride parity with modelOverride', () => {
    const effortAgents = [
      {
        id: 'agent-1',
        name: 'Coder',
        profileId: 'profile-1',
        providerConfigId: 'config-1',
        modelOverride: 'opus',
        effortOverride: 'high',
        providerConfig: { id: 'config-1', name: 'claude-config' },
      },
      {
        id: 'agent-2',
        name: 'Reviewer',
        profileId: 'profile-1',
        providerConfigId: 'config-2',
        modelOverride: null,
        effortOverride: null,
        providerConfig: { id: 'config-2', name: 'codex-config' },
      },
    ];

    const setupEffortMocks = (
      efforts = {
        efforts: [{ name: 'high' }, { name: 'low' }],
        supportsEffort: true,
        requiresModelForEffort: false,
      },
    ) => {
      mockProfileConfigs(
        {
          'profile-1': [
            { id: 'config-1', name: 'claude-config', providerId: 'provider-1' },
            { id: 'config-2', name: 'codex-config', providerId: 'provider-1' },
          ],
        },
        { 'provider-1': [{ id: 'm1', name: 'opus' }] },
        { 'provider-1': efforts },
      );
    };

    const findCreateBody = () => {
      const createCall = mockFetch.mock.calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url.endsWith('/api/projects/project-123/presets') &&
          typeof init === 'object' &&
          (init as { method?: string }).method === 'POST',
      );
      return JSON.parse((createCall![1] as { body: string }).body);
    };

    it('auto-populates effortOverride from agents on create and includes it in the save payload', async () => {
      setupEffortMocks();
      renderWithQueryClient(<PresetDialog {...defaultProps} agents={effortAgents} />);

      const nameInput = await screen.findByLabelText('Name *');
      await userEvent.type(nameInput, 'effort-preset');
      const saveButton = screen.getByRole('button', { name: 'Save Preset' });
      await waitFor(() => expect(saveButton).toBeEnabled());
      await userEvent.click(saveButton);

      await waitFor(() => {
        const body = findCreateBody();
        expect(body.agentConfigs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              agentName: 'Coder',
              effortOverride: 'high',
            }),
            expect.objectContaining({
              agentName: 'Reviewer',
              effortOverride: null,
            }),
          ]),
        );
      });
    });

    it('edit mode preserves existing preset effortOverride values on save', async () => {
      setupEffortMocks();
      renderWithQueryClient(
        <PresetDialog
          {...defaultProps}
          presetToEdit={{
            name: 'existing-effort-preset',
            description: null,
            agentConfigs: [
              {
                agentName: 'Coder',
                providerConfigName: 'claude-config',
                modelOverride: 'opus',
                effortOverride: 'high',
              },
            ],
          }}
          agents={effortAgents}
        />,
      );

      const saveButton = screen.getByRole('button', { name: 'Update Preset' });
      await waitFor(() => expect(saveButton).toBeEnabled());
      await userEvent.click(saveButton);

      await waitFor(() => {
        const updateCall = mockFetch.mock.calls.find(
          ([url, init]) =>
            typeof url === 'string' &&
            url.endsWith('/api/projects/project-123/presets') &&
            (init as { method?: string }).method === 'PATCH',
        );
        expect(updateCall).toBeDefined();
        const body = JSON.parse((updateCall![1] as { body: string }).body);
        expect(body.updates.agentConfigs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              agentName: 'Coder',
              effortOverride: 'high',
            }),
          ]),
        );
      });
    });

    it('does not render the effort selector when supportsEffort is false', async () => {
      // No efforts mock → supportsEffort defaults false
      mockProfileConfigs(
        { 'profile-1': [{ id: 'config-1', name: 'claude-config', providerId: 'provider-1' }] },
        { 'provider-1': [{ id: 'm1', name: 'opus' }] },
      );
      renderWithQueryClient(<PresetDialog {...defaultProps} agents={effortAgents} />);

      await screen.findByText('Coder');
      expect(screen.queryByTestId('preset-effort-select-agent-1')).not.toBeInTheDocument();
    });

    it('renders the effort selector enabled when supported with a non-empty catalog', async () => {
      setupEffortMocks();
      renderWithQueryClient(<PresetDialog {...defaultProps} agents={effortAgents} />);

      const effortSelect = await screen.findByTestId('preset-effort-select-agent-1');
      expect(effortSelect).not.toBeDisabled();
    });

    it('disables the effort selector when requiresModelForEffort and no model is resolvable', async () => {
      // Coder agent has modelOverride 'opus' (resolvable); Reviewer has null modelOverride.
      // Use a config with no structured model so Reviewer is not resolvable.
      setupEffortMocks({
        efforts: [{ name: 'high' }],
        supportsEffort: true,
        requiresModelForEffort: true,
      });
      renderWithQueryClient(<PresetDialog {...defaultProps} agents={effortAgents} />);

      await screen.findByText('Reviewer');
      const reviewerEffortSelect = await screen.findByTestId('preset-effort-select-agent-2');
      // Reviewer has no modelOverride and config has no structured model → disabled
      expect(reviewerEffortSelect).toBeDisabled();
    });
  });
});
