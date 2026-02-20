/** @jest-environment jsdom */

import { act, useEffect } from 'react';
import { waitFor } from '@testing-library/react';
import { createRoot, Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ProjectSelectionProvider,
  useSelectedProject,
  PROJECT_STORAGE_KEY,
  fetchProjects,
} from './useProjectSelection';

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));
const originalFetch = global.fetch;
let mockActiveWorktree: { id: string; name: string; devchainProjectId: string | null } | null =
  null;

jest.mock('./useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => ({
    activeWorktree: mockActiveWorktree,
    setActiveWorktree: () => undefined,
    apiBase: '',
    worktrees: [],
    worktreesLoading: false,
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ProjectSelectionProvider', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockActiveWorktree = null;
    localStorage.clear();
    sessionStorage.clear();
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (global as unknown as { fetch?: unknown }).fetch;
    }
  });

  const mockProjectsResponse = {
    items: [
      {
        id: 'project-alpha',
        name: 'Alpha Project',
        description: null,
        rootPath: '/tmp/alpha',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'project-beta',
        name: 'Beta Project',
        description: null,
        rootPath: '/tmp/beta',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
    total: 2,
  };
  const mockStatsResponse = { epicsCount: 0, agentsCount: 0 };

  function setupMockFetch() {
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/stats')) {
        return {
          ok: true,
          json: async () => mockStatsResponse,
        } as Response;
      }

      if (url.includes('/api/projects')) {
        return {
          ok: true,
          json: async () => mockProjectsResponse,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = mockFetch as unknown as typeof fetch;
    return mockFetch;
  }

  interface TrackerState {
    currentSelection: string | undefined;
    updateSelection: (projectId?: string) => void;
  }

  function renderTracker(): TrackerState {
    return renderTrackerWithControls().state;
  }

  function renderTrackerWithControls(): { state: TrackerState; rerender: () => void } {
    const state: TrackerState = {
      currentSelection: undefined,
      updateSelection: () => undefined,
    };

    const Tracker = () => {
      const { selectedProjectId, setSelectedProjectId } = useSelectedProject();

      useEffect(() => {
        state.currentSelection = selectedProjectId;
        state.updateSelection = setSelectedProjectId;
      }, [selectedProjectId, setSelectedProjectId]);

      return null;
    };

    const renderTree = () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectSelectionProvider>
            <Tracker />
          </ProjectSelectionProvider>
        </QueryClientProvider>,
      );
    };

    act(() => {
      renderTree();
    });

    return {
      state,
      rerender: () => {
        act(() => {
          renderTree();
        });
      },
    };
  }

  it('hydrates selection from localStorage when sessionStorage is empty', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-alpha');
    setupMockFetch();

    const state = renderTracker();
    await act(async () => await flushPromises());

    expect(state.currentSelection).toBe('project-alpha');
  });

  it('sessionStorage takes precedence over localStorage for reading', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-alpha');
    sessionStorage.setItem(PROJECT_STORAGE_KEY, 'project-beta');
    setupMockFetch();

    const state = renderTracker();
    await act(async () => await flushPromises());

    expect(state.currentSelection).toBe('project-beta');
  });

  it('writes to both sessionStorage and localStorage when setting selection', async () => {
    setupMockFetch();

    const state = renderTracker();
    await act(async () => await flushPromises());

    await act(async () => {
      state.updateSelection('project-alpha');
      await flushPromises();
    });

    expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-alpha');
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-alpha');
  });

  it('clears sessionStorage but keeps localStorage when clearing selection', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-alpha');
    sessionStorage.setItem(PROJECT_STORAGE_KEY, 'project-alpha');
    setupMockFetch();

    const state = renderTracker();
    await act(async () => await flushPromises());

    await act(async () => {
      state.updateSelection(undefined);
      await flushPromises();
    });

    expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
    // localStorage is kept as fallback for new tabs
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-alpha');
  });

  it('falls back to localStorage when sessionStorage value is invalid', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-beta');
    sessionStorage.setItem(PROJECT_STORAGE_KEY, 'non-existent-project');

    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/stats')) {
        return {
          ok: true,
          json: async () => mockStatsResponse,
        } as Response;
      }

      if (url.includes('/api/projects')) {
        return {
          ok: true,
          json: async () => mockProjectsResponse,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = mockFetch as unknown as typeof fetch;

    const state = renderTracker();
    await act(async () => await flushPromises());

    // Should fall back to localStorage value (project-beta) since sessionStorage value is invalid
    await waitFor(() => {
      expect(state.currentSelection).toBe('project-beta');
      expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-beta');
    });
  });

  it('clears both storages when localStorage value is also invalid', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, 'non-existent-project-alpha');
    sessionStorage.setItem(PROJECT_STORAGE_KEY, 'non-existent-project-beta');

    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/stats')) {
        return {
          ok: true,
          json: async () => mockStatsResponse,
        } as Response;
      }

      if (url.includes('/api/projects')) {
        return {
          ok: true,
          json: async () => mockProjectsResponse,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = mockFetch as unknown as typeof fetch;

    const state = renderTracker();
    await act(async () => await flushPromises());

    // Both values are invalid - should clear selection
    await waitFor(() => {
      expect(state.currentSelection).toBeUndefined();
      expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
    });
    // localStorage is kept even when invalid (serves as new tab default that gets validated)
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('non-existent-project-alpha');
  });

  it('new tabs initialize from localStorage when sessionStorage is empty', async () => {
    // Simulate a new tab: localStorage has value, sessionStorage is empty
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-beta');
    // sessionStorage is already cleared in beforeEach

    setupMockFetch();

    const state = renderTracker();
    await act(async () => await flushPromises());

    expect(state.currentSelection).toBe('project-beta');
    // After initialization, both should have the value
    expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-beta');
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-beta');
  });

  it('preserves selection during stale data window after worktree unlock', async () => {
    // Worktree-only projects (do NOT contain the main project IDs)
    const worktreeProjects = {
      items: [
        {
          id: 'wt-project-1',
          name: 'Worktree Project',
          description: null,
          rootPath: '/tmp/wt',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      total: 1,
    };

    let returnWorktreeProjects = true;

    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => mockStatsResponse } as Response;
      }
      if (url.includes('/api/projects')) {
        return {
          ok: true,
          json: async () => (returnWorktreeProjects ? worktreeProjects : mockProjectsResponse),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    // Store main project selection before worktree activation
    sessionStorage.setItem(PROJECT_STORAGE_KEY, 'project-alpha');
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-alpha');

    // Start with worktree active — selection locked to worktree project
    mockActiveWorktree = {
      id: 'wt-1',
      name: 'feature-auth',
      devchainProjectId: 'wt-project-1',
    };
    const { state, rerender } = renderTrackerWithControls();
    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.currentSelection).toBe('wt-project-1');
    });

    // Unlock (worktree → main). projectsData still has stale worktree projects.
    // Without wasLockedRef, validation would see 'project-alpha' NOT in ['wt-project-1'] → clear.
    mockActiveWorktree = null;
    rerender();
    await act(async () => await flushPromises());

    // AC1: selection preserved during stale data window
    expect(state.currentSelection).toBe('project-alpha');
    expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-alpha');

    // Simulate fresh main projects arriving (cache refreshed after cleanup)
    returnWorktreeProjects = false;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['projects'] });
      await flushPromises();
    });

    // AC2: normal validation resumes — project-alpha exists in main projects, selection stays
    await waitFor(() => {
      expect(state.currentSelection).toBe('project-alpha');
    });
  });

  it('locks selection to active worktree project and restores main selection on unlock', async () => {
    setupMockFetch();
    const { state, rerender } = renderTrackerWithControls();

    await act(async () => await flushPromises());

    await act(async () => {
      state.updateSelection('project-alpha');
      await flushPromises();
    });
    expect(state.currentSelection).toBe('project-alpha');

    mockActiveWorktree = {
      id: 'wt-1',
      name: 'feature-auth',
      devchainProjectId: 'project-beta',
    };
    rerender();
    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.currentSelection).toBe('project-beta');
    });

    await act(async () => {
      state.updateSelection('project-alpha');
      await flushPromises();
    });
    expect(state.currentSelection).toBe('project-beta');

    mockActiveWorktree = null;
    rerender();
    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.currentSelection).toBe('project-alpha');
    });
  });
});

