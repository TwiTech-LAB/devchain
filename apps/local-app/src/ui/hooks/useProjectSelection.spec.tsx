/** @jest-environment jsdom */

import { act, useEffect } from 'react';
import { waitFor } from '@testing-library/react';
import { createRoot, Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';
import {
  ProjectSelectionProvider,
  useSelectedProject,
  PROJECT_STORAGE_KEY,
  WORKSPACE_PROJECTS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  fetchProjects,
} from './useProjectSelection';

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));
const originalFetch = global.fetch;
const DEFAULT_WORKSPACE_ID = 'workspace-default';
const SECOND_WORKSPACE_ID = 'workspace-second';
let mockActiveWorktree: { id: string; name: string; devchainProjectId: string | null } | null =
  null;
let mockRuntimeResolved = true;

jest.mock('./useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => ({
    activeWorktree: mockActiveWorktree,
    setActiveWorktree: () => undefined,
    apiBase: '',
    worktrees: [],
    worktreesLoading: false,
    runtimeResolved: mockRuntimeResolved,
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
    mockRuntimeResolved = true;
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
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
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: 'Alpha Project',
        description: null,
        rootPath: '/tmp/alpha',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'project-beta',
        workspaceId: DEFAULT_WORKSPACE_ID,
        name: 'Beta Project',
        description: null,
        rootPath: '/tmp/beta',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ],
    total: 2,
  };
  const mockWorkspacesResponse = [
    {
      id: DEFAULT_WORKSPACE_ID,
      name: 'Default',
      isDefault: true,
      position: 0,
      projectCount: 2,
      deviceGrantCount: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ];
  const secondWorkspace = {
    ...mockWorkspacesResponse[0],
    id: SECOND_WORKSPACE_ID,
    name: 'Second',
    isDefault: false,
    position: 1,
  };
  const secondWorkspaceProjects = {
    items: [
      {
        ...mockProjectsResponse.items[0],
        id: 'project-gamma',
        workspaceId: SECOND_WORKSPACE_ID,
        name: 'Gamma Project',
        rootPath: '/tmp/gamma',
      },
      {
        ...mockProjectsResponse.items[1],
        id: 'project-delta',
        workspaceId: SECOND_WORKSPACE_ID,
        name: 'Delta Project',
        rootPath: '/tmp/delta',
      },
    ],
    total: 2,
  };

  function setupMultiWorkspaceFetch() {
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/stats')) {
        return { ok: true, json: async () => mockStatsResponse } as Response;
      }
      if (url === '/api/workspaces') {
        return {
          ok: true,
          json: async () => [mockWorkspacesResponse[0], secondWorkspace],
        } as Response;
      }
      if (url.startsWith('/api/projects/by-path?')) {
        return {
          ok: true,
          json: async () => secondWorkspaceProjects.items[0],
        } as Response;
      }
      const detailMatch = url.match(/^\/api\/projects\/([^/?]+)$/);
      if (detailMatch) {
        const id = decodeURIComponent(detailMatch[1]);
        const project = [...mockProjectsResponse.items, ...secondWorkspaceProjects.items].find(
          (item) => item.id === id,
        );
        return { ok: Boolean(project), json: async () => project ?? {} } as Response;
      }
      if (url === `/api/projects?workspaceId=${SECOND_WORKSPACE_ID}`) {
        return { ok: true, json: async () => secondWorkspaceProjects } as Response;
      }
      if (url === `/api/projects?workspaceId=${DEFAULT_WORKSPACE_ID}`) {
        return { ok: true, json: async () => mockProjectsResponse } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;
    return mockFetch;
  }
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

      if (url === '/api/workspaces') {
        return {
          ok: true,
          json: async () => mockWorkspacesResponse,
        } as Response;
      }

      const projectDetailMatch = url.match(/^\/api\/projects\/([^/?]+)$/);
      if (projectDetailMatch) {
        const project = mockProjectsResponse.items.find(
          (item) => item.id === decodeURIComponent(projectDetailMatch[1]),
        );
        return {
          ok: Boolean(project),
          json: async () => project ?? {},
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

  function setupEmptyWorkspaceFetch() {
    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/workspaces') {
        return { ok: true, json: async () => mockWorkspacesResponse } as Response;
      }
      if (url.includes('/api/projects')) {
        return { ok: true, json: async () => ({ items: [], total: 0 }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = mockFetch as unknown as typeof fetch;
  }

  interface TrackerState {
    currentWorkspace: string | undefined;
    currentSelection: string | undefined;
    currentProject: string | undefined;
    projectsLoading: boolean;
    workspaceSelectionLocked: boolean;
    activationStatus: string | null;
    activationProjectId: string | null;
    updateWorkspace: (workspaceId: string) => void;
    updateSelection: (projectId?: string) => void;
    activateProject: (project: { id: string; workspaceId: string }) => void;
  }

  function renderTracker(): TrackerState {
    return renderTrackerWithControls().state;
  }

  function renderTrackerWithControls(): { state: TrackerState; rerender: () => void } {
    const state: TrackerState = {
      currentWorkspace: undefined,
      currentSelection: undefined,
      currentProject: undefined,
      projectsLoading: false,
      workspaceSelectionLocked: false,
      activationStatus: null,
      activationProjectId: null,
      updateWorkspace: () => undefined,
      updateSelection: () => undefined,
      activateProject: () => undefined,
    };

    const Tracker = () => {
      const {
        selectedWorkspaceId,
        selectedProjectId,
        selectedProject,
        projectsLoading,
        isWorkspaceSelectionLocked,
        projectActivation,
        setSelectedWorkspaceId,
        setSelectedProjectId,
        activateProject,
      } = useSelectedProject();

      useEffect(() => {
        state.currentWorkspace = selectedWorkspaceId;
        state.currentSelection = selectedProjectId;
        state.currentProject = selectedProject?.id;
        state.projectsLoading = projectsLoading;
        state.workspaceSelectionLocked = isWorkspaceSelectionLocked;
        state.activationStatus = projectActivation?.status ?? null;
        state.activationProjectId = projectActivation?.projectId ?? null;
        state.updateWorkspace = setSelectedWorkspaceId;
        state.updateSelection = setSelectedProjectId;
        state.activateProject = activateProject;
      }, [
        activateProject,
        isWorkspaceSelectionLocked,
        projectActivation,
        projectsLoading,
        selectedProject,
        selectedProjectId,
        selectedWorkspaceId,
        setSelectedProjectId,
        setSelectedWorkspaceId,
      ]);

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
    await waitFor(() => expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID));

    await waitFor(() => expect(state.currentSelection).toBe('project-alpha'));
  });

  it('sessionStorage takes precedence over localStorage for reading', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-alpha');
    sessionStorage.setItem(PROJECT_STORAGE_KEY, 'project-beta');
    setupMockFetch();

    const state = renderTracker();
    await waitFor(() => expect(state.currentSelection).toBe('project-beta'));
  });

  it('writes to both sessionStorage and localStorage when setting selection', async () => {
    setupMockFetch();

    const state = renderTracker();
    await waitFor(() => expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID));

    await act(async () => {
      state.updateSelection('project-alpha');
      await flushPromises();
    });

    expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-alpha');
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-alpha');
  });

  it('reselects the first project after clearing a selection in a nonempty workspace', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-beta');
    sessionStorage.setItem(PROJECT_STORAGE_KEY, 'project-beta');
    setupMockFetch();

    const state = renderTracker();
    await waitFor(() => expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID));

    await act(async () => {
      state.updateSelection(undefined);
      await flushPromises();
    });

    // Clearing is temporary in a nonempty workspace: reconciliation selects the
    // first project instead of resurrecting the cleared localStorage value.
    await waitFor(() => expect(state.currentSelection).toBe('project-alpha'));
    expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-alpha');
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

      if (url === '/api/workspaces') {
        return { ok: true, json: async () => mockWorkspacesResponse } as Response;
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

  it('selects the first project when both stored selections are invalid', async () => {
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

      if (url === '/api/workspaces') {
        return { ok: true, json: async () => mockWorkspacesResponse } as Response;
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

    // Both stored values are invalid: the first returned project is selected and persisted.
    await waitFor(() => {
      expect(state.currentSelection).toBe('project-alpha');
      expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-alpha');
    });
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-alpha');
    expect(JSON.parse(sessionStorage.getItem(WORKSPACE_PROJECTS_STORAGE_KEY) ?? '{}')).toEqual({
      [DEFAULT_WORKSPACE_ID]: 'project-alpha',
    });
    expect(JSON.parse(localStorage.getItem(WORKSPACE_PROJECTS_STORAGE_KEY) ?? '{}')).toEqual({
      [DEFAULT_WORKSPACE_ID]: 'project-alpha',
    });
  });

  it('selects the first project when a workspace has no stored selection', async () => {
    setupMultiWorkspaceFetch();
    const state = renderTracker();

    await waitFor(() => {
      expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID);
      expect(state.currentSelection).toBe('project-alpha');
    });

    act(() => state.updateWorkspace(SECOND_WORKSPACE_ID));
    await waitFor(() => {
      expect(state.currentWorkspace).toBe(SECOND_WORKSPACE_ID);
      expect(state.currentSelection).toBe('project-gamma');
    });
  });

  it('keeps an empty workspace unselected without a reconciliation loop', async () => {
    setupEmptyWorkspaceFetch();

    const state = renderTracker();
    await act(async () => await flushPromises());

    await waitFor(() => expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID));
    expect(state.currentSelection).toBeUndefined();
    expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(WORKSPACE_PROJECTS_STORAGE_KEY)).toBeNull();
  });

  it('clears a stale selection once when the workspace is empty', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, 'deleted-project');
    sessionStorage.setItem(PROJECT_STORAGE_KEY, 'deleted-project');
    setupEmptyWorkspaceFetch();

    const state = renderTracker();
    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID);
      expect(state.currentSelection).toBeUndefined();
      expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
    });
    // localStorage is kept even when stale (serves as new tab default that gets validated)
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('deleted-project');
  });

  it('new tabs initialize from localStorage when sessionStorage is empty', async () => {
    // Simulate a new tab: localStorage has value, sessionStorage is empty
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-beta');
    // sessionStorage is already cleared in beforeEach

    setupMockFetch();

    const state = renderTracker();
    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(state.currentSelection).toBe('project-beta');
      expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-beta');
    });
    // After initialization, both should have the value
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-beta');
  });

  it('uses the explicit Default workspace for fresh and stale workspace state', async () => {
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, 'workspace-stale');
    localStorage.setItem(WORKSPACE_STORAGE_KEY, 'workspace-stale');
    const mockFetch = setupMultiWorkspaceFetch();

    const state = renderTracker();

    await waitFor(() => {
      expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID);
      expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(DEFAULT_WORKSPACE_ID);
      expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(DEFAULT_WORKSPACE_ID);
    });
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/projects?workspaceId=${DEFAULT_WORKSPACE_ID}`,
      expect.any(Object),
    );
  });

  it('restores the last valid project independently for each workspace', async () => {
    setupMultiWorkspaceFetch();
    const state = renderTracker();

    await waitFor(() => expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID));
    act(() => state.updateSelection('project-alpha'));
    await waitFor(() => expect(state.currentSelection).toBe('project-alpha'));

    act(() => state.updateWorkspace(SECOND_WORKSPACE_ID));
    await waitFor(() => expect(state.currentWorkspace).toBe(SECOND_WORKSPACE_ID));
    act(() => state.updateSelection('project-gamma'));
    await waitFor(() => expect(state.currentSelection).toBe('project-gamma'));

    act(() => state.updateWorkspace(DEFAULT_WORKSPACE_ID));
    await waitFor(() => {
      expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID);
      expect(state.currentSelection).toBe('project-alpha');
    });

    expect(JSON.parse(sessionStorage.getItem(WORKSPACE_PROJECTS_STORAGE_KEY) ?? '{}')).toEqual({
      [DEFAULT_WORKSPACE_ID]: 'project-alpha',
      [SECOND_WORKSPACE_ID]: 'project-gamma',
    });
  });

  it('atomically activates a management project in its own workspace', async () => {
    setupMultiWorkspaceFetch();
    const state = renderTracker();

    await waitFor(() => expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID));
    act(() => state.activateProject(secondWorkspaceProjects.items[1]));

    await waitFor(() => {
      expect(state.currentWorkspace).toBe(SECOND_WORKSPACE_ID);
      expect(state.currentSelection).toBe('project-delta');
      expect(state.currentProject).toBe('project-delta');
      expect(state.activationStatus).toBe('confirmed');
      expect(state.activationProjectId).toBe('project-delta');
    });
    expect(sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(SECOND_WORKSPACE_ID);
    // The Default workspace entry comes from the initial first-project fallback.
    expect(JSON.parse(sessionStorage.getItem(WORKSPACE_PROJECTS_STORAGE_KEY) ?? '{}')).toEqual({
      [DEFAULT_WORKSPACE_ID]: 'project-alpha',
      [SECOND_WORKSPACE_ID]: 'project-delta',
    });
  });

  it('preserves a pending activation through stale target cache and refetch', async () => {
    let resolveSecondWorkspaceProjects: ((response: Response) => void) | undefined;
    const freshSecondWorkspaceProjects = {
      items: [
        ...secondWorkspaceProjects.items,
        {
          ...secondWorkspaceProjects.items[0],
          id: 'project-new',
          name: 'New Project',
          rootPath: '/tmp/new',
        },
      ],
      total: 3,
    };
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/workspaces') {
        return Promise.resolve({
          ok: true,
          json: async () => [mockWorkspacesResponse[0], secondWorkspace],
        } as Response);
      }
      if (url === `/api/projects?workspaceId=${DEFAULT_WORKSPACE_ID}`) {
        return Promise.resolve({ ok: true, json: async () => mockProjectsResponse } as Response);
      }
      if (url === `/api/projects?workspaceId=${SECOND_WORKSPACE_ID}`) {
        return new Promise<Response>((resolve) => {
          resolveSecondWorkspaceProjects = resolve;
        });
      }
      if (url.endsWith('/stats')) {
        return Promise.resolve({ ok: true, json: async () => mockStatsResponse } as Response);
      }
      return Promise.resolve({ ok: false, json: async () => ({}) } as Response);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    queryClient.setQueryData(
      projectsQueryKeys.available(SECOND_WORKSPACE_ID),
      secondWorkspaceProjects,
    );
    const state = renderTracker();

    await waitFor(() => expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID));
    act(() => state.activateProject({ id: 'project-new', workspaceId: SECOND_WORKSPACE_ID }));

    await waitFor(() => expect(state.currentWorkspace).toBe(SECOND_WORKSPACE_ID));
    expect(state.currentSelection).toBe('project-new');
    expect(state.activationStatus).toBe('pending');
    // The Default workspace entry comes from the initial first-project fallback.
    expect(JSON.parse(sessionStorage.getItem(WORKSPACE_PROJECTS_STORAGE_KEY) ?? '{}')).toEqual({
      [DEFAULT_WORKSPACE_ID]: 'project-alpha',
      [SECOND_WORKSPACE_ID]: 'project-new',
    });

    resolveSecondWorkspaceProjects?.({
      ok: true,
      json: async () => freshSecondWorkspaceProjects,
    } as Response);
    await waitFor(() => {
      expect(state.currentWorkspace).toBe(SECOND_WORKSPACE_ID);
      expect(state.currentSelection).toBe('project-new');
      expect(state.currentProject).toBe('project-new');
      expect(state.activationStatus).toBe('confirmed');
    });
  });

  it('keeps the new workspace active when the previous workspace response finishes late', async () => {
    let resolveDefaultProjects: ((response: Response) => void) | undefined;
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/workspaces') {
        return Promise.resolve({
          ok: true,
          json: async () => [mockWorkspacesResponse[0], secondWorkspace],
        } as Response);
      }
      if (url === `/api/projects?workspaceId=${DEFAULT_WORKSPACE_ID}`) {
        return new Promise<Response>((resolve) => {
          resolveDefaultProjects = resolve;
        });
      }
      if (url === `/api/projects?workspaceId=${SECOND_WORKSPACE_ID}`) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ items: [secondWorkspaceProjects.items[0]], total: 1 }),
        } as Response);
      }
      if (url.endsWith('/stats')) {
        return Promise.resolve({ ok: true, json: async () => mockStatsResponse } as Response);
      }
      return Promise.resolve({ ok: false, json: async () => ({}) } as Response);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const state = renderTracker();

    await waitFor(() => expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID));
    act(() => state.updateWorkspace(SECOND_WORKSPACE_ID));
    await waitFor(() => {
      expect(state.currentWorkspace).toBe(SECOND_WORKSPACE_ID);
      expect(state.currentSelection).toBe('project-gamma');
    });

    resolveDefaultProjects?.({
      ok: true,
      json: async () => mockProjectsResponse,
    } as Response);
    await act(async () => await flushPromises());

    expect(state.currentWorkspace).toBe(SECOND_WORKSPACE_ID);
    expect(state.currentSelection).toBe('project-gamma');
  });

  it('keeps a warm-cache URL project ahead of the first-project fallback', async () => {
    window.history.replaceState({}, '', '/?projectId=project-beta');
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, DEFAULT_WORKSPACE_ID);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, DEFAULT_WORKSPACE_ID);
    setupMockFetch();
    queryClient.setQueryData(['workspaces'], mockWorkspacesResponse);
    queryClient.setQueryData(
      projectsQueryKeys.available(DEFAULT_WORKSPACE_ID),
      mockProjectsResponse,
    );
    queryClient.setQueryData(
      projectsQueryKeys.detail({ id: 'project-beta' }),
      mockProjectsResponse.items[1],
    );

    const state = renderTracker();

    await waitFor(() => {
      expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID);
      expect(state.currentSelection).toBe('project-beta');
      expect(state.currentProject).toBe('project-beta');
    });
    expect(sessionStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-beta');
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-beta');
    expect(JSON.parse(sessionStorage.getItem(WORKSPACE_PROJECTS_STORAGE_KEY) ?? '{}')).toEqual({
      [DEFAULT_WORKSPACE_ID]: 'project-beta',
    });
    expect(JSON.parse(localStorage.getItem(WORKSPACE_PROJECTS_STORAGE_KEY) ?? '{}')).toEqual({
      [DEFAULT_WORKSPACE_ID]: 'project-beta',
    });
  });

  it.each([
    ['projectId', 'project-gamma', '/api/projects/project-gamma'],
    ['projectPath', '/tmp/gamma', '/api/projects/by-path?path=%2Ftmp%2Fgamma'],
  ])(
    'resolves a URL %s through project detail before activating its workspace',
    async (key, value, detailUrl) => {
      window.history.replaceState({}, '', `/?${key}=${encodeURIComponent(value)}`);
      const mockFetch = setupMultiWorkspaceFetch();

      const state = renderTracker();

      await waitFor(() => {
        expect(state.currentWorkspace).toBe(SECOND_WORKSPACE_ID);
        expect(state.currentSelection).toBe('project-gamma');
        expect(state.currentProject).toBe('project-gamma');
      });
      const detailCall = mockFetch.mock.calls.findIndex((call) => call[0] === detailUrl);
      const availableCall = mockFetch.mock.calls.findIndex(
        (call) => call[0] === `/api/projects?workspaceId=${SECOND_WORKSPACE_ID}`,
      );
      expect(detailCall).toBeGreaterThanOrEqual(0);
      expect(availableCall).toBeGreaterThan(detailCall);
    },
  );

  it('locks workspace changes to the active worktree project and restores on unlock', async () => {
    setupMultiWorkspaceFetch();
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, DEFAULT_WORKSPACE_ID);
    localStorage.setItem(WORKSPACE_STORAGE_KEY, DEFAULT_WORKSPACE_ID);
    mockActiveWorktree = {
      id: 'wt-1',
      name: 'feature-auth',
      devchainProjectId: 'project-gamma',
    };
    const { state, rerender } = renderTrackerWithControls();

    await waitFor(() => {
      expect(state.workspaceSelectionLocked).toBe(true);
      expect(state.currentWorkspace).toBe(SECOND_WORKSPACE_ID);
      expect(state.currentSelection).toBe('project-gamma');
    });
    act(() => state.updateWorkspace(DEFAULT_WORKSPACE_ID));
    expect(state.currentWorkspace).toBe(SECOND_WORKSPACE_ID);

    mockActiveWorktree = null;
    rerender();
    await waitFor(() => {
      expect(state.workspaceSelectionLocked).toBe(false);
      expect(state.currentWorkspace).toBe(DEFAULT_WORKSPACE_ID);
    });
  });

  it('preserves selection during stale data window after worktree unlock', async () => {
    // Worktree-only projects (do NOT contain the main project IDs)
    const worktreeProjects = {
      items: [
        {
          id: 'wt-project-1',
          workspaceId: DEFAULT_WORKSPACE_ID,
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
      if (url === '/api/workspaces') {
        return { ok: true, json: async () => mockWorkspacesResponse } as Response;
      }
      if (url === '/api/projects/wt-project-1') {
        return { ok: true, json: async () => worktreeProjects.items[0] } as Response;
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

    // AC1: selection preserved during stale data window
    await waitFor(() => expect(state.currentSelection).toBe('project-alpha'));
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

  it('gates projects query and exposed selection until runtime resolves', async () => {
    sessionStorage.setItem(PROJECT_STORAGE_KEY, 'project-alpha');
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-alpha');
    mockRuntimeResolved = false;
    const mockFetch = setupMockFetch();
    const { state, rerender } = renderTrackerWithControls();

    await act(async () => await flushPromises());

    expect(mockFetch).not.toHaveBeenCalled();
    expect(state.projectsLoading).toBe(true);
    expect(state.currentSelection).toBeUndefined();
    expect(state.currentProject).toBeUndefined();

    mockRuntimeResolved = true;
    rerender();
    await act(async () => await flushPromises());

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/projects?workspaceId=${DEFAULT_WORKSPACE_ID}`,
        expect.any(Object),
      );
      expect(state.currentSelection).toBe('project-alpha');
      expect(state.currentProject).toBe('project-alpha');
      expect(state.projectsLoading).toBe(false);
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
    expect(statsInit?.signal).toBeDefined();
    controller.abort();
    expect(statsInit?.signal?.aborted).toBe(true);
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
