import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProvidersPage } from './ProvidersPage';
import {
  CLAUDE_LAUNCH_SETTINGS_MAX_BYTES,
  DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
} from '@devchain/shared';

// Mutable so individual tests can override per-test project context
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockSelectedProject: { id: string; rootPath?: string } | null = null;

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: mockSelectedProject?.id ?? null,
    selectedProject: mockSelectedProject,
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

  it('includes Antigravity CLI as a provider type with the agy default binPath', async () => {
    renderWithQuery(<ProvidersPage />);

    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    fireEvent.click(screen.getByLabelText('Provider Type'));
    const agyOptions = await screen.findAllByText('Antigravity CLI');
    fireEvent.click(agyOptions[agyOptions.length - 1]);

    const binInput = screen.getByLabelText('Binary Path') as HTMLInputElement;
    expect(binInput.value).toBe('agy');
  });

  it('includes Copilot CLI as a provider type with the copilot default binPath', async () => {
    renderWithQuery(<ProvidersPage />);

    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    fireEvent.click(screen.getByLabelText('Provider Type'));
    const copilotOptions = await screen.findAllByText('Copilot CLI');
    fireEvent.click(copilotOptions[copilotOptions.length - 1]);

    const binInput = screen.getByLabelText('Binary Path') as HTMLInputElement;
    expect(binInput.value).toBe('copilot');
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
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'warn',
              checks: [],
              providers: [
                {
                  id: 'p1',
                  name: 'claude',
                  status: 'warn',
                  message: 'MCP not configured',
                  binPath: null,
                  binaryStatus: 'pass',
                  binaryMessage: 'OK',
                  mcpStatus: 'warn',
                  mcpMessage: 'MCP not configured',
                },
              ],
              supportedMcpProviders: ['claude', 'codex', 'opencode'],
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
    claudeLaunchSettingsJson: DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
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
    claudeLaunchSettingsJson: null,
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
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: providers.map((p) => ({
                id: p.id,
                mcpStatus: p.mcpConfigured ? 'pass' : 'warn',
              })),
              supportedMcpProviders: ['claude', 'codex', 'opencode'],
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
    expect(screen.getByText(/Default threshold:.*10%/)).toBeInTheDocument();
  });

  it('displays "disabled" when Claude provider threshold is null', async () => {
    setupFetch([{ ...claudeProvider, autoCompactThreshold: null }]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());
    expect(screen.getByText(/Default threshold:.*disabled/)).toBeInTheDocument();
  });

  it('does not display threshold on non-Claude provider card', async () => {
    setupFetch([codexProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    expect(screen.queryByText(/Default threshold:/)).not.toBeInTheDocument();
  });

  it('shows threshold input with current value when editing Claude provider', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => expect(screen.getByLabelText('Default Threshold (%)')).toBeInTheDocument());
    const thresholdInput = screen.getByLabelText('Default Threshold (%)') as HTMLInputElement;
    expect(thresholdInput.value).toBe('10');
  });

  it('does not show threshold input when editing non-Claude provider', async () => {
    setupFetch([codexProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => expect(screen.getByText('Edit Provider')).toBeInTheDocument());
    expect(screen.queryByLabelText('Default Threshold (%)')).not.toBeInTheDocument();
  });

  it('shows threshold input in create dialog when Claude type is selected', async () => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);

    // Default type is Codex - threshold should not show
    expect(screen.queryByLabelText('Default Threshold (%)')).not.toBeInTheDocument();

    // Switch to Claude
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);

    expect(screen.getByLabelText('Default Threshold (%)')).toBeInTheDocument();
  });

  it('starts Add-Claude with the formatted default', async () => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);

    expect(screen.getByLabelText('Advanced: Claude Launch Settings JSON')).toHaveValue(
      DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
    );
  });

  it('sends explicit null when Add-Claude launch settings are cleared', async () => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);
    fireEvent.change(screen.getByLabelText('Advanced: Claude Launch Settings JSON'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const createCall = fetchMock.mock.calls.find(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers' && call[1]?.method === 'POST',
      );
      expect(createCall).toBeDefined();
      expect(JSON.parse(createCall![1].body as string)).toMatchObject({
        name: 'claude',
        claudeLaunchSettingsJson: null,
      });
    });
  });

  it('maps stored null to blank, restores the default, and round-trips custom text verbatim', async () => {
    setupFetch([{ ...claudeProvider, claudeLaunchSettingsJson: null }]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));
    const textarea = screen.getByLabelText(
      'Advanced: Claude Launch Settings JSON',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Restore DevChain default' }));
    expect(textarea.value).toBe(DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON);

    const custom = '  {\n    "futureSetting": true\n  }\n';
    fireEvent.change(textarea, { target: { value: custom } });
    fireEvent.click(screen.getByText('Update'));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const updateCall = fetchMock.mock.calls.find(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-claude' && call[1]?.method === 'PUT',
      );
      expect(updateCall).toBeDefined();
      expect(JSON.parse(updateCall![1].body as string).claudeLaunchSettingsJson).toBe(custom);
    });
  });

  it.each([
    ['malformed JSON', '{'],
    ['non-object JSON', '[]'],
    ['oversized JSON', `{"value":"${'a'.repeat(CLAUDE_LAUNCH_SETTINGS_MAX_BYTES)}"}`],
    ['reserved context env', '{"env":{"DEVCHAIN_CONTEXT_WINDOW_TOKENS":"1000000"}}'],
    ['reserved base URL env', '{"env":{"ANTHROPIC_BASE_URL":"https://example.com"}}'],
    ['unsafe nested key', '{"nested":{"constructor":{"value":true}}}'],
  ])('blocks %s launch settings before mutation', async (_label, value) => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);
    fireEvent.click(screen.getByLabelText('Provider Type'));
    const claudeOptions = await screen.findAllByText('Claude');
    fireEvent.click(claudeOptions[claudeOptions.length - 1]);
    const textarea = screen.getByLabelText('Advanced: Claude Launch Settings JSON');
    fireEvent.change(textarea, { target: { value } });
    fireEvent.submit(screen.getByText('Create').closest('form')!);

    await waitFor(() => expect(textarea.className).toContain('border-destructive'));
    const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
    expect(
      fetchMock.mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers' && call[1]?.method === 'POST',
      ),
    ).toHaveLength(0);
  });

  it('routes backend launch-settings field errors to the Advanced textarea', async () => {
    setupFetch([claudeProvider]);
    const successfulFetch = (global as unknown as { fetch: jest.Mock }).fetch;
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers/p-claude' && options?.method === 'PUT') {
          return Promise.resolve({
            ok: false,
            json: async () => ({
              message: 'Backend rejected Claude launch settings',
              field: 'claudeLaunchSettingsJson',
            }),
          });
        }
        return successfulFetch(url, options);
      },
    );

    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Edit'));
    const textarea = screen.getByLabelText('Advanced: Claude Launch Settings JSON');
    fireEvent.click(screen.getByText('Update'));

    await waitFor(() =>
      expect(screen.getByText('Backend rejected Claude launch settings')).toBeInTheDocument(),
    );
    expect(textarea.className).toContain('border-destructive');
  });

  it('includes autoCompactThreshold in update mutation payload', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => expect(screen.getByLabelText('Default Threshold (%)')).toBeInTheDocument());
    const thresholdInput = screen.getByLabelText('Default Threshold (%)');
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
      expect(body).not.toHaveProperty('oneMillionContextEnabled');
      expect(body).not.toHaveProperty('autoCompactThreshold1m');
    });
  });

  it('sends null for autoCompactThreshold when threshold input is empty on update', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => expect(screen.getByLabelText('Default Threshold (%)')).toBeInTheDocument());
    const thresholdInput = screen.getByLabelText('Default Threshold (%)');
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
    const thresholdInput = screen.getByLabelText('Default Threshold (%)');
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
      expect(body).not.toHaveProperty('oneMillionContextEnabled');
      expect(body).not.toHaveProperty('autoCompactThreshold1m');
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

    const thresholdInput = screen.getByLabelText('Default Threshold (%)');
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
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: [],
              supportedMcpProviders: ['claude', 'codex', 'opencode'],
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

    const thresholdInput = screen.getByLabelText('Default Threshold (%)') as HTMLInputElement;
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
        expect(screen.getByLabelText('Default Threshold (%)')).toBeInTheDocument(),
      );
      const thresholdInput = screen.getByLabelText('Default Threshold (%)');
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

  it('does not render retired context controls or call the probe endpoint', async () => {
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Edit'));

    await waitFor(() => expect(screen.getByLabelText('Default Threshold (%)')).toBeInTheDocument());
    expect(screen.queryByLabelText('1M context')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Opus 1M Threshold (%)')).not.toBeInTheDocument();

    const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
    expect(
      fetchMock.mock.calls.some((call: [string]) => call[0].includes('/1m-context/probe')),
    ).toBe(false);
  });
});

