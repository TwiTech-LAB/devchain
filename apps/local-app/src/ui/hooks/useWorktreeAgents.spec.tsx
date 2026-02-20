/** @jest-environment jsdom */

import { act, useEffect } from 'react';
import { waitFor } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWorktreeAgents, type WorktreeAgentGroup } from './useWorktreeAgents';

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

function asRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (typeof URL !== 'undefined' && input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }
  return String(input);
}

describe('useWorktreeAgents', () => {
  const originalFetch = global.fetch;

  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();

    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }

    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
    }

    jest.clearAllMocks();
  });

  interface TrackerState {
    groups: WorktreeAgentGroup[];
    loading: boolean;
  }

  function renderTracker(): TrackerState {
    const state: TrackerState = {
      groups: [],
      loading: true,
    };

    const Tracker = () => {
      const { worktreeAgentGroups, worktreeAgentGroupsLoading } = useWorktreeAgents();
      useEffect(() => {
        state.groups = worktreeAgentGroups;
        state.loading = worktreeAgentGroupsLoading;
      }, [worktreeAgentGroups, worktreeAgentGroupsLoading]);
      return null;
    };

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Tracker />
        </QueryClientProvider>,
      );
    });

    return state;
  }

  it('returns grouped worktree agents and keeps other groups when one fetch fails', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = asRequestUrl(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
        } as Response;
      }

      if (url === '/api/worktrees') {
        return {
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              status: 'running',
              runtimeType: 'process',
              containerPort: 4310,
              devchainProjectId: 'project-auth',
            },
            {
              id: 'wt-2',
              name: 'feature-billing',
              status: 'running',
              runtimeType: 'container',
              containerPort: 4311,
              devchainProjectId: 'project-billing',
            },
            {
              id: 'wt-3',
              name: 'stopped-fix',
              status: 'stopped',
              containerPort: null,
              devchainProjectId: 'project-stopped',
            },
          ],
        } as Response;
      }

      if (
        url === '/wt/feature-auth/api/agents?projectId=project-auth&includeGuests=true' ||
        url === '/wt/feature-auth/api/agents?projectId=project-auth&includeGuests=true'
      ) {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'agent-auth', name: 'Auth Agent', type: 'agent', profileId: 'p-auth' }],
          }),
        } as Response;
      }

      if (url === '/wt/feature-auth/api/sessions/agents/presence?projectId=project-auth') {
        return {
          ok: true,
          json: async () => ({ 'agent-auth': { online: true, sessionId: 'session-auth' } }),
        } as Response;
      }

      if (url === '/wt/feature-billing/api/agents?projectId=project-billing&includeGuests=true') {
        return {
          ok: false,
          status: 500,
          json: async () => ({ message: 'boom' }),
        } as Response;
      }

      if (url === '/wt/feature-billing/api/sessions/agents/presence?projectId=project-billing') {
        return {
          ok: true,
          json: async () => ({ 'agent-billing': { online: false } }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const state = renderTracker();
    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.loading).toBe(false);
      expect(state.groups.length).toBe(3);
    });

    const authGroup = state.groups.find((group) => group.name === 'feature-auth');
    expect(authGroup).toBeTruthy();
    expect(authGroup?.disabled).toBe(false);
    expect(authGroup?.runtimeType).toBe('process');
    expect(authGroup?.agents.map((agent) => agent.name)).toEqual(['Auth Agent']);
    expect(authGroup?.agentPresence['agent-auth']?.online).toBe(true);

    const billingGroup = state.groups.find((group) => group.name === 'feature-billing');
    expect(billingGroup).toBeTruthy();
    expect(billingGroup?.disabled).toBe(true);
    expect(billingGroup?.runtimeType).toBe('container');
    expect(billingGroup?.error).toMatch(/failed to load agents/i);

    const stoppedGroup = state.groups.find((group) => group.name === 'stopped-fix');
    expect(stoppedGroup).toBeTruthy();
    expect(stoppedGroup?.disabled).toBe(true);
    expect(stoppedGroup?.runtimeType).toBe('container');
    expect(stoppedGroup?.agents).toEqual([]);
  });

  it('skips worktree fan-out outside main mode', async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = asRequestUrl(input);
      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'normal', version: '1.0.0' }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const state = renderTracker();
    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.groups).toEqual([]);
      expect(state.loading).toBe(false);
    });

    const worktreeCalls = fetchMock.mock.calls.filter(
      (call) => asRequestUrl(call[0] as RequestInfo | URL) === '/api/worktrees',
    );
    expect(worktreeCalls.length).toBe(0);
  });
});
