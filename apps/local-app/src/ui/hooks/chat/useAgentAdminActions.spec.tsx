import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { agentQueryKeys } from '@/ui/lib/agents';
import { useAgentAdminActions, type UseAgentAdminActionsOptions } from './useAgentAdminActions';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';
import type { ActiveSession } from '@/ui/lib/sessions';

const toast = jest.fn();
const showError = jest.fn();
jest.mock('@/ui/lib/toast-helpers', () => ({
  useToastHelpers: () => ({ toast, showError }),
  getErrorMessage: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}));

jest.mock('@/ui/hooks/useChatQueries', () => ({
  chatQueryKeys: {
    agentPresence: (pid: string) => ['agent-presence', pid],
    activeSessions: (pid: string) => ['active-sessions', pid],
  },
}));

jest.mock('@/ui/lib/teams', () => ({
  teamsQueryKeys: { teams: (pid: string) => ['teams', pid] },
}));

const terminateSession = jest.fn();
jest.mock('@/ui/lib/sessions', () => ({
  agentSessionTreeKeyPrefix: ['agentSessionTree'],
  terminateSession: (...args: unknown[]) => terminateSession(...args),
}));

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function makeClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } });
}

const okJson = (data: unknown) => ({ ok: true, json: async () => data });

const agentA = { id: 'a1', name: 'Coder', profileId: 'prof1' } as unknown as AgentOrGuest;

function baseOptions(
  overrides: Partial<UseAgentAdminActionsOptions> = {},
): UseAgentAdminActionsOptions {
  return {
    apiFetch: jest.fn().mockResolvedValue(okJson({ id: 'new', name: 'Coder (1)' })),
    projectId: 'p1',
    agents: [{ id: 'a1', name: 'Coder' } as unknown as AgentOrGuest],
    activeSessions: [],
    ...overrides,
  };
}

describe('useAgentAdminActions — clone', () => {
  beforeEach(() => jest.clearAllMocks());

  it('derives the next free clone name and the team target', () => {
    const client = makeClient();
    const { result } = renderHook(
      () =>
        useAgentAdminActions(
          baseOptions({
            agents: [
              { id: 'a1', name: 'Coder' } as unknown as AgentOrGuest,
              { id: 'a2', name: 'Coder (1)' } as unknown as AgentOrGuest,
            ],
          }),
        ),
      { wrapper: wrapper(client) },
    );

    act(() =>
      result.current.setPendingCloneAgent({
        agent: agentA,
        teamId: 't1',
        teamName: 'Core',
      }),
    );
    // "Coder (1)" is taken, so the next candidate is "Coder (2)".
    expect(result.current.pendingCloneName).toBe('Coder (2)');
    expect(result.current.cloneTargetTeam).toEqual({ teamId: 't1', teamName: 'Core' });
  });

  it('team-lead clone has no team target', () => {
    const client = makeClient();
    const { result } = renderHook(() => useAgentAdminActions(baseOptions()), {
      wrapper: wrapper(client),
    });
    act(() =>
      result.current.setPendingCloneAgent({
        agent: agentA,
        teamId: 't1',
        teamName: 'Core',
        isTeamLead: true,
      }),
    );
    expect(result.current.cloneTargetTeam).toBeNull();
  });

  it('confirm clone POSTs, toasts team success, invalidates, and clears the dialog', async () => {
    const apiFetch = jest
      .fn()
      // POST /api/agents
      .mockResolvedValueOnce(okJson({ id: 'new', name: 'Coder (1)' }))
      // GET team detail
      .mockResolvedValueOnce(okJson({ members: [{ agentId: 'a1' }] }))
      // PUT team members
      .mockResolvedValueOnce(okJson({}));
    const client = makeClient();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useAgentAdminActions(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    act(() =>
      result.current.setPendingCloneAgent({ agent: agentA, teamId: 't1', teamName: 'Core' }),
    );
    await act(async () => {
      result.current.handleConfirmClone();
    });

    await waitFor(() => expect(result.current.pendingCloneAgent).toBeNull());
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/agents',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(toast).toHaveBeenCalledWith({ title: 'Cloned Coder into Core' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentQueryKeys.project('p1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['teams', 'detail'] });
  });

  it('warns when the clone succeeds but team-add fails', async () => {
    const apiFetch = jest
      .fn()
      .mockResolvedValueOnce(okJson({ id: 'new', name: 'Coder (1)' }))
      .mockResolvedValueOnce({ ok: false }); // team detail fetch fails
    const client = makeClient();
    const { result } = renderHook(() => useAgentAdminActions(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    act(() =>
      result.current.setPendingCloneAgent({ agent: agentA, teamId: 't1', teamName: 'Core' }),
    );
    await act(async () => {
      result.current.handleConfirmClone();
    });

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        title: 'Cloned Coder (1)',
        description: "Couldn't add it to Core. Add it manually via Teams page.",
        variant: 'destructive',
      }),
    );
  });

  it('surfaces a destructive error toast when clone POST fails', async () => {
    const apiFetch = jest
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({ message: 'boom' }) });
    const client = makeClient();
    const { result } = renderHook(() => useAgentAdminActions(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    act(() => result.current.setPendingCloneAgent({ agent: agentA }));
    await act(async () => {
      result.current.handleConfirmClone();
    });

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith({
        title: 'Failed to clone agent',
        description: 'boom',
      }),
    );
  });
});