describe('ProvidersPage - provider type select disabled in edit mode', () => {
  const claudeProvider = {
    id: 'p-claude',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    autoCompactThreshold: 10,
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
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: providers.map((p) => ({
                id: p.id,
                mcpStatus: p.mcpConfigured ? 'pass' : 'warn',
              })),
              supportedMcpProviders: ['claude', 'codex', 'opencode'],
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
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: providers.map((p) => ({
                id: p.id,
                mcpStatus: p.mcpConfigured ? 'pass' : 'warn',
              })),
              supportedMcpProviders: ['claude', 'codex', 'opencode'],
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
        if (url.startsWith('/api/preflight')) {
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

// ============================================
// Sync to Projects tests
// ============================================

describe('ProvidersPage - create provider auto-propagation', () => {
  it('create-provider sends POST and receives { provider, sync } response', async () => {
    const mockProvider = {
      id: 'p1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      autoCompactThreshold: null,
      mcpConfigured: false,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method || options.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
          });
        }
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: [],
              supportedMcpProviders: ['claude', 'codex', 'opencode'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (url === '/api/providers' && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              provider: { ...mockProvider, id: 'new-p' },
              sync: {
                providerId: 'new-p',
                insertedCount: 3,
                affectedProjectIds: ['proj-1'],
                skippedExistingCount: 0,
                skippedConflictCount: 0,
                warnings: [],
                excludedAuthorCount: 0,
                scopeConfigHash: 'test',
              },
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();

    renderWithQuery(<ProvidersPage />);

    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);
    await waitFor(() =>
      expect(screen.getByText('Add Provider', { selector: 'h2' })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const createCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === '/api/providers' && call[1]?.method === 'POST',
      );
      expect(createCalls.length).toBeGreaterThan(0);
    });
  });
});

// ============================================
// Rescan button tests
// ============================================

describe('ProvidersPage - Rescan', () => {
  function setupRescanFetch(rescanResult?: {
    discovered: Array<{ name: string; binPath: string }>;
    alreadyPresent: string[];
    notFound: string[];
    syncResults: Array<{ providerId: string; insertedCount: number }>;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method || options.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
          });
        }
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: [],
              supportedMcpProviders: ['claude', 'codex', 'opencode'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (url === '/api/providers/rescan' && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: async () =>
              rescanResult ?? {
                discovered: [{ name: 'claude', binPath: '/usr/bin/claude' }],
                alreadyPresent: ['codex'],
                notFound: ['opencode'],
                syncResults: [{ providerId: 'p1', insertedCount: 3 }],
              },
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  }

  it('renders Rescan button in page header', async () => {
    setupRescanFetch();
    renderWithQuery(<ProvidersPage />);

    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /rescan/i })).toBeInTheDocument();
  });

  it('fires POST /api/providers/rescan on click', async () => {
    setupRescanFetch();
    renderWithQuery(<ProvidersPage />);

    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /rescan/i }));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const rescanCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === '/api/providers/rescan' && call[1]?.method === 'POST',
      );
      expect(rescanCalls.length).toBeGreaterThan(0);
    });
  });

  it('invalidates queries after successful rescan', async () => {
    setupRescanFetch();
    const qc = createQueryClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    renderWithQuery(<ProvidersPage />, qc);

    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /rescan/i }));

    await waitFor(() => {
      const predicateCalls = invalidateSpy.mock.calls.filter(
        (call) => call[0] && typeof (call[0] as { predicate?: unknown }).predicate === 'function',
      );
      expect(predicateCalls.length).toBeGreaterThan(0);
    });
  });

  it('handles rescan error without crashing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method || options.method === 'GET')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [], total: 0, limit: 100, offset: 0 }),
          });
        }
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: [],
              supportedMcpProviders: [],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (url === '/api/providers/rescan' && options?.method === 'POST') {
          return Promise.resolve({
            ok: false,
            json: async () => ({ message: 'Rescan failed: internal error' }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();

    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /rescan/i }));

    await waitFor(() => {
      const fetchMock = (global as unknown as { fetch?: unknown }).fetch as jest.Mock;
      const rescanCalls = fetchMock.mock.calls.filter(
        (call) => call[0] === '/api/providers/rescan' && call[1]?.method === 'POST',
      );
      expect(rescanCalls.length).toBeGreaterThan(0);
    });

    expect(screen.getByText('Providers')).toBeInTheDocument();
  });
});

