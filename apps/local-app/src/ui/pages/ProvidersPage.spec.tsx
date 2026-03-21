import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProvidersPage } from './ProvidersPage';

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: null,
    selectedProject: null,
    projects: [],
    projectsLoading: false,
    projectsError: false,
    refetchProjects: jest.fn(),
    setSelectedProjectId: jest.fn(),
  }),
}));

function renderWithQuery(ui: React.ReactElement, queryClient?: QueryClient) {
  const client =
    queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { ...view, queryClient: client };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe('ProvidersPage - Provider Type presets and command previews', () => {
  beforeEach(() => {
    // Mock fetch for providers list
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    // jsdom lacks scrollIntoView; Radix Select calls it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  });

  it('updates binPath defaults when provider type changes', async () => {
    renderWithQuery(<ProvidersPage />);

    // Ensure initial query completes and page renders
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    // Open dialog
    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    // Open type select and choose Codex (disambiguate duplicates in Radix portal)
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const codexOptions = await screen.findAllByText('Codex');
    fireEvent.click(codexOptions[codexOptions.length - 1]);

    const binInput = screen.getByLabelText('Binary Path') as HTMLInputElement;
    expect(binInput.value).toBe('codex');

    // Change to Claude
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);
    expect(binInput.value).toBe('claude');

    // If user edits binPath, changing type should not override
    fireEvent.change(binInput, { target: { value: 'mybin' } });
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const codexOptions2 = await screen.findAllByText('Codex');
    fireEvent.click(codexOptions2[codexOptions2.length - 1]);
    expect(binInput.value).toBe('mybin');
  });

  it('calls ensure endpoint when Configure MCP is clicked', async () => {
    // Mock providers list with one provider
    const mockProvider = {
      id: 'p1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: false,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && !options) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [mockProvider], total: 1, limit: 100, offset: 0 }),
          });
        }
        if (url === '/api/preflight') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: [],
              supportedMcpProviders: ['claude', 'codex', 'gemini'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (url === '/api/providers/p1/mcp/ensure' && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              action: 'added',
              endpoint: 'http://127.0.0.1:3000/mcp',
              alias: 'devchain',
            }),
          });
        }
        return Promise.resolve({ ok: false });
      },
    );

    renderWithQuery(<ProvidersPage />);

    // Wait for providers to load
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    // Click Configure MCP button
    const configureButton = screen.getByRole('button', { name: /configure mcp/i });
    fireEvent.click(configureButton);

    // Verify ensure endpoint was called
    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const ensureCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === '/api/providers/p1/mcp/ensure' && call[1]?.method === 'POST',
      );
      expect(ensureCalls.length).toBeGreaterThan(0);
    });
  });
});

// ============================================
// autoCompactThreshold display and edit tests
// ============================================

