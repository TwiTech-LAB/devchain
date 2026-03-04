/** @jest-environment jsdom */

import { act, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { createRoot, type Root } from 'react-dom/client';
import type { Socket } from 'socket.io-client';
import { WorktreeTabProvider, useWorktreeTab, type ActiveWorktreeTab } from './useWorktreeTab';
import {
  PROJECT_STORAGE_KEY,
  ProjectSelectionProvider,
  useSelectedProject,
} from './useProjectSelection';
import { getAppSocket, releaseAppSocket } from '@/ui/lib/socket';

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn(),
  releaseAppSocket: jest.fn(),
}));

const getAppSocketMock = getAppSocket as jest.MockedFunction<typeof getAppSocket>;
const releaseAppSocketMock = releaseAppSocket as jest.MockedFunction<typeof releaseAppSocket>;

interface MockSocket {
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  connected: boolean;
  _listeners: Map<string, Set<(...args: unknown[]) => void>>;
}

function createMockSocket(): MockSocket {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    connected: true,
    emit: jest.fn(),
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    _listeners: listeners,
  };
}

function simulateMessage(
  socket: MockSocket,
  envelope: { topic: string; type: string; payload?: unknown; ts?: string },
) {
  const handlers = socket._listeners.get('message');
  if (handlers) {
    for (const handler of handlers) {
      handler({ ts: new Date().toISOString(), payload: {}, ...envelope });
    }
  }
}

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

