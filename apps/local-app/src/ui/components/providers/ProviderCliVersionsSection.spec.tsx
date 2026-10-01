import React from 'react';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProviderCliVersionsSection } from './ProviderCliVersionsSection';
import type { ProviderClisOverview } from '@devchain/shared';

// Mutable per-test remote fixtures; the hook itself is Task-4-owned, so the
// section spec mocks the data source and tests only the presentation contract.
let mockRemotes: Array<{
  id: string;
  name: string;
  online: boolean;
  providerClis?: Record<string, unknown> | null;
  cliVersions?: Record<string, string | null> | null;
}> = [];

jest.mock('@/ui/hooks/useRemotes', () => ({
  useRemotes: () => ({
    remotes: mockRemotes,
    remotesLoading: false,
    bindings: [],
    bindingsLoading: false,
    bindingByProjectId: new Map(),
    createRemote: {},
    deleteRemote: {},
    renameRemote: {},
  }),
}));

function overviewFixture(): ProviderClisOverview {
  return {
    providers: {
      claude: {
        provider: 'claude',
        npmPackage: '@anthropic-ai/claude-code',
        setting: { version: '2.1.281', homeManaged: true },
        lookup: {
          latestVersion: '2.1.285',
          versions: ['2.1.285', '2.1.284', '2.1.283'],
          checkedAt: '2026-09-28T10:00:00.000Z',
          error: null,
        },
        install: {
          desiredVersion: '2.1.281',
          installedVersion: '2.1.281',
          state: 'idle',
          error: null,
          checkedAt: '2026-09-28T10:00:00.000Z',
        },
      },
      codex: {
        provider: 'codex',
        npmPackage: '@openai/codex',
        setting: { version: 'latest', homeManaged: false },
        lookup: {
          latestVersion: '0.158.0',
          versions: ['0.158.0', '0.157.0'],
          checkedAt: '2026-09-28T10:00:00.000Z',
          error: null,
        },
        // Opted out after a managed install: the report still carries the last
        // managed version, which the row must not present as active.
        install: {
          desiredVersion: 'latest',
          installedVersion: '0.156.1',
          state: 'idle',
          error: null,
          checkedAt: '2026-09-28T09:00:00.000Z',
        },
      },
      copilot: {
        provider: 'copilot',
        npmPackage: '@github/copilot',
        setting: { version: 'latest', homeManaged: true },
        lookup: {
          latestVersion: null,
          versions: [],
          checkedAt: '2026-09-28T10:00:00.000Z',
          error: 'ENOTFOUND registry.npmjs.org',
        },
        install: {
          desiredVersion: 'latest',
          installedVersion: '1.0.88',
          state: 'idle',
          error: null,
          checkedAt: null,
        },
      },
      opencode: {
        provider: 'opencode',
        npmPackage: 'opencode-ai',
        setting: { version: '1.18.32', homeManaged: true },
        lookup: {
          latestVersion: '1.18.33',
          versions: ['1.18.33', '1.18.32'],
          checkedAt: '2026-09-28T10:00:00.000Z',
          error: null,
        },
        install: {
          desiredVersion: '1.18.33',
          installedVersion: '1.18.32',
          state: 'failed',
          error: 'npm not found; stays on own install',
          checkedAt: '2026-09-28T10:05:00.000Z',
        },
      },
    },
  };
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProviderCliVersionsSection />
    </QueryClientProvider>,
  );
}

function installFetchMock(overview: ProviderClisOverview = overviewFixture()) {
  return jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/provider-clis' && method === 'GET') {
      return Promise.resolve({ ok: true, json: async () => overview });
    }
    if (url === '/api/provider-clis/check' && method === 'POST') {
      return Promise.resolve({ ok: true, json: async () => ({ lookups: {} }) });
    }
    if (url.startsWith('/api/provider-clis/') && method === 'PUT') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          provider: 'claude',
          setting: { version: 'latest', homeManaged: true },
        }),
      });
    }
    return Promise.resolve({ ok: false, json: async () => ({}) });
  });
}