describe('ProvidersPage - autoCompactThreshold display and edit', () => {
  const claudeProvider = {
    id: 'p-claude',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    autoCompactThreshold: 10,
    oneMillionContextEnabled: false,
    mcpConfigured: true,
    mcpEndpoint: 'http://127.0.0.1:3000/mcp',
    mcpRegisteredAt: '2024-01-01',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  const codexProvider = {
    id: 'p-codex',
    name: 'codex',
    binPath: '/usr/local/bin/codex',
    autoCompactThreshold: null,
    oneMillionContextEnabled: false,
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setupFetch(providers: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              items: providers,
              total: providers.length,
              limit: 100,
              offset: 0,
            }),
          });
        }
        if (url === '/api/preflight') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: providers.map((p) => ({
                id: p.id,
                mcpStatus: p.mcpConfigured ? 'pass' : 'warn',
              })),
              supportedMcpProviders: ['claude', 'codex', 'gemini'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        // Handle PUT for update
        if (url.match(/\/api\/providers\/[\w-]+$/) && options?.method === 'PUT') {
          const body = JSON.parse(options.body as string);
          const id = url.split('/').pop()!;
          const existing = providers.find((p) => p.id === id);
          return Promise.resolve({
            ok: true,
            json: async () => ({ ...existing, ...body, updatedAt: new Date().toISOString() }),
          });
        }
        // Handle POST for create
        if (url === '/api/providers' && options?.method === 'POST') {
          const body = JSON.parse(options.body as string);
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: 'p-new',
              ...body,
              mcpConfigured: false,
              mcpEndpoint: null,
              mcpRegisteredAt: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          });
        }
        return Promise.resolve({ ok: false });
      },
    );
  }

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  });

  it('displays threshold percentage on Claude provider card', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());
    expect(screen.getByText(/Auto-compact:.*10%/)).toBeInTheDocument();
  });

  it('displays "disabled" when Claude provider threshold is null', async () => {
    setupFetch([{ ...claudeProvider, autoCompactThreshold: null }]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());
    expect(screen.getByText(/Auto-compact:.*disabled/)).toBeInTheDocument();
  });

  it('does not display threshold on non-Claude provider card', async () => {
    setupFetch([codexProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    expect(screen.queryByText(/Auto-compact:/)).not.toBeInTheDocument();
  });

  it('shows threshold input with current value when editing Claude provider', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() =>
      expect(screen.getByLabelText('Auto-Compact Threshold (%)')).toBeInTheDocument(),
    );
    const thresholdInput = screen.getByLabelText('Auto-Compact Threshold (%)') as HTMLInputElement;
    expect(thresholdInput.value).toBe('10');
  });

  it('does not show threshold input when editing non-Claude provider', async () => {
    setupFetch([codexProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => expect(screen.getByText('Edit Provider')).toBeInTheDocument());
    expect(screen.queryByLabelText('Auto-Compact Threshold (%)')).not.toBeInTheDocument();
  });

  it('shows threshold input in create dialog when Claude type is selected', async () => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    // Default type is Codex - threshold should not show
    expect(screen.queryByLabelText('Auto-Compact Threshold (%)')).not.toBeInTheDocument();

    // Switch to Claude
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);

    expect(screen.getByLabelText('Auto-Compact Threshold (%)')).toBeInTheDocument();
  });

  it('includes autoCompactThreshold in update mutation payload', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() =>
      expect(screen.getByLabelText('Auto-Compact Threshold (%)')).toBeInTheDocument(),
    );
    const thresholdInput = screen.getByLabelText('Auto-Compact Threshold (%)');
    fireEvent.change(thresholdInput, { target: { value: '25' } });

    fireEvent.click(screen.getByText('Update'));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const updateCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-claude' && call[1]?.method === 'PUT',
      );
      expect(updateCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(updateCalls[0][1].body as string);
      expect(body.autoCompactThreshold).toBe(25);
    });
  });

  it('sends null for autoCompactThreshold when threshold input is empty on update', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() =>
      expect(screen.getByLabelText('Auto-Compact Threshold (%)')).toBeInTheDocument(),
    );
    const thresholdInput = screen.getByLabelText('Auto-Compact Threshold (%)');
    fireEvent.change(thresholdInput, { target: { value: '' } });

    fireEvent.click(screen.getByText('Update'));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const updateCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-claude' && call[1]?.method === 'PUT',
      );
      expect(updateCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(updateCalls[0][1].body as string);
      expect(body.autoCompactThreshold).toBeNull();
    });
  });

  it('includes autoCompactThreshold in Claude CREATE payload when value is set', async () => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    // Switch to Claude
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);

    // Set threshold
    const thresholdInput = screen.getByLabelText('Auto-Compact Threshold (%)');
    fireEvent.change(thresholdInput, { target: { value: '42' } });

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const createCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers' && call[1]?.method === 'POST',
      );
      expect(createCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(createCalls[0][1].body as string);
      expect(body.autoCompactThreshold).toBe(42);
    });
  });

  it('omits autoCompactThreshold from Claude CREATE payload when value is empty', async () => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    // Switch to Claude
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);

    // Leave threshold empty, just submit
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const createCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers' && call[1]?.method === 'POST',
      );
      expect(createCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(createCalls[0][1].body as string);
      expect(body).not.toHaveProperty('autoCompactThreshold');
    });
  });

  it('non-Claude CREATE never sends autoCompactThreshold even if previously typed while Claude was selected', async () => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    // Switch to Claude and enter a threshold
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);

    const thresholdInput = screen.getByLabelText('Auto-Compact Threshold (%)');
    fireEvent.change(thresholdInput, { target: { value: '50' } });

    // Switch back to Codex — threshold should be cleared
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const codexOptions = await screen.findAllByText('Codex');
    fireEvent.click(codexOptions[codexOptions.length - 1]);

    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const createCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers' && call[1]?.method === 'POST',
      );
      expect(createCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(createCalls[0][1].body as string);
      expect(body).not.toHaveProperty('autoCompactThreshold');
    });
  });

  it('shows error styling on threshold input when backend returns field error for autoCompactThreshold', async () => {
    // Mock fetch where POST returns a field error for autoCompactThreshold
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
          });
        }
        if (url === '/api/preflight') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: [],
              supportedMcpProviders: ['claude', 'codex', 'gemini'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (url === '/api/providers' && options?.method === 'POST') {
          return Promise.resolve({
            ok: false,
            json: async () => ({
              message: 'Invalid threshold value',
              field: 'autoCompactThreshold',
            }),
          });
        }
        return Promise.resolve({ ok: false });
      },
    );

    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    // Switch to Claude and set a valid threshold (backend will reject it)
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);

    const thresholdInput = screen.getByLabelText('Auto-Compact Threshold (%)') as HTMLInputElement;
    fireEvent.change(thresholdInput, { target: { value: '50' } });

    fireEvent.click(screen.getByText('Create'));

    // Wait for the error to appear on the threshold field
    await waitFor(() => {
      expect(screen.getByText('Invalid threshold value')).toBeInTheDocument();
    });
    // Verify error styling is on threshold input, not binPath
    expect(thresholdInput.className).toContain('border-destructive');
    const binPathInput = screen.getByLabelText('Binary Path');
    expect(binPathInput.className).not.toContain('border-destructive');
  });

  it.each([
    { value: '0', label: 'zero' },
    { value: '101', label: 'above 100' },
    { value: '-5', label: 'negative' },
    { value: '10.5', label: 'non-integer' },
  ])(
    'frontend validation rejects $label threshold value ($value) and blocks mutation',
    async ({ value }) => {
      setupFetch([claudeProvider]);
      renderWithQuery(<ProvidersPage />);
      await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Edit'));

      await waitFor(() =>
        expect(screen.getByLabelText('Auto-Compact Threshold (%)')).toBeInTheDocument(),
      );
      const thresholdInput = screen.getByLabelText('Auto-Compact Threshold (%)');
      fireEvent.change(thresholdInput, { target: { value } });

      // Use fireEvent.submit on the form to bypass HTML5 native validation
      // (type="number" min/max prevents click-based submit for out-of-range values)
      const form = screen.getByText('Update').closest('form')!;
      fireEvent.submit(form);

      // Error message should appear
      await waitFor(() => {
        expect(
          screen.getByText('Threshold must be an integer between 1 and 100.'),
        ).toBeInTheDocument();
      });

      // Mutation should NOT have been called
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const updateCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-claude' && call[1]?.method === 'PUT',
      );
      expect(updateCalls).toHaveLength(0);
    },
  );
});