// ============================================
// MCP badge + Configure button state coverage
// ============================================

describe('ProvidersPage - MCP badge and Configure MCP button states', () => {
  const baseProvider = {
    id: 'p-badge',
    name: 'codex',
    binPath: '/usr/local/bin/codex',
    autoCompactThreshold: null,
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setupFetch(preflightProviders: any[], preflightOk = true, neverResolve = false) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [baseProvider], total: 1, limit: 100, offset: 0 }),
          });
        }
        if (url.startsWith('/api/preflight')) {
          if (neverResolve) return new Promise(() => {});
          return Promise.resolve({
            ok: preflightOk,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: preflightProviders,
              supportedMcpProviders: ['codex', 'claude', 'opencode'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        return Promise.resolve({ ok: false });
      },
    );
  }

  beforeEach(() => {
    mockSelectedProject = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  });

  it('shows MCP OK badge and hides Configure button when mcpStatus is pass (unused provider)', async () => {
    mockSelectedProject = { id: 'proj-1', rootPath: '/proj-1' };
    setupFetch([
      {
        id: 'p-badge',
        name: 'codex',
        status: 'pass',
        message: 'OK',
        binPath: null,
        binaryStatus: 'pass',
        binaryMessage: 'OK',
        mcpStatus: 'pass',
        usedByAgents: [],
      },
    ]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    expect(screen.getByText('MCP OK')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /configure mcp/i })).not.toBeInTheDocument();
  });

  it('shows MCP WARN badge and enabled Configure button when mcpStatus is warn (unused provider)', async () => {
    mockSelectedProject = { id: 'proj-1', rootPath: '/proj-1' };
    setupFetch([
      {
        id: 'p-badge',
        name: 'codex',
        status: 'warn',
        message: 'Not configured',
        binPath: null,
        binaryStatus: 'pass',
        binaryMessage: 'OK',
        mcpStatus: 'warn',
        mcpMessage: 'Not configured',
        usedByAgents: [],
      },
    ]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    expect(screen.getByText('MCP WARN')).toBeInTheDocument();
    const configBtn = screen.getByRole('button', { name: /configure mcp/i });
    expect(configBtn).toBeInTheDocument();
    expect(configBtn).not.toBeDisabled();
  });

  it('shows MCP OK badge and hides Configure button for used provider with MCP registered', async () => {
    mockSelectedProject = { id: 'proj-1', rootPath: '/proj-1' };
    setupFetch([
      {
        id: 'p-badge',
        name: 'codex',
        status: 'pass',
        message: 'OK',
        binPath: null,
        binaryStatus: 'pass',
        binaryMessage: 'OK',
        mcpStatus: 'pass',
        usedByAgents: ['Agent A', 'Agent B'],
      },
    ]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    expect(screen.getByText('MCP OK')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /configure mcp/i })).not.toBeInTheDocument();
  });

  it('shows amber MCP WARN badge and disabled Configure button when requiresProjectContext and no project selected', async () => {
    mockSelectedProject = null;
    setupFetch([
      {
        id: 'p-badge',
        name: 'codex',
        status: 'warn',
        message: 'Requires project context',
        binPath: null,
        binaryStatus: 'pass',
        binaryMessage: 'OK',
        mcpStatus: 'warn',
        requiresProjectContext: true,
      },
    ]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    expect(screen.getByText('MCP WARN')).toBeInTheDocument();
    const configBtn = screen.getByRole('button', { name: /configure mcp/i });
    expect(configBtn).toBeDisabled();
  });

  it('shows Checking… badge and hides Configure button while preflight is loading', async () => {
    setupFetch([], true, true);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    expect(screen.getByText(/Checking/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /configure mcp/i })).not.toBeInTheDocument();
  });

  it('shows MCP Check failed badge and hides Configure button when preflight query errors', async () => {
    setupFetch([], false);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Check failed/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /configure mcp/i })).not.toBeInTheDocument();
  });

  it('shows neutral MCP — badge and hides Configure button when provider has no preflight entry', async () => {
    setupFetch([]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('MCP —')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /configure mcp/i })).not.toBeInTheDocument();
  });
});

