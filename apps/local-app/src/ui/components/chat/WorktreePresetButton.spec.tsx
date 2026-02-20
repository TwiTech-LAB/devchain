import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorktreePresetButton } from './WorktreePresetButton';
import type { WorktreeAgentGroup } from '@/ui/hooks/useWorktreeAgents';

// ResizeObserver mock for Radix components
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
  return {
    queryClient,
    ...render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>),
  };
}

function makeGroup(overrides?: Partial<WorktreeAgentGroup>): WorktreeAgentGroup {
  return {
    id: 'wt-1',
    name: 'feature-auth',
    status: 'running',
    runtimeType: 'container',
    devchainProjectId: 'proj-1',
    apiBase: '/wt/feature-auth',
    agents: [
      {
        id: 'agent-1',
        name: 'Coder',
        profileId: 'profile-1',
        providerConfigId: 'config-old',
        providerConfig: { id: 'config-old', name: 'claude-config', providerId: 'p1' },
      },
      {
        id: 'agent-2',
        name: 'Reviewer',
        profileId: 'profile-1',
        providerConfigId: 'config-old-2',
        providerConfig: { id: 'config-old-2', name: 'gemini-config', providerId: 'p2' },
      },
    ],
    agentPresence: {
      'agent-1': { online: true, sessionId: 'sess-1', startedAt: '2026-01-01T00:00:00.000Z' },
      'agent-2': { online: false, sessionId: null, startedAt: null },
    },
    disabled: false,
    error: null,
    ...overrides,
  };
}

const presetsPayload = {
  presets: [
    {
      name: 'Tier-A',
      description: 'All opus',
      agentConfigs: [
        { agentName: 'Coder', providerConfigName: 'claude-config' },
        { agentName: 'Reviewer', providerConfigName: 'gemini-config' },
      ],
    },
  ],
  activePreset: null,
};

const providerConfigsPayload = [
  { id: 'config-1', name: 'claude-config', profileId: 'profile-1', providerId: 'p1' },
  { id: 'config-2', name: 'gemini-config', profileId: 'profile-1', providerId: 'p2' },
];

const applySuccessPayload = {
  applied: 2,
  warnings: [],
  agents: [
    { id: 'agent-1', name: 'Coder', providerConfigId: 'config-new' },
    { id: 'agent-2', name: 'Reviewer', providerConfigId: 'config-new-2' },
  ],
};