describe('ProvidersPage - 1M context controls', () => {
  const claudeProvider = {
    id: 'p-claude',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    autoCompactThreshold: 85,
    oneMillionContextEnabled: false,
    mcpConfigured: true,
    mcpEndpoint: 'http://127.0.0.1:3000/mcp',
    mcpRegisteredAt: '2024-01-01',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setupFetch(providers: any[], probeResult?: { supported: boolean; status: string }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              items: providers,
              total: providers.length,
              limit: 100,
              offset: 0,
            }),
          });
        }
        if (url === '/api/preflight') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: providers.map((p) => ({
                id: p.id,
                mcpStatus: p.mcpConfigured ? 'pass' : 'warn',
              })),
              supportedMcpProviders: ['claude', 'codex', 'gemini'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (
          url.match(/\/api\/providers\/[^/]+\/1m-context\/probe$/) &&
          options?.method === 'POST'
        ) {
          return Promise.resolve({
            ok: true,
            json: async () => probeResult ?? { supported: true, status: 'supported' },
          });
        }
        if (url.match(/\/api\/providers\/[\w-]+$/) && options?.method === 'PUT') {
          const body = JSON.parse(options.body as string);
          const id = url.split('/').pop()!;
          const existing = providers.find((p) => p.id === id);
          return Promise.resolve({
            ok: true,
            json: async () => ({ ...existing, ...body, updatedAt: new Date().toISOString() }),
          });
        }
        if (url.match(/\/api\/providers\/[^/]+\/models$/) && (!options || !options.method)) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: false });
      },
    );
  }

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  });

  it('shows 1M context checkbox in Claude edit dialog', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());
  });

  it('hides 1M context checkbox for non-Claude providers', async () => {
    setupFetch([
      {
        ...claudeProvider,
        id: 'p-codex',
        name: 'codex',
        binPath: '/usr/local/bin/codex',
      },
    ]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => expect(screen.getByText('Edit Provider')).toBeInTheDocument());
    expect(screen.queryByLabelText('1M context')).not.toBeInTheDocument();
  });

  it('runs probe and sets supported status on checkbox toggle for existing provider', async () => {
    setupFetch([claudeProvider], { supported: true, status: 'supported' });
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('1M context'));

    await waitFor(() => expect(screen.getByText('Supported')).toBeInTheDocument());

    // Threshold should be forced to 50
    const thresholdInput = screen.getByLabelText('Auto-Compact Threshold (%)') as HTMLInputElement;
    expect(thresholdInput.value).toBe('50');
  });

  it('includes oneMillionContextEnabled in update payload', async () => {
    setupFetch([claudeProvider], { supported: true, status: 'supported' });
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('1M context'));
    await waitFor(() => expect(screen.getByText('Supported')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Update'));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const updateCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-claude' && call[1]?.method === 'PUT',
      );
      expect(updateCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(updateCalls[0][1].body as string);
      expect(body.oneMillionContextEnabled).toBe(true);
    });
  });

  it('restores autoCompactThreshold to 95 when 1M context is manually disabled', async () => {
    setupFetch([{ ...claudeProvider, oneMillionContextEnabled: true, autoCompactThreshold: 50 }], {
      supported: true,
      status: 'supported',
    });
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    // Checkbox should be checked (1M enabled)
    const checkbox = screen.getByLabelText('1M context');
    expect(checkbox).toHaveAttribute('data-state', 'checked');

    // Uncheck the checkbox to disable 1M context
    fireEvent.click(checkbox);

    // Threshold should be restored to 95
    const thresholdInput = screen.getByLabelText('Auto-Compact Threshold (%)') as HTMLInputElement;
    expect(thresholdInput.value).toBe('95');
  });

  it('displays 1M context status on provider card', async () => {
    setupFetch([{ ...claudeProvider, oneMillionContextEnabled: true }]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());
    expect(screen.getByText(/1M context:.*enabled/)).toBeInTheDocument();
  });

  it('clears probe status and disables 1M when binPath changes on existing Claude provider', async () => {
    setupFetch([{ ...claudeProvider, oneMillionContextEnabled: true, autoCompactThreshold: 50 }], {
      supported: true,
      status: 'supported',
    });
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    // 1M should be checked initially
    const checkbox = screen.getByLabelText('1M context');
    expect(checkbox).toHaveAttribute('data-state', 'checked');

    // Change binPath
    const binPathInput = screen.getByLabelText('Binary Path');
    fireEvent.change(binPathInput, { target: { value: '/opt/new-claude/bin/claude' } });

    // 1M should be unchecked and threshold restored to 95
    expect(checkbox).toHaveAttribute('data-state', 'unchecked');
    const thresholdInput = screen.getByLabelText('Auto-Compact Threshold (%)') as HTMLInputElement;
    expect(thresholdInput.value).toBe('95');

    // Supported badge should be gone
    expect(screen.queryByText('Supported')).not.toBeInTheDocument();
  });

  it('disables 1M context checkbox for new Claude provider', async () => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getAllByText('Add Provider').length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    // Switch to Claude using the labeled select
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);

    // 1M checkbox should be disabled for new providers
    const checkbox = screen.getByLabelText('1M context');
    expect(checkbox).toBeDisabled();
  });

  it('disables 1M checkbox when binPath differs from persisted value (stale probe prevention)', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    // Checkbox should be enabled initially (binPath matches persisted)
    const checkbox = screen.getByLabelText('1M context');
    expect(checkbox).not.toBeDisabled();

    // Change binPath to a different value
    const binPathInput = screen.getByLabelText('Binary Path');
    fireEvent.change(binPathInput, { target: { value: '/opt/new-claude' } });

    // Checkbox should now be disabled
    expect(checkbox).toBeDisabled();

    // Hint message should appear
    expect(screen.getByText(/Save the new binary path first, then re-probe/)).toBeInTheDocument();
  });

  it('re-enables 1M checkbox when binPath is restored to persisted value', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    const checkbox = screen.getByLabelText('1M context');
    const binPathInput = screen.getByLabelText('Binary Path');

    // Change binPath
    fireEvent.change(binPathInput, { target: { value: '/opt/different' } });
    expect(checkbox).toBeDisabled();

    // Restore to original
    fireEvent.change(binPathInput, { target: { value: '/usr/local/bin/claude' } });
    expect(checkbox).not.toBeDisabled();

    // Hint message should be gone
    expect(
      screen.queryByText(/Save the new binary path first, then re-probe/),
    ).not.toBeInTheDocument();
  });

  it('does not call probe endpoint when binPath is dirty even if checkbox could be clicked', async () => {
    setupFetch([claudeProvider], { supported: true, status: 'supported' });
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    // Change binPath to make checkbox disabled
    const binPathInput = screen.getByLabelText('Binary Path');
    fireEvent.change(binPathInput, { target: { value: '/opt/new-claude' } });

    // Attempt to click the disabled checkbox
    const checkbox = screen.getByLabelText('1M context');
    fireEvent.click(checkbox);

    // Probe should NOT have been called
    const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
    const probeCalls = fetchMock.mock.calls.filter(
      (call: [string, RequestInit?]) =>
        typeof call[0] === 'string' &&
        call[0].includes('/1m-context/probe') &&
        call[1]?.method === 'POST',
    );
    expect(probeCalls).toHaveLength(0);
  });

  it('end-to-end: save changed binPath then reprobe succeeds for updated provider', async () => {
    // Start with a Claude provider whose binPath will change
    const updatedProvider = {
      ...claudeProvider,
      binPath: '/opt/new-claude',
    };
    setupFetch([claudeProvider], { supported: true, status: 'supported' });
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    // Open edit dialog
    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    // Change binPath — checkbox should be disabled
    const binPathInput = screen.getByLabelText('Binary Path');
    fireEvent.change(binPathInput, { target: { value: '/opt/new-claude' } });
    expect(screen.getByLabelText('1M context')).toBeDisabled();

    // Mock the PUT response to return the updated provider
    const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (url === '/api/providers' && (!options || !options.method)) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [updatedProvider],
            total: 1,
            limit: 100,
            offset: 0,
          }),
        });
      }
      if (url === '/api/preflight') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            overall: 'pass',
            checks: [],
            providers: [{ id: updatedProvider.id, mcpStatus: 'pass' }],
            supportedMcpProviders: ['claude', 'codex', 'gemini'],
            timestamp: new Date().toISOString(),
          }),
        });
      }
      if (url === `/api/providers/${claudeProvider.id}` && options?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ...updatedProvider, updatedAt: new Date().toISOString() }),
        });
      }
      if (url.match(/\/api\/providers\/[^/]+\/1m-context\/probe$/) && options?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ supported: true, status: 'supported' }),
        });
      }
      if (url.match(/\/api\/providers\/[^/]+\/models$/) && (!options || !options.method)) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: false });
    });

    // Save the updated binPath
    fireEvent.click(screen.getByText('Update'));
    await waitFor(() => expect(screen.queryByText('Edit Provider')).not.toBeInTheDocument());

    // Re-open edit dialog — provider now has the new binPath
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    // Checkbox should be enabled (binPath matches persisted)
    const checkbox = screen.getByLabelText('1M context');
    expect(checkbox).not.toBeDisabled();

    // Click checkbox — should trigger probe
    fireEvent.click(checkbox);
    await waitFor(() => expect(screen.getByText('Supported')).toBeInTheDocument());

    // Verify probe was called against the new persisted provider
    const probeCalls = fetchMock.mock.calls.filter(
      (call: [string, RequestInit?]) =>
        typeof call[0] === 'string' &&
        call[0].includes('/1m-context/probe') &&
        call[1]?.method === 'POST',
    );
    expect(probeCalls.length).toBeGreaterThan(0);
  });

  it('does not include oneMillionContextEnabled in create payload', async () => {
    // Override fetch to also handle POST /api/providers for create
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
          });
        }
        if (url === '/api/preflight') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: [],
              supportedMcpProviders: ['claude', 'codex', 'gemini'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (url === '/api/providers' && options?.method === 'POST') {
          const body = JSON.parse(options.body as string);
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: 'new-id',
              ...body,
              mcpConfigured: false,
              mcpEndpoint: null,
              mcpRegisteredAt: null,
              oneMillionContextEnabled: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          });
        }
        if (url.match(/\/api\/providers\/[^/]+\/models$/) && (!options || !options.method)) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: false });
      },
    );

    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getAllByText('Add Provider').length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    // Switch to Claude using the labeled select
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);

    // Submit the form
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const createCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers' && call[1]?.method === 'POST',
      );
      expect(createCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(createCalls[0][1].body as string);
      expect(body.oneMillionContextEnabled).toBeUndefined();
    });
  });

  it('routes unsupported probe result to "Not supported" UI', async () => {
    setupFetch([claudeProvider], { supported: false, status: 'unsupported' });
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('1M context'));

    await waitFor(() => expect(screen.getByText('Not supported')).toBeInTheDocument());
  });

  it('routes launch_failure probe result to error/retry UI', async () => {
    setupFetch([claudeProvider], { supported: false, status: 'launch_failure' });
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('1M context'));

    await waitFor(() => expect(screen.getByText('Probe failed')).toBeInTheDocument());
  });

  it('routes timeout probe result to error/retry UI', async () => {
    setupFetch([claudeProvider], { supported: false, status: 'timeout' });
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('1M context'));

    await waitFor(() => expect(screen.getByText('Probe failed')).toBeInTheDocument());
  });

  it('routes supported probe result to supported UI (regression guard)', async () => {
    setupFetch([claudeProvider], { supported: true, status: 'supported' });
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByLabelText('1M context')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('1M context'));

    await waitFor(() => expect(screen.getByText('Supported')).toBeInTheDocument());
  });
});