describe('useAgentAdminActions — delete', () => {
  const runningSession = {
    id: 's1',
    agentId: 'a1',
    status: 'running',
  } as unknown as ActiveSession;

  beforeEach(() => jest.clearAllMocks());

  it('reports an active session for the pending delete target', () => {
    const client = makeClient();
    const { result } = renderHook(
      () => useAgentAdminActions(baseOptions({ activeSessions: [runningSession] })),
      { wrapper: wrapper(client) },
    );
    expect(result.current.pendingDeleteHasSession).toBe(false);
    act(() => result.current.setPendingDeleteAgent(agentA));
    expect(result.current.pendingDeleteHasSession).toBe(true);
  });

  it('terminates running sessions then DELETEs, toasts, and clears the dialog', async () => {
    terminateSession.mockResolvedValue(undefined);
    const apiFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const client = makeClient();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(
      () => useAgentAdminActions(baseOptions({ apiFetch, activeSessions: [runningSession] })),
      { wrapper: wrapper(client) },
    );

    act(() => result.current.setPendingDeleteAgent(agentA));
    await act(async () => {
      result.current.handleConfirmDelete();
    });

    await waitFor(() => expect(result.current.pendingDeleteAgent).toBeNull());
    expect(terminateSession).toHaveBeenCalledWith('s1', apiFetch, { expectedAgentId: 'a1' });
    expect(apiFetch).toHaveBeenCalledWith('/api/agents/a1', { method: 'DELETE' });
    expect(toast).toHaveBeenCalledWith({ title: 'Agent deleted' });
    // Family session trees: the deleted agent's sessions move to a family member.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agentSessionTree'] });
  });

  it('maps a 409 delete conflict to the running-agent message', async () => {
    const apiFetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 409, json: async () => ({}) });
    const client = makeClient();
    const { result } = renderHook(() => useAgentAdminActions(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    act(() => result.current.setPendingDeleteAgent(agentA));
    await act(async () => {
      result.current.handleConfirmDelete();
    });

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith({
        title: 'Failed to delete agent',
        description: "Can't delete — agent is currently running. Try again in a moment.",
      }),
    );
  });
});

describe('useAgentAdminActions — quick-add', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts a team agent and toasts success', async () => {
    const apiFetch = jest.fn().mockResolvedValue(okJson({ name: 'Helper' }));
    const client = makeClient();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useAgentAdminActions(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      result.current.handleAddTeamAgent({
        teamId: 't1',
        teamName: 'Core',
        providerConfigId: 'cfg1',
        computedName: 'Helper',
      } as never);
    });

    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Added Helper to Core' }));
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/teams/t1/agents',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['teams', 'p1'] });
  });
});

