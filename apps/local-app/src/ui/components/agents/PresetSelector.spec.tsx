import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { buildApiUrl, createApiFetch, HOME_BACKEND } from '@/ui/lib/api-transport';
import { BackendContext } from '@/ui/lib/backend-context';
import { projectPresetQueryKeys, type projectPresetQueries } from '@/ui/lib/project-presets';
import { teamsQueryKeys } from '@/ui/lib/teams';
import { PresetSelector } from './PresetSelector';

const mockUseQuery = jest.fn();
const mockInvalidateQueries = jest.fn();

jest.mock('@tanstack/react-query', () => {
  const actual = jest.requireActual('@tanstack/react-query');
  return {
    ...actual,
    useQuery: (options: unknown) => mockUseQuery(options),
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  };
});

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
globalThis.fetch = mockFetch;
window.fetch = mockFetch;

// Mock validatePresetAvailability
jest.mock('@/ui/lib/preset-validation', () => ({
  validatePresetAvailability: (preset: { agentConfigs: unknown[] }) => ({
    preset,
    available: preset.agentConfigs.length > 0,
    missingConfigs: [],
  }),
}));

jest.mock('@/ui/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  const SelectContext = React.createContext({
    value: '',
    onValueChange: (_value: string) => {},
  });

  return {
    Select: ({
      value,
      onValueChange,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      children: React.ReactNode;
    }) => (
      <SelectContext.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </SelectContext.Provider>
    ),
    SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: ({ placeholder }: { placeholder: string }) => {
      const { value } = React.useContext(SelectContext);
      return <span>{value || placeholder}</span>;
    },
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const { onValueChange } = React.useContext(SelectContext);
      return (
        <button type="button" onClick={() => onValueChange(value)}>
          {children}
        </button>
      );
    },
  };
});

jest.mock('@/ui/components/shared/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmText,
    onOpenChange,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    description: string;
    confirmText: string;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
  }) =>
    open ? (
      <div data-testid="active-session-confirm-dialog">
        <h2>{title}</h2>
        <p>{description}</p>
        <button type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

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
  { id: 'agent-1', name: 'Coder', profileId: 'profile-1' },
  { id: 'agent-2', name: 'Reviewer', profileId: 'profile-1' },
];

const mockAgentPresence = {
  'agent-1': { online: false, sessionId: 'session-1', startedAt: '2024-01-01T00:00:00.000Z' },
  'agent-2': { online: false, sessionId: 'session-2', startedAt: '2024-01-01T00:00:00.000Z' },
};

const mockPresets = [
  {
    name: 'default',
    description: 'Default preset',
    agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
  },
  {
    name: 'minimal',
    description: null,
    agentConfigs: [{ agentName: 'Reviewer', providerConfigName: 'codex-config' }],
  },
];