describe('ProviderCliVersionsSection', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = installFetchMock();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
    mockRemotes = [
      {
        id: 'vm-1',
        name: 'workstation',
        online: true,
        providerClis: {
          claude: {
            desiredVersion: '2.1.281',
            installedVersion: '2.1.281',
            state: 'idle',
            error: null,
            checkedAt: '2026-09-28T10:00:00.000Z',
          },
          opencode: {
            desiredVersion: '1.18.33',
            installedVersion: null,
            state: 'installing',
            error: null,
            checkedAt: null,
          },
        },
        cliVersions: { agy: '1.2.11' },
      },
      {
        id: 'vm-2',
        name: 'laptop-vm',
        online: false,
        providerClis: {
          claude: {
            desiredVersion: '2.1.280',
            installedVersion: '2.1.280',
            state: 'idle',
            error: null,
            checkedAt: '2026-09-27T10:00:00.000Z',
          },
        },
        cliVersions: {},
      },
    ];
  });

  async function awaitLoaded() {
    await screen.findByRole('row', { name: 'Claude CLI version' });
  }

  it('renders a row per managed provider plus the read-only Antigravity row', async () => {
    renderSection();

    await waitFor(() => expect(screen.getByText('CLI versions')).toBeInTheDocument());
    await awaitLoaded();
    for (const rowLabel of [
      'Claude CLI version',
      'Codex CLI version',
      'Copilot CLI version',
      'OpenCode CLI version',
      'Antigravity CLI version',
    ]) {
      expect(screen.getByRole('row', { name: rowLabel })).toBeInTheDocument();
    }

    const agyRow = screen.getByRole('row', { name: 'Antigravity CLI version' });
    expect(within(agyRow).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(agyRow).getByText('Read-only')).toBeInTheDocument();
  });

  it('shows the This-PC status: managed, own install, failed error, and check failure', async () => {
    const view = renderSection();

    await waitFor(() => expect(screen.getByText('CLI versions')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Your own install')).toBeInTheDocument());

    expect(screen.getByText('Failed: npm not found; stays on own install')).toBeInTheDocument();
    expect(screen.getByText('Last check failed')).toBeInTheDocument();
    expect(screen.getAllByText('2.1.281').length).toBeGreaterThan(0);

    // Opted out after a managed install: the stale managed version (0.156.1)
    // must not appear anywhere in the codex row as an active version.
    const codexRow = screen.getByRole('row', { name: 'Codex CLI version' });
    expect(within(codexRow).queryByText('0.156.1')).not.toBeInTheDocument();

    view.unmount();

    // Real-shape variants: never-managed (idle null) and managed-but-not-yet-installed.
    const variant = overviewFixture();
    variant.providers.codex.install = {
      desiredVersion: 'latest',
      installedVersion: null,
      state: 'idle',
      error: null,
      checkedAt: null,
    };
    variant.providers.claude.install = {
      desiredVersion: '2.1.281',
      installedVersion: null,
      state: 'idle',
      error: null,
      checkedAt: null,
    };
    fetchMock = installFetchMock(variant);
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    renderSection();

    await waitFor(() => expect(screen.getByText('Not installed yet')).toBeInTheDocument());
    expect(screen.getAllByText('Your own install').length).toBeGreaterThan(0);
  });

  it('offers Latest and the newest stable releases in the version dropdown', async () => {
    renderSection();

    await awaitLoaded();
    fireEvent.click(screen.getByRole('combobox', { name: 'Claude version' }));

    await waitFor(() => expect(screen.getAllByText('Latest').length).toBeGreaterThan(0));
    expect(screen.getAllByText('2.1.285').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2.1.284').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2.1.283').length).toBeGreaterThan(0);
  });

  it('saves a version change to home via PUT /api/provider-clis/:provider', async () => {
    renderSection();

    await awaitLoaded();
    fireEvent.click(screen.getByRole('combobox', { name: 'Claude version' }));
    const option = await screen.findAllByText('2.1.285');
    fireEvent.click(option[option.length - 1]);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/provider-clis/claude',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ version: '2.1.285', homeManaged: true }),
        }),
      ),
    );
  });

  it('saves the Managed by DevChain toggle', async () => {
    renderSection();

    const toggle = await screen.findByRole('switch', {
      name: 'Managed by DevChain on this PC: Claude',
    });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/provider-clis/claude',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ version: '2.1.281', homeManaged: false }),
        }),
      ),
    );
  });

  it('runs an immediate check with Check now and refreshes the overview', async () => {
    renderSection();

    const button = await screen.findByRole('button', { name: /Check now/i });
    fireEvent.click(button);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/provider-clis/check',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    // The overview refetch follows the check.
    await waitFor(() => {
      const getCalls = fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === '/api/provider-clis' && (init?.method ?? 'GET') === 'GET',
      );
      expect(getCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows VM status per provider column, marking offline reports stale', async () => {
    renderSection();

    await awaitLoaded();

    const claudeRow = screen.getByRole('row', { name: 'Claude CLI version' });
    // One in the version dropdown display, one in the online VM's cell.
    expect(within(claudeRow).getAllByText('2.1.281').length).toBe(2);
    expect(within(claudeRow).getByText('2.1.280 (stale)')).toBeInTheDocument(); // vm-2 offline
    expect(within(claudeRow).queryAllByText('No report yet').length).toBe(0);

    const codexRow = screen.getByRole('row', { name: 'Codex CLI version' });
    expect(
      within(codexRow).getAllByText('No report yet').length, // neither VM reported codex
    ).toBe(2);

    const opencodeRow = screen.getByRole('row', { name: 'OpenCode CLI version' });
    expect(within(opencodeRow).getAllByText('Installing').length).toBe(1);

    const agyRow = screen.getByRole('row', { name: 'Antigravity CLI version' });
    expect(within(agyRow).getByText('1.2.11')).toBeInTheDocument();
    expect(within(agyRow).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders with zero VMs without extra columns', async () => {
    mockRemotes = [];
    renderSection();

    await awaitLoaded();
    const claudeRow = screen.getByRole('row', { name: 'Claude CLI version' });
    expect(within(claudeRow).queryByText('No report yet')).not.toBeInTheDocument();
  });
});

// ============================================
// install completion polling
// ============================================

describe('ProviderCliVersionsSection - install completion', () => {
  function clisGetCount(fetchMock: jest.Mock): number {
    return fetchMock.mock.calls.filter(
      (call: [RequestInfo | URL, RequestInit?]) =>
        String(call[0]) === '/api/provider-clis' && (call[1]?.method ?? 'GET') === 'GET',
    ).length;
  }

  function serveOverview(getOverview: () => ProviderClisOverview) {
    return jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/provider-clis' && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve({ ok: true, json: async () => getOverview() });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });
  }

  function installingOverview(): ProviderClisOverview {
    const overview = overviewFixture();
    overview.providers.claude.install = {
      desiredVersion: '2.1.285',
      installedVersion: null,
      state: 'installing',
      error: null,
      checkedAt: null,
    };
    return overview;
  }

  beforeEach(() => {
    mockRemotes = [];
    (Element as unknown as { prototype: { scrollIntoView: unknown } }).prototype.scrollIntoView =
      jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('refreshes the This PC status when the install ends and updates the cards', async () => {
    jest.useFakeTimers();
    let serverOverview = installingOverview();
    const fetchMock = serveOverview(() => serverOverview);
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <ProviderCliVersionsSection />
      </QueryClientProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText(/^Installing/)).toBeInTheDocument();

    // The server finished the install; the next poll picks it up. New objects,
    // not in-place edits: the query cache holds the fetched reference.
    serverOverview = {
      ...serverOverview,
      providers: {
        ...serverOverview.providers,
        claude: {
          ...serverOverview.providers.claude,
          install: {
            desiredVersion: '2.1.285',
            installedVersion: '2.1.285',
            state: 'idle',
            error: null,
            checkedAt: '2026-09-28T10:01:00.000Z',
          },
        },
      },
    };
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.queryByText(/^Installing/)).not.toBeInTheDocument();
    const row = screen.getByRole('row', { name: 'Claude CLI version' });
    expect(within(row).getAllByText('2.1.285').length).toBeGreaterThan(0);

    // Leaving `installing` refreshes the provider cards and preflight.
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      ([arg]) => (arg as { queryKey?: unknown }).queryKey,
    );
    expect(invalidatedKeys).toContainEqual(['providers']);
    expect(invalidatedKeys).toContainEqual(['preflight', 'providers-page']);
  });

  it('stops polling once no provider is installing', async () => {
    jest.useFakeTimers();
    const fetchMock = serveOverview(() => overviewFixture());
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ProviderCliVersionsSection />
      </QueryClientProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);
    });
    const afterLoad = clisGetCount(fetchMock);
    expect(afterLoad).toBe(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(clisGetCount(fetchMock)).toBe(afterLoad);
  });
});
