import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('ProvidersPage - Provider Type presets and command previews', () => {
  beforeEach(() => {
    // Mock fetch for providers list
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as unknown as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    // Mock clipboard in jsdom (navigator.clipboard is undefined by default)
    Object.defineProperty(global.navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      configurable: true,
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