/** Set up global.fetch to route by URL pattern. */
function setupFetchRouter(overrides?: { applyResponse?: { ok: boolean; json?: unknown } }) {
  const fetchMock = jest.fn().mockImplementation((url: string) => {
    if (url.includes('/presets/apply')) {
      const resp = overrides?.applyResponse ?? { ok: true, json: applySuccessPayload };
      return Promise.resolve({
        ok: resp.ok,
        json: () => Promise.resolve(resp.json ?? applySuccessPayload),
      });
    }
    if (url.includes('/presets')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(presetsPayload),
      });
    }
    if (url.includes('/provider-configs')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(providerConfigsPayload),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('WorktreePresetButton', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = setupFetchRouter();
    mockToast.mockClear();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('renders trigger button even before presets are fetched (alwaysShowTrigger)', () => {
    renderWithQueryClient(
      <WorktreePresetButton group={makeGroup()} onMarkForRestart={jest.fn()} />,
    );
    expect(screen.getByLabelText('Select preset')).toBeInTheDocument();
  });

  it('disables trigger when group is disabled', () => {
    renderWithQueryClient(
      <WorktreePresetButton group={makeGroup({ disabled: true })} onMarkForRestart={jest.fn()} />,
    );
    expect(screen.getByLabelText('Select preset')).toBeDisabled();
  });

  it('disables trigger when group has no devchainProjectId', () => {
    renderWithQueryClient(
      <WorktreePresetButton
        group={makeGroup({ devchainProjectId: null })}
        onMarkForRestart={jest.fn()}
      />,
    );
    expect(screen.getByLabelText('Select preset')).toBeDisabled();
  });

  it('does not fetch presets until popover is opened (lazy)', async () => {
    renderWithQueryClient(
      <WorktreePresetButton group={makeGroup()} onMarkForRestart={jest.fn()} />,
    );

    // Before opening, no fetch calls
    expect(fetchMock).not.toHaveBeenCalled();

    // Open the popover
    fireEvent.click(screen.getByLabelText('Select preset'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });

  it('fetches presets from correct apiBase-scoped endpoint', async () => {
    const group = makeGroup({ apiBase: '/wt/my-worktree', devchainProjectId: 'proj-42' });

    renderWithQueryClient(<WorktreePresetButton group={group} onMarkForRestart={jest.fn()} />);

    fireEvent.click(screen.getByLabelText('Select preset'));

    await waitFor(() => {
      const presetCalls = fetchMock.mock.calls.filter(
        (c: string[]) =>
          typeof c[0] === 'string' && c[0].includes('/presets') && !c[0].includes('/apply'),
      );
      expect(presetCalls.length).toBeGreaterThan(0);
      expect(presetCalls[0][0]).toBe('/wt/my-worktree/api/projects/proj-42/presets');
    });
  });

  it('uses apiBase-scoped query keys so different worktrees do not share cache', async () => {
    const group1 = makeGroup({ apiBase: '/wt/wt-a', devchainProjectId: 'proj-a' });

    const queryClient = createTestQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <WorktreePresetButton group={group1} onMarkForRestart={jest.fn()} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByLabelText('Select preset'));
    await waitFor(() => expect(screen.getByText('Tier-A')).toBeInTheDocument());

    // Verify cache entries contain apiBase
    const cacheKeys = queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey);
    expect(cacheKeys.some((k) => JSON.stringify(k).includes('/wt/wt-a'))).toBe(true);
    expect(cacheKeys.some((k) => JSON.stringify(k).includes('/wt/wt-b'))).toBe(false);
  });

  it('calls apply endpoint on correct worktree proxy path', async () => {
    const group = makeGroup();
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithQueryClient(<WorktreePresetButton group={group} onMarkForRestart={jest.fn()} />);

    fireEvent.click(screen.getByLabelText('Select preset'));
    await waitFor(() => expect(screen.getByText('Tier-A')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByText('Tier-A'));
    });

    await waitFor(() => {
      const applyCalls = fetchMock.mock.calls.filter(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('/presets/apply'),
      );
      expect(applyCalls).toHaveLength(1);
      expect(applyCalls[0][0]).toBe('/wt/feature-auth/api/projects/proj-1/presets/apply');
      expect(JSON.parse(applyCalls[0][1].body)).toEqual({ presetName: 'Tier-A' });
    });

    jest.spyOn(window, 'confirm').mockRestore();
  });

  it('marks only online affected agents for restart with composite key on apply success', async () => {
    const group = makeGroup();
    const onMarkForRestart = jest.fn();
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithQueryClient(
      <WorktreePresetButton group={group} onMarkForRestart={onMarkForRestart} />,
    );

    fireEvent.click(screen.getByLabelText('Select preset'));
    await waitFor(() => expect(screen.getByText('Tier-A')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByText('Tier-A'));
    });

    await waitFor(() => {
      expect(onMarkForRestart).toHaveBeenCalledWith(['/wt/feature-auth:agent-1']);
    });

    // agent-2 is offline — should NOT be in the restart list
    const callArgs = onMarkForRestart.mock.calls[0][0] as string[];
    expect(callArgs).not.toContain('/wt/feature-auth:agent-2');

    jest.spyOn(window, 'confirm').mockRestore();
  });

  it('invalidates worktree agent groups on successful apply', async () => {
    const group = makeGroup();
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    const { queryClient } = renderWithQueryClient(
      <WorktreePresetButton group={group} onMarkForRestart={jest.fn()} />,
    );

    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    fireEvent.click(screen.getByLabelText('Select preset'));
    await waitFor(() => expect(screen.getByText('Tier-A')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByText('Tier-A'));
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ['chat-worktree-agent-groups'] }),
      );
    });

    jest.spyOn(window, 'confirm').mockRestore();
  });

  it('shows error toast when apply fails', async () => {
    fetchMock = setupFetchRouter({ applyResponse: { ok: false } });
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    renderWithQueryClient(
      <WorktreePresetButton group={makeGroup()} onMarkForRestart={jest.fn()} />,
    );

    fireEvent.click(screen.getByLabelText('Select preset'));
    await waitFor(() => expect(screen.getByText('Tier-A')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByText('Tier-A'));
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Failed to apply preset',
          variant: 'destructive',
        }),
      );
    });

    jest.spyOn(window, 'confirm').mockRestore();
  });

  it('shows confirmation dialog when agents have active sessions', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);

    renderWithQueryClient(
      <WorktreePresetButton group={makeGroup()} onMarkForRestart={jest.fn()} />,
    );

    fireEvent.click(screen.getByLabelText('Select preset'));
    await waitFor(() => expect(screen.getByText('Tier-A')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Tier-A'));

    expect(confirmSpy).toHaveBeenCalled();
    // Should NOT have called apply since user declined
    const applyCalls = fetchMock.mock.calls.filter(
      (c: string[]) => typeof c[0] === 'string' && c[0].includes('/presets/apply'),
    );
    expect(applyCalls).toHaveLength(0);

    confirmSpy.mockRestore();
  });

  it('skips confirmation when no agents have active sessions', async () => {
    const group = makeGroup({
      agentPresence: {
        'agent-1': { online: false, sessionId: null, startedAt: null },
        'agent-2': { online: false, sessionId: null, startedAt: null },
      },
    });
    const confirmSpy = jest.spyOn(window, 'confirm');

    renderWithQueryClient(<WorktreePresetButton group={group} onMarkForRestart={jest.fn()} />);

    fireEvent.click(screen.getByLabelText('Select preset'));
    await waitFor(() => expect(screen.getByText('Tier-A')).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByText('Tier-A'));
    });

    // No confirmation dialog shown (no active sessions)
    expect(confirmSpy).not.toHaveBeenCalled();

    // But apply should have been called
    await waitFor(() => {
      const applyCalls = fetchMock.mock.calls.filter(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('/presets/apply'),
      );
      expect(applyCalls).toHaveLength(1);
    });

    confirmSpy.mockRestore();
  });
});