// ============================================
// Mutation → preflight invalidation
// ============================================

describe('ProvidersPage - CRUD mutations invalidate preflight query', () => {
  const provider = {
    id: 'p-mut',
    name: 'codex',
    binPath: '/usr/local/bin/codex',
    autoCompactThreshold: null,
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  beforeEach(() => {
    mockSelectedProject = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  });

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
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: providers.map((p) => ({
                id: p.id,
                name: p.name,
                status: 'pass',
                message: 'OK',
                binPath: null,
                binaryStatus: 'pass',
                binaryMessage: 'OK',
                mcpStatus: p.mcpConfigured ? ('pass' as const) : ('warn' as const),
              })),
              supportedMcpProviders: ['codex', 'claude', 'opencode'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        if (url === '/api/providers' && options?.method === 'POST') {
          const body = JSON.parse(options.body as string);
          return Promise.resolve({
            ok: true,
            json: async () => ({
              provider: {
                id: 'p-new',
                ...body,
                mcpConfigured: false,
                mcpEndpoint: null,
                mcpRegisteredAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              sync: null,
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
        if (url.match(/\/api\/providers\/[\w-]+$/) && options?.method === 'DELETE') {
          return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
        }
        return Promise.resolve({ ok: false });
      },
    );
  }

  it('create mutation invalidates preflight providers-page query on success', async () => {
    setupFetch([]);
    const qc = createQueryClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    renderWithQuery(<ProvidersPage />, qc);
    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('Add Provider')[0]);
    await waitFor(() =>
      expect(screen.getByText('Add Provider', { selector: 'h2' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const preflightPageInvalidated = invalidateSpy.mock.calls.some(([arg]) => {
        const key = (arg as { queryKey?: unknown[] })?.queryKey;
        return Array.isArray(key) && key[0] === 'preflight' && key[1] === 'providers-page';
      });
      expect(preflightPageInvalidated).toBe(true);
    });
  });

  it('delete mutation invalidates preflight providers-page query on success', async () => {
    setupFetch([provider]);
    const qc = createQueryClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    renderWithQuery(<ProvidersPage />, qc);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(screen.getByText('Delete Provider')).toBeInTheDocument());
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      const preflightPageInvalidated = invalidateSpy.mock.calls.some(([arg]) => {
        const key = (arg as { queryKey?: unknown[] })?.queryKey;
        return Array.isArray(key) && key[0] === 'preflight' && key[1] === 'providers-page';
      });
      expect(preflightPageInvalidated).toBe(true);
    });
  });

  it('update mutation invalidates preflight providers-page query on success', async () => {
    setupFetch([provider]);
    const qc = createQueryClient();
    const invalidateSpy = jest.spyOn(qc, 'invalidateQueries');
    renderWithQuery(<ProvidersPage />, qc);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await waitFor(() => expect(screen.getByText('Edit Provider')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^update$/i }));

    await waitFor(() => {
      const preflightPageInvalidated = invalidateSpy.mock.calls.some(([arg]) => {
        const key = (arg as { queryKey?: unknown[] })?.queryKey;
        return Array.isArray(key) && key[0] === 'preflight' && key[1] === 'providers-page';
      });
      expect(preflightPageInvalidated).toBe(true);
    });
  });
});

// ============================================
// Aggregate-fail guard: mcpStatus:'fail' rendering
// ============================================

describe('ProvidersPage - aggregate-fail MCP badge guard', () => {
  const baseProvider = {
    id: 'p-fail',
    name: 'codex',
    binPath: '/usr/local/bin/codex',
    autoCompactThreshold: null,
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setupFetch(preflightProviders: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      (url: string, options?: RequestInit) => {
        if (url === '/api/providers' && (!options || !options.method)) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ items: [baseProvider], total: 1, limit: 100, offset: 0 }),
          });
        }
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'fail',
              checks: [],
              providers: preflightProviders,
              supportedMcpProviders: ['codex', 'claude', 'opencode'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        return Promise.resolve({ ok: false });
      },
    );
  }

  beforeEach(() => {
    mockSelectedProject = { id: 'proj-1', rootPath: '/proj-1' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  });

  it('shows red MCP FAIL badge and enabled Configure button when mcpStatus is fail', async () => {
    setupFetch([
      {
        id: 'p-fail',
        name: 'codex',
        status: 'fail',
        message: 'MCP check failed',
        binPath: null,
        binaryStatus: 'pass',
        binaryMessage: 'OK',
        mcpStatus: 'fail',
        mcpMessage: 'boom',
      },
    ]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    expect(screen.getByText('MCP FAIL')).toBeInTheDocument();
    const configBtn = screen.getByRole('button', { name: /configure mcp/i });
    expect(configBtn).toBeInTheDocument();
    expect(configBtn).not.toBeDisabled();
  });

  it('shows MCP FAIL badge and disabled Configure button when mcpStatus is fail + requiresProjectContext + no project', async () => {
    mockSelectedProject = null;
    setupFetch([
      {
        id: 'p-fail',
        name: 'codex',
        status: 'fail',
        message: 'MCP check failed',
        binPath: null,
        binaryStatus: 'pass',
        binaryMessage: 'OK',
        mcpStatus: 'fail',
        mcpMessage: 'boom',
        requiresProjectContext: true,
      },
    ]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    expect(screen.getByText('MCP FAIL')).toBeInTheDocument();
    const configBtn = screen.getByRole('button', { name: /configure mcp/i });
    expect(configBtn).toBeDisabled();
  });

  // Guard: aggregate status:'fail' with mcpStatus absent must NOT render the neutral "—" badge.
  // The UI defensively derives MCP FAIL from pf.status when mcpStatus is missing, preventing
  // silent regression if the backend rejection fallback ever omits mcpStatus again.
  it('renders MCP FAIL (not neutral —) when aggregate status is fail but mcpStatus is absent', async () => {
    setupFetch([
      {
        id: 'p-fail',
        name: 'codex',
        status: 'fail',
        message: 'unexpected error',
        binPath: null,
        binaryStatus: 'warn',
        binaryMessage: 'unknown',
        // mcpStatus deliberately omitted to simulate allSettled rejection without populated mcpStatus
      },
    ]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('codex')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('MCP FAIL')).toBeInTheDocument());
    expect(screen.queryByText('MCP —')).not.toBeInTheDocument();
  });
});

