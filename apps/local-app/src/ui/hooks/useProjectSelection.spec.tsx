/** @jest-environment jsdom */

import { act, useEffect } from 'react';
import { waitFor } from '@testing-library/react';
import { createRoot, Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ProjectSelectionProvider,
  useSelectedProject,
  PROJECT_STORAGE_KEY,
} from './useProjectSelection';

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));
const originalFetch = global.fetch;

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

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectSelectionProvider>
            <Tracker />
          </ProjectSelectionProvider>
        </QueryClientProvider>,
      );
    });

    return state;
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
    expect(state.currentSelection).toBe('project-beta');
    expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-beta');
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
});