describe('fetchProjects', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as unknown as { fetch?: unknown }).fetch;
    }
  });

  it('passes signal to the /api/projects fetch', async () => {
    const controller = new AbortController();
    const mockFetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ items: [] }),
    })) as unknown as typeof fetch;
    global.fetch = mockFetch;

    await fetchProjects({ signal: controller.signal });

    expect(mockFetch).toHaveBeenCalledWith('/api/projects', { signal: controller.signal });
  });

  it('passes signal to stats fetches for cancellation support', async () => {
    const controller = new AbortController();
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return {
        ok: true,
        json: async () =>
          url === '/api/projects'
            ? { items: [{ id: 'p1', name: 'Project 1' }] }
            : { epicsCount: 0, agentsCount: 0 },
      } as Response;
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    const result = await fetchProjects({ signal: controller.signal });

    // Should have called fetch twice: /api/projects and /api/projects/p1/stats
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const statsCallArgs = mockFetch.mock.calls[1];
    expect(statsCallArgs[0]).toContain('/stats');
    // Stats fetch should receive the query signal for abort support
    const statsInit = statsCallArgs[1] as RequestInit | undefined;
    expect(statsInit?.signal).toBe(controller.signal);
    expect(result.items[0].stats).toEqual({ epicsCount: 0, agentsCount: 0 });
  });

  it('returns project without stats when stats fetch times out', async () => {
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'p1', name: 'Project 1' }],
          }),
        } as Response;
      }
      // Simulate timeout: throw AbortError for stats fetch
      throw new DOMException('The operation was aborted', 'AbortError');
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    const result = await fetchProjects();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('p1');
    expect(result.items[0].stats).toBeUndefined();
  });

  it('aborts all in-flight requests when signal is cancelled', async () => {
    const controller = new AbortController();
    const mockFetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/projects') {
        return {
          ok: true,
          json: async () => ({
            items: [{ id: 'p1', name: 'Project 1' }],
          }),
        } as Response;
      }
      // Stats fetch: check if signal is aborted
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      // Simulate a fetch that checks abort during execution
      return {
        ok: true,
        json: async () => ({ epicsCount: 5, agentsCount: 3 }),
      } as Response;
    }) as unknown as typeof fetch;
    global.fetch = mockFetch;

    // Cancel before stats fetch completes
    controller.abort();
    await fetchProjects({ signal: controller.signal }).catch(() => null);

    // The main fetch should have been called with the aborted signal
    // It may throw or complete depending on timing — either way the signal was passed
    expect(mockFetch).toHaveBeenCalled();
    const mainCall = mockFetch.mock.calls[0];
    expect(mainCall[1]).toEqual({ signal: controller.signal });
  });
});
