import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
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
    agents: (pid: string) => ['agents', pid],
    agentPresence: (pid: string) => ['agent-presence', pid],
    activeSessions: (pid: string) => ['active-sessions', pid],
  },
}));

jest.mock('@/ui/lib/teams', () => ({
  teamsQueryKeys: { teams: (pid: string) => ['teams', pid] },
}));

const terminateSession = jest.fn();
jest.mock('@/ui/lib/sessions', () => ({
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agents', 'p1'] });
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
    const { result } = renderHook(
      () => useAgentAdminActions(baseOptions({ apiFetch, activeSessions: [runningSession] })),
      { wrapper: wrapper(client) },
    );

    act(() => result.current.setPendingDeleteAgent(agentA));
    await act(async () => {
      result.current.handleConfirmDelete();
    });

    await waitFor(() => expect(result.current.pendingDeleteAgent).toBeNull());
    expect(terminateSession).toHaveBeenCalledWith('s1', '', apiFetch);
    expect(apiFetch).toHaveBeenCalledWith('/api/agents/a1', { method: 'DELETE' });
    expect(toast).toHaveBeenCalledWith({ title: 'Agent deleted' });
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