describe('useAgentAdminActions — disable / enable', () => {
  beforeEach(() => jest.clearAllMocks());

  const running = [{ id: 's1', agentId: 'a1', status: 'running' }] as unknown as ActiveSession[];

  afterEach(() => onlineManager.setOnline(true));

  /** Both latest requests succeeded and show the agent offline. */
  function seedOffline(client: QueryClient) {
    client.setQueryData(['active-sessions', 'p1'], []);
    client.setQueryData(['agent-presence', 'p1'], {});
  }

  /** A client whose latest session-list and presence requests succeeded with these answers. */
  function clientWith(sessions: ActiveSession[] = [], presence: Record<string, unknown> = {}) {
    const client = makeClient();
    client.setQueryData(['active-sessions', 'p1'], sessions);
    client.setQueryData(['agent-presence', 'p1'], presence);
    return client;
  }

  it('disables an agent that is known to be offline at once with no dialog', async () => {
    const apiFetch = jest.fn().mockResolvedValue(okJson({}));
    const client = clientWith();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useAgentAdminActions(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    act(() => result.current.requestDisableAgent(agentA));

    expect(result.current.pendingDisableAgent).toBeNull();
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/agents/a1/disable', { method: 'POST' }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['teams', 'p1'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['teams', 'detail'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agent-presence', 'p1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentQueryKeys.project('p1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agentSessionTree'] });
  });

  it('asks first when the agent has a running session, then disables on confirm', async () => {
    const apiFetch = jest.fn().mockResolvedValue(okJson({}));
    const { result } = renderHook(() => useAgentAdminActions(baseOptions({ apiFetch })), {
      wrapper: wrapper(clientWith(running, { a1: { online: true } })),
    });

    act(() => result.current.requestDisableAgent(agentA));
    expect(result.current.pendingDisableAgent).toBe(agentA);
    expect(apiFetch).not.toHaveBeenCalled();

    act(() => result.current.handleConfirmDisable());
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/agents/a1/disable', { method: 'POST' }),
    );
    await waitFor(() => expect(result.current.pendingDisableAgent).toBeNull());
  });

  it.each([
    {
      state: 'the session list failed and presence shows the agent online',
      seed: (client: QueryClient) => {
        client.setQueryData(['agent-presence', 'p1'], { a1: { online: true } });
        client
          .getQueryCache()
          .build(client, { queryKey: ['active-sessions', 'p1'] })
          .setState({ status: 'error', error: new Error('503'), data: [] });
      },
    },
    {
      state: 'the session list is empty but presence shows the agent online',
      seed: (client: QueryClient) => {
        client.setQueryData(['active-sessions', 'p1'], []);
        client.setQueryData(['agent-presence', 'p1'], { a1: { online: true } });
      },
    },
    {
      state: 'presence failed',
      seed: (client: QueryClient) => {
        client.setQueryData(['active-sessions', 'p1'], []);
        client
          .getQueryCache()
          .build(client, { queryKey: ['agent-presence', 'p1'] })
          .setState({ status: 'error', error: new Error('503'), data: {} });
      },
    },
    { state: 'no answer arrived yet', seed: () => {} },
    ...(['active-sessions', 'agent-presence'] as const).flatMap((key) => [
      {
        state: `a refresh of ${key} is in flight after an offline answer`,
        seed: (client: QueryClient) => {
          seedOffline(client);
          client
            .getQueryCache()
            .find({ queryKey: [key, 'p1'] })!
            .setState({ fetchStatus: 'fetching' });
        },
      },
      {
        state: `the offline answer of ${key} is invalidated`,
        seed: (client: QueryClient) => {
          seedOffline(client);
          void client.invalidateQueries({ queryKey: [key, 'p1'] });
        },
      },
    ]),
    {
      state: 'the browser is disconnected after an offline answer',
      seed: (client: QueryClient) => {
        seedOffline(client);
        onlineManager.setOnline(false);
      },
    },
  ])('asks first when $state', ({ seed }) => {
    const apiFetch = jest.fn().mockResolvedValue(okJson({}));
    const client = makeClient();
    seed(client);
    const { result } = renderHook(() => useAgentAdminActions(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    act(() => result.current.requestDisableAgent(agentA));

    expect(result.current.pendingDisableAgent).toBe(agentA);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('enables without a dialog', async () => {
    const apiFetch = jest.fn().mockResolvedValue(okJson({}));
    const { result } = renderHook(
      () => useAgentAdminActions(baseOptions({ apiFetch, activeSessions: running })),
      { wrapper: wrapper(makeClient()) },
    );

    act(() => result.current.enableAgent(agentA));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/api/agents/a1/enable', { method: 'POST' }),
    );
    expect(result.current.pendingDisableAgent).toBeNull();
  });

  it('shows the server message when Disable fails and does not refresh the roster', async () => {
    const apiFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'Agent leads a team' }),
    });
    const client = clientWith();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useAgentAdminActions(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    act(() => result.current.requestDisableAgent(agentA));

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith({
        title: 'Failed to disable agent',
        description: 'Agent leads a team',
      }),
    );
    expect(invalidate).not.toHaveBeenCalled();
  });
});