describe('ProvidersPage - provider effort levels management', () => {
  const claudeProvider = {
    id: 'p-claude',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    autoCompactThreshold: null,
    mcpConfigured: true,
    mcpEndpoint: 'http://127.0.0.1:3000/mcp',
    mcpRegisteredAt: '2024-01-01',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
  };

  const agyProvider = {
    ...claudeProvider,
    id: 'p-agy',
    name: 'agy',
    binPath: '/usr/local/bin/agy',
  };

  // Per-provider effort state. supportsEffort is the capability signal; empty efforts
  // is a valid manageable state (empty ≠ unsupported).
  const effortsByProvider: Record<
    string,
    Array<{ id: string; providerId: string; name: string }>
  > = {
    'p-claude': [{ id: 'e-1', providerId: 'p-claude', name: 'high' }],
  };
  const supportsByProvider: Record<string, boolean> = {
    'p-claude': true,
    'p-agy': false,
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
        if (url.startsWith('/api/preflight')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              overall: 'pass',
              checks: [],
              providers: providers.map((p) => ({
                id: p.id,
                mcpStatus: p.mcpConfigured ? 'pass' : 'warn',
              })),
              supportedMcpProviders: ['claude', 'codex', 'opencode'],
              timestamp: new Date().toISOString(),
            }),
          });
        }
        // Models endpoint — return empty so the sibling Models section doesn't interfere.
        if (url.match(/^\/api\/providers\/[^/]+\/models$/) && (!options || !options.method)) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        // Efforts GET → capability-gated response shape.
        if (url.match(/^\/api\/providers\/[^/]+\/efforts$/) && (!options || !options.method)) {
          const providerId = url.split('/')[3];
          const efforts = effortsByProvider[providerId] ?? [];
          return Promise.resolve({
            ok: true,
            json: async () => ({
              efforts: efforts.map((effort, index) => ({
                ...effort,
                position: index,
                createdAt: '2024-01-01',
                updatedAt: '2024-01-01',
              })),
              supportsEffort: supportsByProvider[providerId] ?? false,
              requiresModelForEffort: false,
            }),
          });
        }
        if (url.match(/^\/api\/providers\/[^/]+\/efforts$/) && options?.method === 'POST') {
          const body = JSON.parse(options.body as string);
          return Promise.resolve({
            ok: true,
            json: async () => ({
              id: 'e-new',
              providerId: url.split('/')[3],
              name: body.name,
              position: 0,
              createdAt: '2024-01-01',
              updatedAt: '2024-01-01',
            }),
          });
        }
        if (
          url.match(/^\/api\/providers\/[^/]+\/efforts\/[^/]+$/) &&
          options?.method === 'DELETE'
        ) {
          return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
        }
        if (url.match(/\/api\/providers\/[\w-]+$/) && options?.method === 'PUT') {
          return Promise.resolve({ ok: true, json: async () => providers[0] });
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

  it('shows the effort section with add affordance for a capable provider even when empty (empty ≠ unsupported)', async () => {
    // Capable provider with NO effort values yet — section must still render + be usable.
    effortsByProvider['p-claude'] = [];
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Effort Levels \(0\)/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Effort Levels \(/i }));

    await waitFor(() =>
      expect(screen.getByText('No effort levels configured.')).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Add Effort Level')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Effort Level' })).toBeInTheDocument();
  });

  it('hides the effort section entirely for a non-capable provider (agy)', async () => {
    setupFetch([agyProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('agy')).toBeInTheDocument());

    // The effort query resolves with supportsEffort:false → section renders nothing.
    await waitFor(() => {
      const effortCalls = (
        (global as unknown as { fetch?: unknown }).fetch as jest.Mock
      ).mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-agy/efforts' && (!call[1] || !call[1].method),
      );
      expect(effortCalls.length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Effort Levels/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Add Effort Level')).not.toBeInTheDocument();
  });

  it('adds and deletes effort levels from the effort section (themed confirm dialog)', async () => {
    effortsByProvider['p-claude'] = [{ id: 'e-1', providerId: 'p-claude', name: 'high' }];
    setupFetch([claudeProvider]);
    renderWithQuery(<ProvidersPage />);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    // The effort section renders null until the capability query resolves (unlike
    // Models, which always renders), so await the button before expanding.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Effort Levels \(1\)/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Effort Levels \(/i }));
    await waitFor(() => expect(screen.getByText('high')).toBeInTheDocument());

    // Add
    fireEvent.change(screen.getByLabelText('Add Effort Level'), { target: { value: 'max' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Effort Level' }));
    await waitFor(() => {
      const postCalls = (
        (global as unknown as { fetch?: unknown }).fetch as jest.Mock
      ).mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-claude/efforts' && call[1]?.method === 'POST',
      );
      expect(postCalls.length).toBeGreaterThan(0);
      expect(JSON.parse(postCalls[0][1].body as string)).toEqual({ name: 'max' });
    });

    // Delete via themed dialog (not window.confirm)
    fireEvent.click(screen.getByRole('button', { name: 'Delete effort level high' }));
    await waitFor(() => expect(screen.getByText('Delete Effort Level')).toBeInTheDocument());
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      const deleteCalls = (
        (global as unknown as { fetch?: unknown }).fetch as jest.Mock
      ).mock.calls.filter(
        (call: [string, RequestInit?]) =>
          call[0] === '/api/providers/p-claude/efforts/e-1' && call[1]?.method === 'DELETE',
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
    });
  });

  it('invalidates provider-efforts caches across contexts after add/delete', async () => {
    effortsByProvider['p-claude'] = [{ id: 'e-1', providerId: 'p-claude', name: 'high' }];
    setupFetch([claudeProvider]);
    const queryClient = createQueryClient();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    renderWithQuery(<ProvidersPage />, queryClient);
    await waitFor(() => expect(screen.getByText('claude')).toBeInTheDocument());

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Effort Levels \(1\)/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Effort Levels \(/i }));
    await waitFor(() => expect(screen.getByText('high')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Add Effort Level'), { target: { value: 'max' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Effort Level' }));
    await waitFor(() => {
      expect(
        invalidateSpy.mock.calls.some(
          ([arg]) =>
            (arg as { queryKey?: unknown[] })?.queryKey?.length === 1 &&
            (arg as { queryKey?: unknown[] })?.queryKey?.[0] === 'provider-efforts',
        ),
      ).toBe(true);
    });

    invalidateSpy.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Delete effort level high' }));
    await waitFor(() => expect(screen.getByText('Delete Effort Level')).toBeInTheDocument());
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(
        invalidateSpy.mock.calls.some(
          ([arg]) =>
            (arg as { queryKey?: unknown[] })?.queryKey?.length === 1 &&
            (arg as { queryKey?: unknown[] })?.queryKey?.[0] === 'provider-efforts',
        ),
      ).toBe(true);
    });
  });
});
