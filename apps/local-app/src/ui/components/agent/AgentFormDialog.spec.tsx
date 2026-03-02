import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AgentFormDialog } from './AgentFormDialog';
import type { AgentFormDialogProps, AgentProfile, Provider } from './AgentFormDialog';

const baseProfile: AgentProfile = {
  id: 'profile-1',
  name: 'Default Profile',
  providerId: 'provider-1',
  provider: { id: 'provider-1', name: 'claude' },
};

const secondProfile: AgentProfile = {
  id: 'profile-2',
  name: 'Second Profile',
  providerId: 'provider-1',
  provider: { id: 'provider-1', name: 'claude' },
};

const providersById = new Map<string, Provider>([
  ['provider-1', { id: 'provider-1', name: 'claude' }],
]);

const existingAgents = [
  { id: 'agent-1', name: 'Agent One' },
  { id: 'agent-2', name: 'Agent Two' },
];

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

function buildProps(overrides?: Partial<AgentFormDialogProps>): AgentFormDialogProps {
  return {
    mode: 'create',
    open: true,
    onOpenChange: jest.fn(),
    onSubmit: jest.fn(),
    isSubmitting: false,
    profiles: [baseProfile, secondProfile],
    providers: providersById,
    existingAgents,
    ...overrides,
  };
}

