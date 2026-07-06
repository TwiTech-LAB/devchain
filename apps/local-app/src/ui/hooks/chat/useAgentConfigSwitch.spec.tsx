import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAgentConfigSwitch, type UseAgentConfigSwitchOptions } from './useAgentConfigSwitch';
import type { WorktreeAgentGroup } from '@/ui/hooks/useWorktreeAgents';

const showSuccess = jest.fn();
const showError = jest.fn();
jest.mock('@/ui/lib/toast-helpers', () => ({
  useToastHelpers: () => ({ toast: jest.fn(), showSuccess, showError }),
  getErrorMessage: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}));

jest.mock('@/ui/lib/restart-keys', () => ({
  restartKeyForMain: (agentId: string) => `main:${agentId}`,
  restartKeyForWorktree: (apiBase: string, agentId: string) => `wt:${apiBase}:${agentId}`,
}));

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const okJson = (data: unknown) => ({ ok: true, json: async () => data });

function baseOptions(
  overrides: Partial<UseAgentConfigSwitchOptions> = {},
): UseAgentConfigSwitchOptions {
  return {
    apiFetch: jest.fn().mockResolvedValue(okJson({ id: 'a1' })),
    projectId: 'p1',
    agentPresence: { a1: { online: true } },
    worktreeAgentGroups: [],
    markAgentsForRestart: jest.fn(),
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } });
}

describe('useAgentConfigSwitch — main agents', () => {
  beforeEach(() => jest.clearAllMocks());

  it('switches config for an online agent: PUT, restart mark, invalidate, success toast', async () => {
    const apiFetch = jest.fn().mockResolvedValue(okJson({ id: 'a1' }));
    const markAgentsForRestart = jest.fn();
    const client = makeClient();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(
      () => useAgentConfigSwitch(baseOptions({ apiFetch, markAgentsForRestart })),
      { wrapper: wrapper(client) },
    );

    await act(async () => {
      await result.current.handleSwitchConfig('a1', 'cfg-2');
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/agents/a1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ providerConfigId: 'cfg-2' }),
      }),
    );
    expect(markAgentsForRestart).toHaveBeenCalledWith(['main:a1']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agents', 'p1'] });
    expect(showSuccess).toHaveBeenCalledWith({
      title: 'Config updated',
      description: 'Restart to apply changes.',
    });
  });

  it('offline override update: no restart mark, "Overrides updated" / next-launch copy, includes overrides in body', async () => {
    const apiFetch = jest.fn().mockResolvedValue(okJson({ id: 'a1' }));
    const markAgentsForRestart = jest.fn();
    const client = makeClient();
    const { result } = renderHook(
      () =>
        useAgentConfigSwitch(
          baseOptions({ apiFetch, markAgentsForRestart, agentPresence: { a1: { online: false } } }),
        ),
      { wrapper: wrapper(client) },
    );

    await act(async () => {
      await result.current.handleSwitchConfig('a1', 'cfg-2', 'sonnet', null);
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/agents/a1',
      expect.objectContaining({
        body: JSON.stringify({
          providerConfigId: 'cfg-2',
          modelOverride: 'sonnet',
          effortOverride: null,
        }),
      }),
    );
    expect(markAgentsForRestart).not.toHaveBeenCalled();
    expect(showSuccess).toHaveBeenCalledWith({
      title: 'Overrides updated',
      description: 'Will apply on next launch.',
    });
  });

  it('tracks the pending agent in updatingConfigAgentIds while in flight', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const apiFetch = jest.fn().mockReturnValue(
      new Promise((res) => {
        resolveFetch = res;
      }),
    );
    const client = makeClient();
    const { result } = renderHook(() => useAgentConfigSwitch(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    let pending: Promise<unknown>;
    act(() => {
      pending = result.current.handleSwitchConfig('a1', 'cfg-2');
    });
    await waitFor(() => expect(result.current.updatingConfigAgentIds).toEqual({ a1: true }));

    await act(async () => {
      resolveFetch(okJson({ id: 'a1' }));
      await pending;
    });
    expect(result.current.updatingConfigAgentIds).toEqual({});
  });

  it('surfaces a destructive error toast when the update fails', async () => {
    const apiFetch = jest.fn().mockResolvedValue({ ok: false });
    const client = makeClient();
    const { result } = renderHook(() => useAgentConfigSwitch(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await result.current.handleSwitchConfig('a1', 'cfg-2').catch(() => {});
    });

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith({
        title: 'Failed to update config',
        description: 'Failed to update agent config',
      }),
    );
  });

  it('fetchProviderConfigsForProfile GETs and returns json; throws on !ok', async () => {
    const apiFetch = jest
      .fn()
      .mockResolvedValueOnce(okJson([{ id: 'c1' }]))
      .mockResolvedValueOnce({ ok: false });
    const client = makeClient();
    const { result } = renderHook(() => useAgentConfigSwitch(baseOptions({ apiFetch })), {
      wrapper: wrapper(client),
    });

    await expect(result.current.fetchProviderConfigsForProfile('prof1')).resolves.toEqual([
      { id: 'c1' },
    ]);
    expect(apiFetch).toHaveBeenCalledWith('/api/profiles/prof1/provider-configs');
    await expect(result.current.fetchProviderConfigsForProfile('prof1')).rejects.toThrow(
      'Failed to fetch provider configs',
    );
  });
});

describe('useAgentConfigSwitch — worktree agents', () => {
  const group = {
    apiBase: 'http://wt',
    agentPresence: { a1: { online: true } },
  } as unknown as WorktreeAgentGroup;

  beforeEach(() => jest.clearAllMocks());

  it('switches worktree config via absolute apiBase, marks worktree restart key, invalidates group query', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(okJson({ id: 'a1' }) as unknown as Response);
    const markAgentsForRestart = jest.fn();
    const client = makeClient();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(
      () =>
        useAgentConfigSwitch(baseOptions({ markAgentsForRestart, worktreeAgentGroups: [group] })),
      { wrapper: wrapper(client) },
    );

    await act(async () => {
      await result.current.handleSwitchWorktreeConfig(group, 'a1', 'cfg-2');
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://wt/api/agents/a1',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(markAgentsForRestart).toHaveBeenCalledWith(['wt:http://wt:a1']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chat-worktree-agent-groups'] });
    expect(showSuccess).toHaveBeenCalledWith({
      title: 'Config updated',
      description: 'Restart to apply changes.',
    });
    fetchSpy.mockRestore();
  });
});