describe('ProvidersPage - provider type select disabled in edit mode', () => {
  const claudeProvider = {
    id: 'p-claude',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    autoCompactThreshold: 10,
    oneMillionContextEnabled: false,
    mcpConfigured: true,
    mcpEndpoint: 'http://127.0.0.1:3000/mcp',
    mcpRegisteredAt: '2024-01-01',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setupFetch(providers: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              items: providers,
              total: providers.length,
              limit: 100,
              offset: 0,
            }),
          });
        }
        if (url === '/api/preflight') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: providers.map((p) => ({
                id: p.id,
                mcpStatus: p.mcpConfigured ? 'pass' : 'warn',
              })),
              supportedMcpProviders: ['claude', 'codex', 'gemini'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (url.match(/\/api\/providers\/[\w-]+$/) && options?.method === 'PUT') {
          const body = JSON.parse(options.body as string);
          const id = url.split('/').pop()!;
          const existing = providers.find((p) => p.id === id);
          return Promise.resolve({
            ok: true,
            json: async () => ({ ...existing, ...body, updatedAt: new Date().toISOString() }),
          });
        }
        if (url === '/api/providers' && options?.method === 'POST') {
          const body = JSON.parse(options.body as string);
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: 'p-new',
              ...body,
              mcpConfigured: false,
              mcpEndpoint: null,
              mcpRegisteredAt: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            }),
          });
        }
        if (url.match(/\/api\/providers\/[^/]+\/models$/) && (!options || !options.method)) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: false });
      },
    );
  }

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  });

  it('disables type select when editing an existing provider', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => expect(screen.getByText('Edit Provider')).toBeInTheDocument());
    const trigger = screen.getByLabelText('Provider Type');
    expect(trigger).toHaveAttribute('data-disabled');
  });

  it('enables type select when adding a new provider', async () => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    const trigger = screen.getByLabelText('Provider Type');
    expect(trigger).not.toHaveAttribute('data-disabled');
  });

  it('update mutation payload does not include name', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => expect(screen.getByText('Edit Provider')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Update'));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const updateCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-claude' && call[1]?.method === 'PUT',
      );
      expect(updateCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(updateCalls[0][1].body as string);
      expect(body).not.toHaveProperty('name');
    });
  });
});