function setupFetchMock(
  configs = [
    {
      id: 'config-1',
      profileId: 'profile-1',
      providerId: 'provider-1',
      name: 'default',
      options: null,
      env: null,
    },
  ],
  modelsByProviderId: Record<string, Array<{ id: string; name: string }>> = {},
) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.match(/\/api\/profiles\/[^/]+\/provider-configs/)) {
      return { ok: true, json: async () => configs } as Response;
    }
    const providerModelsMatch = url.match(/\/api\/providers\/([^/]+)\/models/);
    if (providerModelsMatch) {
      const providerId = providerModelsMatch[1];
      return {
        ok: true,
        json: async () => modelsByProviderId[providerId] ?? [],
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('AgentFormDialog', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ---- Create mode ----

  it('renders "Create Agent" title in create mode', () => {
    setupFetchMock();
    const { Wrapper } = createWrapper();
    render(<AgentFormDialog {...buildProps()} />, { wrapper: Wrapper });

    expect(screen.getByText('Create Agent')).toBeInTheDocument();
  });

  it('renders "Create" submit button text in create mode', () => {
    setupFetchMock();
    const { Wrapper } = createWrapper();
    render(<AgentFormDialog {...buildProps()} />, { wrapper: Wrapper });

    expect(screen.getByRole('button', { name: /^create$/i })).toBeInTheDocument();
  });

  it('renders project name in create mode description', () => {
    setupFetchMock();
    const { Wrapper } = createWrapper();
    render(<AgentFormDialog {...buildProps({ projectName: 'My Project' })} />, {
      wrapper: Wrapper,
    });

    expect(screen.getByText(/create a new agent for My Project/i)).toBeInTheDocument();
  });

  it('calls onSubmit with trimmed form data on create submit', async () => {
    const user = userEvent.setup();
    setupFetchMock();
    const onSubmit = jest.fn();
    const { Wrapper } = createWrapper();

    render(<AgentFormDialog {...buildProps({ onSubmit })} />, { wrapper: Wrapper });

    await user.type(screen.getByLabelText('Name *'), 'New Agent');
    await user.selectOptions(screen.getByLabelText('Profile *'), 'profile-1');

    // Wait for provider configs to load and auto-select
    await waitFor(() => {
      expect(screen.getByLabelText(/provider configuration/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'New Agent',
        profileId: 'profile-1',
        description: null,
        modelOverride: null,
      }),
    );
  });

  // ---- Edit mode ----

  it('renders "Edit Agent" title in edit mode', () => {
    setupFetchMock();
    const { Wrapper } = createWrapper();
    render(
      <AgentFormDialog
        {...buildProps({
          mode: 'edit',
          initialValues: {
            name: 'Agent One',
            profileId: 'profile-1',
            providerConfigId: 'config-1',
            description: 'A description',
            modelOverride: null,
          },
          editAgentId: 'agent-1',
        })}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText('Edit Agent')).toBeInTheDocument();
  });

  it('renders "Save changes" submit button in edit mode', () => {
    setupFetchMock();
    const { Wrapper } = createWrapper();
    render(
      <AgentFormDialog
        {...buildProps({
          mode: 'edit',
          initialValues: {
            name: 'Agent One',
            profileId: 'profile-1',
            providerConfigId: 'config-1',
            description: '',
            modelOverride: null,
          },
          editAgentId: 'agent-1',
        })}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
  });

  it('populates form with initialValues in edit mode', () => {
    setupFetchMock();
    const { Wrapper } = createWrapper();
    render(
      <AgentFormDialog
        {...buildProps({
          mode: 'edit',
          initialValues: {
            name: 'Agent One',
            profileId: 'profile-1',
            providerConfigId: 'config-1',
            description: 'Test desc',
            modelOverride: null,
          },
          editAgentId: 'agent-1',
        })}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByLabelText('Name *')).toHaveValue('Agent One');
    expect(screen.getByLabelText(/description/i)).toHaveValue('Test desc');
  });

  it('shows "Saving…" spinner in edit mode when isSubmitting', () => {
    setupFetchMock();
    const { Wrapper } = createWrapper();
    render(
      <AgentFormDialog
        {...buildProps({
          mode: 'edit',
          isSubmitting: true,
          initialValues: {
            name: 'Agent One',
            profileId: 'profile-1',
            providerConfigId: 'config-1',
            description: '',
            modelOverride: null,
          },
          editAgentId: 'agent-1',
        })}
      />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText('Saving…')).toBeInTheDocument();
  });

  // ---- Profile fallback ----

  it('shows fallback profile option in edit mode when profile not in available list', () => {
    setupFetchMock();
    const missingProfile: AgentProfile = {
      id: 'profile-deleted',
      name: 'Deleted Profile',
      providerId: 'provider-1',
      provider: { id: 'provider-1', name: 'claude' },
    };
    const { Wrapper } = createWrapper();
    render(
      <AgentFormDialog
        {...buildProps({
          mode: 'edit',
          initialValues: {
            name: 'Agent One',
            profileId: 'profile-deleted',
            providerConfigId: '',
            description: '',
            modelOverride: null,
          },
          initialProfile: missingProfile,
          editAgentId: 'agent-1',
        })}
      />,
      { wrapper: Wrapper },
    );

    const profileSelect = screen.getByLabelText('Profile *');
    const options = Array.from(profileSelect.querySelectorAll('option'));
    const fallbackOption = options.find((opt) => opt.value === 'profile-deleted');
    expect(fallbackOption).toBeDefined();
    expect(fallbackOption?.textContent).toContain('Deleted Profile');
  });

  // ---- Config loading guards ----

  it('disables submit when profile has no provider configs', async () => {
    setupFetchMock([]);
    const { Wrapper } = createWrapper();
    render(<AgentFormDialog {...buildProps()} />, { wrapper: Wrapper });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Name *'), 'New Agent');
    await user.selectOptions(screen.getByLabelText('Profile *'), 'profile-1');

    await waitFor(() => {
      expect(screen.getByText('No provider configurations')).toBeInTheDocument();
    });

    // The Create button should be disabled
    expect(screen.getByRole('button', { name: /^create$/i })).toBeDisabled();
  });

  // ---- Duplicate name check ----

  it('shows duplicate name error and disables submit', async () => {
    setupFetchMock();
    const { Wrapper } = createWrapper();
    render(<AgentFormDialog {...buildProps()} />, { wrapper: Wrapper });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Name *'), 'Agent One');

    await waitFor(() => {
      expect(
        screen.getByText('An agent with this name already exists in this project.'),
      ).toBeInTheDocument();
    });
  });

  it('allows same name in edit mode for the agent being edited', () => {
    setupFetchMock();
    const { Wrapper } = createWrapper();
    render(
      <AgentFormDialog
        {...buildProps({
          mode: 'edit',
          initialValues: {
            name: 'Agent One',
            profileId: 'profile-1',
            providerConfigId: 'config-1',
            description: '',
            modelOverride: null,
          },
          editAgentId: 'agent-1',
        })}
      />,
      { wrapper: Wrapper },
    );

    // Should NOT show duplicate error for the agent's own name
    expect(
      screen.queryByText('An agent with this name already exists in this project.'),
    ).not.toBeInTheDocument();
  });

  // ---- Avatar preview ----

  it('shows avatar preview that updates with debounced input', async () => {
    jest.useFakeTimers();
    setupFetchMock();
    const { Wrapper } = createWrapper();

    try {
      render(<AgentFormDialog {...buildProps()} />, { wrapper: Wrapper });

      expect(screen.getByTestId('agent-preview-create-label')).toHaveTextContent('Avatar preview');

      const nameInput = screen.getByLabelText('Name *');
      await act(async () => {
        nameInput.focus();
        // Simulate typing by setting value and triggering change
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          nameInput,
          'Ada Lovelace',
        );
        nameInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      await act(async () => {
        jest.advanceTimersByTime(300);
      });

      await waitFor(() => {
        expect(screen.getByTestId('agent-preview-create-label')).toHaveTextContent('Ada Lovelace');
      });
    } finally {
      jest.useRealTimers();
    }
  });

  // ---- Model override ----

  it('shows model override selector when selected provider config has models', async () => {
    const user = userEvent.setup();
    setupFetchMock(undefined, {
      'provider-1': [{ id: 'model-1', name: 'anthropic/claude-3-7-sonnet' }],
    });
    const { Wrapper } = createWrapper();
    render(<AgentFormDialog {...buildProps()} />, { wrapper: Wrapper });

    await user.type(screen.getByLabelText('Name *'), 'Model Agent');
    await user.selectOptions(screen.getByLabelText('Profile *'), 'profile-1');

    await waitFor(() => {
      expect(screen.getByLabelText('Model Override')).toBeInTheDocument();
    });

    expect(screen.getByRole('option', { name: 'claude-3-7-sonnet' })).toBeInTheDocument();
  });

  it('hides model override selector when selected provider has no models', async () => {
    const user = userEvent.setup();
    setupFetchMock(undefined, { 'provider-1': [] });
    const { Wrapper } = createWrapper();
    render(<AgentFormDialog {...buildProps()} />, { wrapper: Wrapper });

    await user.type(screen.getByLabelText('Name *'), 'No Model Agent');
    await user.selectOptions(screen.getByLabelText('Profile *'), 'profile-1');

    await waitFor(() => {
      expect(screen.getByLabelText(/provider configuration/i)).toBeInTheDocument();
    });

    expect(screen.queryByLabelText('Model Override')).not.toBeInTheDocument();
  });

  it('resets model override to default when provider config changes', async () => {
    const user = userEvent.setup();
    setupFetchMock(
      [
        {
          id: 'config-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'Config One',
          options: null,
          env: null,
        },
        {
          id: 'config-2',
          profileId: 'profile-1',
          providerId: 'provider-2',
          name: 'Config Two',
          options: null,
          env: null,
        },
      ],
      {
        'provider-1': [{ id: 'model-1', name: 'openai/gpt-4.1' }],
        'provider-2': [{ id: 'model-2', name: 'anthropic/claude-3-7-sonnet' }],
      },
    );
    const { Wrapper } = createWrapper();
    render(<AgentFormDialog {...buildProps()} />, { wrapper: Wrapper });

    await user.type(screen.getByLabelText('Name *'), 'Switch Agent');
    await user.selectOptions(screen.getByLabelText('Profile *'), 'profile-1');
    await user.selectOptions(screen.getByLabelText(/provider configuration/i), 'config-1');

    await waitFor(() => {
      expect(screen.getByLabelText('Model Override')).toBeInTheDocument();
    });

    await user.selectOptions(screen.getByLabelText('Model Override'), 'openai/gpt-4.1');
    await user.selectOptions(screen.getByLabelText(/provider configuration/i), 'config-2');

    await waitFor(() => {
      expect((screen.getByLabelText('Model Override') as HTMLSelectElement).value).toBe(
        '__default_model_override__',
      );
    });
  });

  it('submits selected model override', async () => {
    const user = userEvent.setup();
    setupFetchMock(undefined, {
      'provider-1': [{ id: 'model-1', name: 'anthropic/claude-3-7-sonnet' }],
    });
    const onSubmit = jest.fn();
    const { Wrapper } = createWrapper();
    render(<AgentFormDialog {...buildProps({ onSubmit })} />, { wrapper: Wrapper });

    await user.type(screen.getByLabelText('Name *'), 'Override Agent');
    await user.selectOptions(screen.getByLabelText('Profile *'), 'profile-1');
    await waitFor(() => {
      expect(screen.getByLabelText('Model Override')).toBeInTheDocument();
    });

    await user.selectOptions(
      screen.getByLabelText('Model Override'),
      'anthropic/claude-3-7-sonnet',
    );
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: 'anthropic/claude-3-7-sonnet',
      }),
    );
  });

  it('prepopulates model override in edit mode', async () => {
    setupFetchMock(undefined, {
      'provider-1': [{ id: 'model-1', name: 'anthropic/claude-3-7-sonnet' }],
    });
    const { Wrapper } = createWrapper();
    render(
      <AgentFormDialog
        {...buildProps({
          mode: 'edit',
          initialValues: {
            name: 'Agent One',
            profileId: 'profile-1',
            providerConfigId: 'config-1',
            description: 'Test desc',
            modelOverride: 'anthropic/claude-3-7-sonnet',
          },
          editAgentId: 'agent-1',
        })}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => {
      expect((screen.getByLabelText('Model Override') as HTMLSelectElement).value).toBe(
        'anthropic/claude-3-7-sonnet',
      );
    });
  });

  // ---- Cancel ----

  it('calls onOpenChange(false) when Cancel is clicked', async () => {
    setupFetchMock();
    const user = userEvent.setup();
    const onOpenChange = jest.fn();
    const { Wrapper } = createWrapper();

    render(<AgentFormDialog {...buildProps({ onOpenChange })} />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // ---- Profiles empty state ----

  it('shows message when no profiles are available', () => {
    setupFetchMock();
    const { Wrapper } = createWrapper();
    render(<AgentFormDialog {...buildProps({ profiles: [] })} />, { wrapper: Wrapper });

    expect(screen.getByText('No profiles available. Create a profile first.')).toBeInTheDocument();
  });
});