describe('PresetSelector', () => {
  const defaultProps = {
    projectId: 'project-123',
    agents: mockAgents,
    agentPresence: mockAgentPresence,
    onAgentsRefresh: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
    mockUseQuery.mockImplementation((options: { queryKey: unknown[] }) => {
      if (options.queryKey[0] === 'project-presets') {
        return { data: { presets: mockPresets, activePreset: null }, isLoading: false };
      }
      if (options.queryKey[0] === 'provider-configs-by-profile') {
        return { data: new Map(), isLoading: false };
      }
      return { data: undefined, isLoading: false };
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ presets: mockPresets }),
    });
  });

  describe('remote preset requests', () => {
    const remoteId = 'remote-1';
    const presetUrl = `/r/${remoteId}/api/projects/${defaultProps.projectId}/presets`;

    // A component render exercises the fetch hook and real transport together.
    function renderRemoteSelector() {
      const bindings = new Map([[defaultProps.projectId, remoteId]]);
      return renderWithQueryClient(
        <BackendContext.Provider
          value={{
            activeBackend: HOME_BACKEND,
            activeRemote: null,
            bindings,
            ready: true,
            bindingsError: null,
            retry: jest.fn(),
            apiFetch: createApiFetch(() => ({
              bindings,
              activeProjectId: 'another-project',
              authority: 'known',
            })),
            buildApiUrl,
          }}
        >
          <PresetSelector {...defaultProps} />
        </BackendContext.Provider>,
      );
    }

    it('reads presets through the project owner proxy', async () => {
      renderRemoteSelector();

      // The useQuery mock hands control of query execution to the test.
      const query = (mockUseQuery.mock.calls as [ReturnType<typeof projectPresetQueries.list>][])
        .map(([options]) => options)
        .find(({ queryKey }) => queryKey[0] === projectPresetQueryKeys.all[0]);
      if (!query) throw new Error('Missing preset list query');
      await createTestQueryClient().fetchQuery(query);

      expect(mockFetch).toHaveBeenCalledWith(presetUrl, {});
    });

    it('applies a preset through the project owner proxy', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ applied: 1, warnings: [], agents: [] }),
      });
      renderRemoteSelector();

      fireEvent.click(screen.getByRole('button', { name: /default/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => expect(defaultProps.onAgentsRefresh).toHaveBeenCalled());
      expect(mockFetch).toHaveBeenCalledWith(
        `${presetUrl}/apply`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ presetName: 'default' }),
        }),
      );
    });
  });

  describe('rendering', () => {
    it('renders nothing when no presets available', async () => {
      mockUseQuery.mockImplementation((options: { queryKey: unknown[] }) => {
        if (options.queryKey[0] === 'project-presets') {
          return { data: { presets: [], activePreset: null }, isLoading: false };
        }
        if (options.queryKey[0] === 'provider-configs-by-profile') {
          return { data: new Map(), isLoading: false };
        }
        return { data: undefined, isLoading: false };
      });

      const { container } = renderWithQueryClient(<PresetSelector {...defaultProps} />);

      await waitFor(() => {
        expect(container.firstChild).toBeNull();
      });
    });
  });

  describe('active session confirmation', () => {
    it('shows themed confirmation without native confirm when applying a preset to agents with active sessions', async () => {
      const confirmSpy = jest.spyOn(window, 'confirm');
      mockUseQuery.mockImplementation((options: { queryKey: unknown[] }) => {
        if (options.queryKey[0] === 'project-presets') {
          return { data: { presets: mockPresets, activePreset: 'minimal' }, isLoading: false };
        }
        if (options.queryKey[0] === 'provider-configs-by-profile') {
          return { data: new Map(), isLoading: false };
        }
        return { data: undefined, isLoading: false };
      });
      mockFetch.mockImplementation((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/presets')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ presets: mockPresets, activePreset: 'minimal' }),
          });
        }
        if (url.endsWith('/presets/apply')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ applied: 1, warnings: [], agents: [] }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
        });
      });

      renderWithQueryClient(
        <PresetSelector
          {...defaultProps}
          agentPresence={{
            ...mockAgentPresence,
            'agent-1': { ...mockAgentPresence['agent-1'], online: true },
          }}
        />,
      );

      await waitFor(() => {
        expect(screen.getAllByText('minimal').length).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getByRole('button', { name: /default/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Apply' })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

      expect(await screen.findByText('Active sessions detected')).toBeInTheDocument();
      expect(screen.getByText(/Coder/)).toBeInTheDocument();
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalledWith(
        '/api/projects/project-123/presets/apply',
        expect.anything(),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('active-session-confirm-dialog')).not.toBeInTheDocument();
      expect(mockFetch).not.toHaveBeenCalledWith(
        '/api/projects/project-123/presets/apply',
        expect.anything(),
      );

      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      await waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: teamsQueryKeys.teams('project-123'),
        });
        expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: teamsQueryKeys.details });
      });

      confirmSpy.mockRestore();
    });
  });
});