describe('ProvidersPage - provider models management', () => {
  const opencodeProvider = {
    id: 'p-opencode',
    name: 'opencode',
    binPath: '/usr/local/bin/opencode',
    autoCompactThreshold: null,
    oneMillionContextEnabled: false,
    mcpConfigured: true,
    mcpEndpoint: 'http://127.0.0.1:3000/mcp',
    mcpRegisteredAt: '2024-01-01',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  const codexProvider = {
    id: 'p-codex',
    name: 'codex',
    binPath: '/usr/local/bin/codex',
    autoCompactThreshold: null,
    oneMillionContextEnabled: false,
    mcpConfigured: true,
    mcpEndpoint: 'http://127.0.0.1:3000/mcp',
    mcpRegisteredAt: '2024-01-01',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  const modelsByProvider: Record<
    string,
    Array<{ id: string; providerId: string; name: string }>
  > = {
    'p-opencode': [
      { id: 'm-1', providerId: 'p-opencode', name: 'opencode/model-a' },
      { id: 'm-2', providerId: 'p-opencode', name: 'opencode/model-b' },
    ],
    'p-codex': [{ id: 'm-3', providerId: 'p-codex', name: 'openai/gpt-5' }],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setupFetch(providers: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              items: providers,
              total: providers.length,
              limit: 100,
              offset: 0,
            }),
          });
        }
        if (url === '/api/preflight') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: providers.map((p) => ({
                id: p.id,
                mcpStatus: p.mcpConfigured ? 'pass' : 'warn',
              })),
              supportedMcpProviders: ['claude', 'codex', 'gemini', 'opencode'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (url.match(/^\/api\/providers\/[^/]+\/models$/) && (!options || !options.method)) {
          const providerId = url.split('/')[3];
          const models = modelsByProvider[providerId] ?? [];
          return Promise.resolve({
            ok: true,
            json: async () =>
              models.map((model, index) => ({
                ...model,
                position: index,
                createdAt: '2024-01-01',
                updatedAt: '2024-01-01',
              })),
          });
        }
        if (url.match(/^\/api\/providers\/[^/]+\/models$/) && options?.method === 'POST') {
          const body = JSON.parse(options.body as string);
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: 'm-new',
              providerId: url.split('/')[3],
              name: body.name,
              position: 0,
              createdAt: '2024-01-01',
              updatedAt: '2024-01-01',
            }),
          });
        }
        if (
          url.match(/^\/api\/providers\/[^/]+\/models\/discover$/) &&
          options?.method === 'POST'
        ) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ added: ['new-1', 'new-2'], existing: ['old-1'], total: 3 }),
          });
        }
        if (url.match(/^\/api\/providers\/[^/]+\/models\/[^/]+$/) && options?.method === 'DELETE') {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true }),
          });
        }
        if (url.match(/\/api\/providers\/[\w-]+$/) && options?.method === 'PUT') {
          const id = url.split('/').pop()!;
          const body = JSON.parse(options.body as string);
          const existing = providers.find((p: { id: string }) => p.id === id);
          return Promise.resolve({
            ok: true,
            json: async () => ({ ...existing, ...body, updatedAt: new Date().toISOString() }),
          });
        }
        return Promise.resolve({ ok: false });
      },
    );
  }

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  });

  it('fetches models on page load and shows correct collapsed model count', async () => {
    setupFetch([opencodeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('opencode')).toBeInTheDocument());

    const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
    const modelCallsOnLoad = fetchMock.mock.calls.filter(
      (call: [string, RequestInit?]) =>
        call[0] === '/api/providers/p-opencode/models' && (!call[1] || !call[1].method),
    );
    expect(modelCallsOnLoad.length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Models \(2\)/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Models \(/i }));

    await waitFor(() => expect(screen.getByText('opencode/model-a')).toBeInTheDocument());
  });

  it('adds and deletes models from the models section', async () => {
    setupFetch([opencodeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('opencode')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Models \(/i }));
    await waitFor(() => expect(screen.getByText('opencode/model-a')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Add Model'), {
      target: { value: 'opencode/model-new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Model' }));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const postCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-opencode/models' && call[1]?.method === 'POST',
      );
      expect(postCalls.length).toBeGreaterThan(0);
      const postBody = JSON.parse(postCalls[0][1].body as string);
      expect(postBody).toEqual({ name: 'opencode/model-new' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Delete model opencode/model-a' }));
    await waitFor(() => expect(screen.getByText('Delete Model')).toBeInTheDocument());
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const deleteCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-opencode/models/m-1' && call[1]?.method === 'DELETE',
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
    });
  });

  it('shows Auto Discover only for OpenCode providers and calls discover endpoint', async () => {
    setupFetch([opencodeProvider, codexProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('opencode')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: /Models \(/i })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /Models \(/i })[1]);

    const discoverButtons = await screen.findAllByRole('button', { name: /Auto Discover/i });
    expect(discoverButtons).toHaveLength(1);
    fireEvent.click(discoverButtons[0]);

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const discoverCalls = fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-opencode/models/discover' && call[1]?.method === 'POST',
      );
      expect(discoverCalls.length).toBeGreaterThan(0);
    });
  });

  it('invalidates provider-models caches across contexts after add/delete/discover', async () => {
    setupFetch([opencodeProvider]);
    const queryClient = createQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    renderWithQuery(<ProvidersPage />, queryClient);
    await waitFor(() => expect(screen.getByText('opencode')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Models \(/i }));
    await waitFor(() => expect(screen.getByText('opencode/model-a')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Add Model'), {
      target: { value: 'opencode/model-new' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Model' }));
    await waitFor(() => {
      expect(
        invalidateSpy.mock.calls.some(
          ([arg]) =>
            (arg as { queryKey?: unknown[] })?.queryKey?.length === 1 &&
            (arg as { queryKey?: unknown[] })?.queryKey?.[0] === 'provider-models',
        ),
      ).toBe(true);
    });

    invalidateSpy.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Delete model opencode/model-a' }));
    await waitFor(() => expect(screen.getByText('Delete Model')).toBeInTheDocument());
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(
        invalidateSpy.mock.calls.some(
          ([arg]) =>
            (arg as { queryKey?: unknown[] })?.queryKey?.length === 1 &&
            (arg as { queryKey?: unknown[] })?.queryKey?.[0] === 'provider-models',
        ),
      ).toBe(true);
    });

    invalidateSpy.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Auto Discover/i }));
    await waitFor(() => {
      expect(
        invalidateSpy.mock.calls.some(
          ([arg]) =>
            (arg as { queryKey?: unknown[] })?.queryKey?.length === 1 &&
            (arg as { queryKey?: unknown[] })?.queryKey?.[0] === 'provider-models',
        ),
      ).toBe(true);
    });
  });

  it('closes delete confirmation dialog when delete request fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [opencodeProvider], total: 1, limit: 100, offset: 0 }),
          });
        }
        if (url === '/api/preflight') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: [{ id: opencodeProvider.id, mcpStatus: 'pass' }],
              supportedMcpProviders: ['opencode'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (url === '/api/providers/p-opencode/models' && (!options || !options.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => [
              {
                id: 'm-1',
                providerId: 'p-opencode',
                name: 'opencode/model-a',
                position: 0,
                createdAt: '2024-01-01',
                updatedAt: '2024-01-01',
              },
            ],
          });
        }
        if (url === '/api/providers/p-opencode/models/m-1' && options?.method === 'DELETE') {
          return Promise.resolve({
            ok: false,
            json: async () => ({ message: 'Delete failed on server' }),
          });
        }
        return Promise.resolve({ ok: false });
      },
    );

    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('opencode')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Models \(/i }));
    await waitFor(() => expect(screen.getByText('opencode/model-a')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Delete model opencode/model-a' }));
    await waitFor(() => expect(screen.getByText('Delete Model')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('Delete Model')).not.toBeInTheDocument();
    });
  });

  it('preselects OpenCode in edit dialog for opencode providers', async () => {
    setupFetch([opencodeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('opencode')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(screen.getByText('Edit Provider')).toBeInTheDocument());
    expect(screen.getByLabelText('Provider Type')).toHaveTextContent('OpenCode');
  });
});
