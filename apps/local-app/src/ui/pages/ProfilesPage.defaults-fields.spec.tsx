import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderConfigDefaultsFields } from './ProfilesPage';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

// UI component (jsdom). Per docs/testing.md, component behavior is proven cheapest
// at this layer. The warning + rebind logic is pure presentation over catalog data.
describe('ProviderConfigDefaultsFields', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  const modelsJson = [{ name: 'opus' }, { name: 'sonnet' }];
  const effortsJson = {
    efforts: [{ name: 'high' }, { name: 'low' }],
    supportsEffort: true,
    requiresModelForEffort: false,
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const mockFetchFor = (providerId: string) => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `/api/providers/${providerId}/models`) {
        return { ok: true, json: async () => modelsJson } as Response;
      }
      if (url === `/api/providers/${providerId}/efforts`) {
        return { ok: true, json: async () => effortsJson } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
  };

  const renderField = (
    overrides: Partial<React.ComponentProps<typeof ProviderConfigDefaultsFields>> = {},
  ) => {
    const props: React.ComponentProps<typeof ProviderConfigDefaultsFields> = {
      providerId: 'prov-1',
      model: null,
      effort: null,
      options: '',
      onModelChange: jest.fn(),
      onEffortChange: jest.fn(),
      ...overrides,
    };
    return render(<ProviderConfigDefaultsFields {...props} />, {
      wrapper: createWrapper().Wrapper,
    });
  };

  it('renders model options from the catalog', async () => {
    mockFetchFor('prov-1');
    renderField();

    await waitFor(() => {
      const modelSelect = screen.getByLabelText('Structured model default') as HTMLSelectElement;
      expect(modelSelect).toBeInTheDocument();
      expect([...modelSelect.options].map((o) => o.value)).toEqual(['', 'opus', 'sonnet']);
    });
  });

  it('renders effort select when supportsEffort is true', async () => {
    mockFetchFor('prov-1');
    renderField();

    await waitFor(() => {
      const effortSelect = screen.getByLabelText('Structured effort default') as HTMLSelectElement;
      expect([...effortSelect.options].map((o) => o.value)).toEqual(['', 'high', 'low']);
    });
  });

  it('hides effort select when supportsEffort is false (agy)', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/providers/agy/models') {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url === '/api/providers/agy/efforts') {
        return {
          ok: true,
          json: async () => ({ efforts: [], supportsEffort: false, requiresModelForEffort: false }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });

    renderField({ providerId: 'agy' });

    await waitFor(() => {
      expect(screen.getByLabelText('Structured model default')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Structured effort default')).not.toBeInTheDocument();
  });

  it('disables effort select and shows hint when supported but catalog empty', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/providers/prov-1/models') {
        return { ok: true, json: async () => [] } as Response;
      }
      if (url === '/api/providers/prov-1/efforts') {
        return {
          ok: true,
          json: async () => ({ efforts: [], supportsEffort: true, requiresModelForEffort: false }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });

    renderField();

    const effortSelect = (await screen.findByLabelText(
      'Structured effort default',
    )) as HTMLSelectElement;
    expect(effortSelect).toBeDisabled();
    expect(screen.getByText('No effort levels configured')).toBeInTheDocument();
  });

  it('shows the conflict warning when a model flag and a structured model are both present', async () => {
    mockFetchFor('prov-1');
    renderField({ options: '--model opus', model: 'sonnet' });

    await waitFor(() => {
      expect(
        screen.getByText(/will be overridden by the structured selection/),
      ).toBeInTheDocument();
    });
  });

  it('clearing the structured model removes the warning', async () => {
    mockFetchFor('prov-1');
    const onModelChange = jest.fn();
    renderField({ options: '--model opus', model: 'sonnet', onModelChange });

    await waitFor(() => {
      expect(
        screen.getByText(/will be overridden by the structured selection/),
      ).toBeInTheDocument();
    });

    // Selecting "None" (empty) reports null
    fireEvent.change(screen.getByLabelText('Structured model default'), { target: { value: '' } });
    expect(onModelChange).toHaveBeenCalledWith(null);
  });

  it('shows the warning for an effort flag conflict', async () => {
    mockFetchFor('prov-1');
    renderField({ options: '--effort high', effort: 'low' });

    await waitFor(() => {
      expect(
        screen.getByText(/will be overridden by the structured selection/),
      ).toBeInTheDocument();
    });
  });

  it('does not show the warning when options has a flag but no structured value is set', async () => {
    mockFetchFor('prov-1');
    renderField({ options: '--model opus --effort high', model: null, effort: null });

    await waitFor(() => {
      expect(screen.getByLabelText('Structured model default')).toBeInTheDocument();
    });
    expect(screen.queryByText(/will be overridden/)).not.toBeInTheDocument();
  });

  it('reports model/effort changes up via callbacks', async () => {
    mockFetchFor('prov-1');
    const onModelChange = jest.fn();
    const onEffortChange = jest.fn();
    renderField({ onModelChange, onEffortChange });

    // Wait for both catalogs to populate before interacting
    await waitFor(() => {
      const modelSelect = screen.getByLabelText('Structured model default') as HTMLSelectElement;
      expect([...modelSelect.options].map((o) => o.value)).toContain('opus');
    });

    fireEvent.change(screen.getByLabelText('Structured model default'), {
      target: { value: 'opus' },
    });

    // Effort select renders only after the efforts catalog query resolves (supportsEffort)
    await waitFor(() => {
      expect(screen.getByLabelText('Structured effort default')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('Structured effort default'), {
      target: { value: 'high' },
    });

    expect(onModelChange).toHaveBeenCalledWith('opus');
    expect(onEffortChange).toHaveBeenCalledWith('high');
  });

  it('rebinds catalogs when the provider prop changes', async () => {
    mockFetchFor('prov-1');
    const { rerender } = renderField({ providerId: 'prov-1' });

    await waitFor(() => {
      expect(screen.getByLabelText('Structured model default')).toBeInTheDocument();
    });

    mockFetchFor('prov-2');
    rerender(
      <ProviderConfigDefaultsFields
        providerId="prov-2"
        model={null}
        effort={null}
        options=""
        onModelChange={jest.fn()}
        onEffortChange={jest.fn()}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/providers/prov-2/models');
      expect(fetchMock).toHaveBeenCalledWith('/api/providers/prov-2/efforts');
    });
  });
});