describe('WorktreeTabProvider', () => {
  const originalFetch = global.fetch;

  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const defaultSocket = createMockSocket();
    getAppSocketMock.mockReturnValue(defaultSocket as unknown as Socket);
    window.history.replaceState({}, '', '/board');
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });

    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
    queryClient.clear();

    if (originalFetch) {
      global.fetch = originalFetch;
      window.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
      delete (window as unknown as { fetch?: unknown }).fetch;
    }

    jest.clearAllMocks();
  });

  interface TrackerState {
    activeWorktree: ActiveWorktreeTab | null;
    apiBase: string;
    worktrees: ActiveWorktreeTab[];
    worktreesLoading: boolean;
    runtimeResolved: boolean;
    setActiveWorktree: (worktree: ActiveWorktreeTab | null) => void;
  }

  function renderTracker(): TrackerState {
    const state: TrackerState = {
      activeWorktree: null,
      apiBase: '',
      worktrees: [],
      worktreesLoading: false,
      runtimeResolved: false,
      setActiveWorktree: () => undefined,
    };

    const Tracker = () => {
      const context = useWorktreeTab();
      useEffect(() => {
        state.activeWorktree = context.activeWorktree;
        state.apiBase = context.apiBase;
        state.worktrees = context.worktrees;
        state.worktreesLoading = context.worktreesLoading;
        state.runtimeResolved = context.runtimeResolved;
        state.setActiveWorktree = context.setActiveWorktree;
      }, [context]);
      return null;
    };

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorktreeTabProvider>
            <Tracker />
          </WorktreeTabProvider>
        </QueryClientProvider>,
      );
    });

    return state;
  }

  function setupFetchMock(mode: 'main' | 'normal') {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = asRequestUrl(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode, version: '1.0.0' }),
        } as Response;
      }

      if (url === '/api/worktrees') {
        return {
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              devchainProjectId: 'project-1',
            },
            {
              id: 'wt-2',
              name: 'feature-billing',
              devchainProjectId: 'project-2',
            },
          ],
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
    window.fetch = fetchMock as unknown as typeof fetch;

    return fetchMock;
  }

  it('hydrates active worktree from ?wt URL and exposes apiBase', async () => {
    window.history.replaceState({}, '', '/board?wt=feature-auth');
    setupFetchMock('main');
    const state = renderTracker();

    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.activeWorktree?.name).toBe('feature-auth');
      expect(state.apiBase).toBe('/wt/feature-auth');
    });
  });

  it('exposes runtimeResolved transition from false to true after runtime detection resolves', async () => {
    let resolveRuntime: ((response: Response) => void) | null = null;
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = asRequestUrl(input);
      if (url === '/api/runtime') {
        return new Promise<Response>((resolve) => {
          resolveRuntime = resolve;
        });
      }
      if (url === '/api/worktrees') {
        return Promise.resolve({
          ok: true,
          json: async () => [],
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    window.fetch = fetchMock as unknown as typeof fetch;

    const state = renderTracker();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/runtime', expect.any(Object));
    });
    expect(state.runtimeResolved).toBe(false);

    act(() => {
      resolveRuntime?.({
        ok: true,
        json: async () => ({ mode: 'main', version: '1.0.0' }),
      } as Response);
    });
    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.runtimeResolved).toBe(true);
    });
  });

  it('suppresses project-scoped fetches until runtime resolves on initial ?wt load with stale storage', async () => {
    window.history.replaceState({}, '', '/chat?wt=feature-auth');
    window.sessionStorage.setItem(PROJECT_STORAGE_KEY, 'project-stale-container');
    window.localStorage.setItem(PROJECT_STORAGE_KEY, 'project-stale-container');

    let resolveRuntime: ((response: Response) => void) | null = null;
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = asRequestUrl(input);
      if (url === '/api/runtime') {
        return new Promise<Response>((resolve) => {
          resolveRuntime = resolve;
        });
      }
      if (url === '/api/worktrees') {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              id: 'wt-1',
              name: 'feature-auth',
              ownerProjectId: 'project-main-1',
              devchainProjectId: 'project-wt-1',
              status: 'running',
            },
          ],
        } as Response);
      }
      if (url === '/wt/feature-auth/api/projects') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'project-wt-1',
                name: 'Worktree Project',
                description: null,
                rootPath: '/tmp/wt',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
              },
            ],
            total: 1,
          }),
        } as Response);
      }
      if (url.startsWith('/wt/feature-auth/api/projects/') && url.endsWith('/stats')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ epicsCount: 0, agentsCount: 0 }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      } as Response);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    window.fetch = fetchMock as unknown as typeof fetch;

    const state = {
      runtimeResolved: false,
      selectedProjectId: undefined as string | undefined,
      selectedProject: undefined as string | undefined,
      activeWorktreeName: null as string | null,
      projectsLoading: false,
    };

    const Tracker = () => {
      const worktree = useWorktreeTab();
      const projectSelection = useSelectedProject();
      useEffect(() => {
        state.runtimeResolved = worktree.runtimeResolved;
        state.activeWorktreeName = worktree.activeWorktree?.name ?? null;
        state.selectedProjectId = projectSelection.selectedProjectId;
        state.selectedProject = projectSelection.selectedProject?.id;
        state.projectsLoading = projectSelection.projectsLoading;
      }, [worktree, projectSelection]);
      return null;
    };

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <WorktreeTabProvider>
            <ProjectSelectionProvider>
              <Tracker />
            </ProjectSelectionProvider>
          </WorktreeTabProvider>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/runtime', expect.any(Object));
    });

    const urlsBeforeResolve = fetchMock.mock.calls.map((call) =>
      asRequestUrl(call[0] as RequestInfo),
    );
    expect(
      urlsBeforeResolve.some((url) => url === '/api/projects' || url.startsWith('/api/projects/')),
    ).toBe(false);
    expect(state.runtimeResolved).toBe(false);
    expect(state.projectsLoading).toBe(true);
    expect(state.selectedProjectId).toBeUndefined();
    expect(state.selectedProject).toBeUndefined();

    act(() => {
      resolveRuntime?.({
        ok: true,
        json: async () => ({ mode: 'main', version: '1.0.0' }),
      } as Response);
    });
    await act(async () => await flushPromises());

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => asRequestUrl(call[0] as RequestInfo));
      expect(urls).toContain('/wt/feature-auth/api/projects');
      expect(urls.some((url) => url === '/api/projects')).toBe(false);
      expect(state.runtimeResolved).toBe(true);
      expect(state.activeWorktreeName).toBe('feature-auth');
      expect(state.selectedProjectId).toBe('project-wt-1');
      expect(state.selectedProject).toBe('project-wt-1');
    });
  });

  it('updates URL search params when active worktree changes', async () => {
    setupFetchMock('main');
    const state = renderTracker();

    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.worktrees.length).toBe(2);
      expect(state.apiBase).toBe('');
      expect(window.location.search).toBe('');
    });

    await act(async () => {
      state.setActiveWorktree(state.worktrees[0]);
      await flushPromises();
    });

    expect(state.activeWorktree?.name).toBe('feature-auth');
    expect(state.apiBase).toBe('/wt/feature-auth');
    expect(window.location.search).toBe('?wt=feature-auth');

    await act(async () => {
      state.setActiveWorktree(null);
      await flushPromises();
    });

    expect(state.activeWorktree).toBeNull();
    expect(state.apiBase).toBe('');
    expect(window.location.search).toBe('');
  });

  it('resets non-core query cache on worktree tab switches', async () => {
    setupFetchMock('main');
    const removeQueriesSpy = jest.spyOn(queryClient, 'removeQueries');
    const cancelQueriesSpy = jest.spyOn(queryClient, 'cancelQueries');
    const invalidateQueriesSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const state = renderTracker();

    await act(async () => await flushPromises());
    await waitFor(() => {
      expect(state.worktrees.length).toBe(2);
    });
    expect(removeQueriesSpy).not.toHaveBeenCalled();

    await act(async () => {
      state.setActiveWorktree(state.worktrees[0]);
      await flushPromises();
    });
    await waitFor(() => {
      expect(removeQueriesSpy).toHaveBeenCalledTimes(1);
    });
    const firstCallArg = removeQueriesSpy.mock.calls[0]?.[0] as
      | { predicate?: (query: { queryKey: unknown[] }) => boolean }
      | undefined;
    const predicate = firstCallArg?.predicate;
    expect(predicate).toBeDefined();
    expect(predicate?.({ queryKey: ['worktree-tabs-worktrees'] })).toBe(false);
    expect(predicate?.({ queryKey: ['projects'] })).toBe(false);
    expect(predicate?.({ queryKey: ['providers'] })).toBe(false);
    expect(predicate?.({ queryKey: ['epics', 'project-1'] })).toBe(true);

    // Verify cancel→invalidate sequence for projects
    expect(cancelQueriesSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });

    await act(async () => {
      state.setActiveWorktree(state.worktrees[1]);
      await flushPromises();
    });
    await waitFor(() => {
      expect(removeQueriesSpy).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      state.setActiveWorktree(null);
      await flushPromises();
    });
    await waitFor(() => {
      expect(removeQueriesSpy).toHaveBeenCalledTimes(3);
    });

    removeQueriesSpy.mockRestore();
    cancelQueriesSpy.mockRestore();
    invalidateQueriesSpy.mockRestore();
  });

  it('fires cancel→invalidate for projects on worktree→main transition', async () => {
    window.history.replaceState({}, '', '/board?wt=feature-auth');
    setupFetchMock('main');
    const cancelQueriesSpy = jest.spyOn(queryClient, 'cancelQueries');
    const invalidateQueriesSpy = jest.spyOn(queryClient, 'invalidateQueries');

    try {
      const state = renderTracker();
      await act(async () => await flushPromises());

      await waitFor(() => {
        expect(state.activeWorktree?.name).toBe('feature-auth');
      });

      // Clear spies from initial worktree load
      cancelQueriesSpy.mockClear();
      invalidateQueriesSpy.mockClear();

      // Switch back to main
      await act(async () => {
        state.setActiveWorktree(null);
        await flushPromises();
      });

      expect(cancelQueriesSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
      expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
    } finally {
      cancelQueriesSpy.mockRestore();
      invalidateQueriesSpy.mockRestore();
    }
  });

  it('resets non-worktree query cache on initial direct ?wt load', async () => {
    window.history.replaceState({}, '', '/board?wt=feature-auth');
    setupFetchMock('main');
    const removeQueriesSpy = jest.spyOn(queryClient, 'removeQueries');

    try {
      const state = renderTracker();
      await act(async () => await flushPromises());

      await waitFor(() => {
        expect(state.activeWorktree?.name).toBe('feature-auth');
      });

      await waitFor(() => {
        expect(removeQueriesSpy).toHaveBeenCalledTimes(1);
      });
    } finally {
      removeQueriesSpy.mockRestore();
    }
  });

  it('clears worktree selection outside main mode and skips /api/worktrees fetch', async () => {
    window.history.replaceState({}, '', '/board?wt=feature-auth');
    const fetchMock = setupFetchMock('normal');
    const state = renderTracker();

    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.worktreesLoading).toBe(false);
    });

    const worktreeCalls = fetchMock.mock.calls.filter(
      (call) => asRequestUrl(call[0] as RequestInfo | URL) === '/api/worktrees',
    );
    expect(worktreeCalls.length).toBe(0);
    expect(state.activeWorktree).toBeNull();
    expect(state.apiBase).toBe('');
    expect(window.location.search).toBe('');
  });

  it('integrates tab switch lifecycle: fetch rewrite and cache reset', async () => {
    const fetchMock = setupFetchMock('main');
    const removeQueriesSpy = jest.spyOn(queryClient, 'removeQueries');

    try {
      const state = renderTracker();
      await act(async () => await flushPromises());

      await waitFor(() => {
        expect(state.worktrees.length).toBe(2);
      });

      await window.fetch('/api/epics?projectId=main');
      expect(asRequestUrl(fetchMock.mock.calls.at(-1)?.[0] as RequestInfo | URL)).toBe(
        '/api/epics?projectId=main',
      );

      await act(async () => {
        state.setActiveWorktree(state.worktrees[0]);
        await flushPromises();
      });

      await window.fetch('/api/epics?projectId=worktree');
      expect(asRequestUrl(fetchMock.mock.calls.at(-1)?.[0] as RequestInfo | URL)).toBe(
        '/wt/feature-auth/api/epics?projectId=worktree',
      );

      await act(async () => {
        state.setActiveWorktree(null);
        await flushPromises();
      });

      await window.fetch('/api/epics?projectId=main-again');
      expect(asRequestUrl(fetchMock.mock.calls.at(-1)?.[0] as RequestInfo | URL)).toBe(
        '/api/epics?projectId=main-again',
      );

      expect(removeQueriesSpy).toHaveBeenCalledTimes(2);
    } finally {
      removeQueriesSpy.mockRestore();
    }
  });

  it('refreshes worktree list and keeps newly created worktree selectable without reload', async () => {
    let worktreeListCalls = 0;

    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = asRequestUrl(input);

      if (url === '/api/runtime') {
        return {
          ok: true,
          json: async () => ({ mode: 'main', version: '1.0.0' }),
        } as Response;
      }

      if (url === '/api/worktrees') {
        worktreeListCalls += 1;
        const payload =
          worktreeListCalls === 1
            ? [
                { id: 'wt-1', name: 'feature-auth', devchainProjectId: 'project-1' },
                { id: 'wt-2', name: 'feature-billing', devchainProjectId: 'project-2' },
              ]
            : [
                { id: 'wt-1', name: 'feature-auth', devchainProjectId: 'project-1' },
                { id: 'wt-2', name: 'feature-billing', devchainProjectId: 'project-2' },
                { id: 'wt-3', name: 'feature-search', devchainProjectId: 'project-3' },
              ];

        return {
          ok: true,
          json: async () => payload,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    window.fetch = fetchMock as unknown as typeof fetch;

    const state = renderTracker();
    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.worktrees.map((worktree) => worktree.name)).toEqual([
        'feature-auth',
        'feature-billing',
      ]);
    });

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['worktree-tabs-worktrees'] });
    });

    await waitFor(() => {
      expect(state.worktrees.map((worktree) => worktree.name)).toEqual([
        'feature-auth',
        'feature-billing',
        'feature-search',
      ]);
    });

    const newWorktree = state.worktrees.find((worktree) => worktree.name === 'feature-search');
    expect(newWorktree).toBeTruthy();
    expect(worktreeListCalls).toBeGreaterThanOrEqual(2);

    await act(async () => {
      state.setActiveWorktree(newWorktree ?? null);
      await flushPromises();
    });

    expect(state.activeWorktree?.name).toBe('feature-search');
    expect(state.apiBase).toBe('/wt/feature-search');
    expect(window.location.search).toBe('?wt=feature-search');
  });

  describe('WebSocket worktrees listener', () => {
    let mockSocket: MockSocket;

    beforeEach(() => {
      mockSocket = createMockSocket();
      getAppSocketMock.mockReturnValue(mockSocket as unknown as Socket);
    });

    it('connects app socket and listens for worktrees WebSocket events in main mode', async () => {
      setupFetchMock('main');
      renderTracker();
      await act(async () => await flushPromises());

      await waitFor(() => {
        expect(getAppSocketMock).toHaveBeenCalled();
      });
      expect(mockSocket.on).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('invalidates all worktree-related query keys on worktrees topic message', async () => {
      setupFetchMock('main');
      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
      renderTracker();
      await act(async () => await flushPromises());

      await waitFor(() => {
        expect(getAppSocketMock).toHaveBeenCalled();
      });

      invalidateSpy.mockClear();

      act(() => {
        simulateMessage(mockSocket, { topic: 'worktrees', type: 'changed' });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['worktree-tabs-worktrees'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['chat-worktree-agent-groups'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['orchestrator-worktrees'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['orchestrator-worktree-overview'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['orchestrator-worktree-activity'] });

      invalidateSpy.mockRestore();
    });

    it('does not connect app socket when not in main mode', async () => {
      setupFetchMock('normal');
      getAppSocketMock.mockClear();
      renderTracker();
      await act(async () => await flushPromises());

      await waitFor(() => {
        expect(getAppSocketMock).not.toHaveBeenCalled();
      });
    });

    it('releases app socket on unmount', async () => {
      setupFetchMock('main');
      renderTracker();
      await act(async () => await flushPromises());

      await waitFor(() => {
        expect(getAppSocketMock).toHaveBeenCalled();
      });

      await act(async () => {
        root.unmount();
      });

      expect(mockSocket.off).toHaveBeenCalledWith('message', expect.any(Function));
      expect(releaseAppSocketMock).toHaveBeenCalled();
    });
  });
});
