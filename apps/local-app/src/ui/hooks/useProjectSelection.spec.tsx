/** @jest-environment jsdom */

import { act, useEffect } from 'react';
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

  it('hydrates selection from localStorage and persists updates', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, 'project-alpha');

    const projectsResponse = {
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
    const statsResponse = { epicsCount: 0, agentsCount: 0 };

    const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/stats')) {
        return {
          ok: true,
          json: async () => statsResponse,
        } as Response;
      }

      if (url.includes('/api/projects')) {
        return {
          ok: true,
          json: async () => projectsResponse,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = mockFetch as unknown as typeof fetch;

    let currentSelection: string | undefined;
    let updateSelection: (projectId?: string) => void = () => undefined;

    const Tracker = () => {
      const { selectedProjectId, setSelectedProjectId } = useSelectedProject();

      useEffect(() => {
        currentSelection = selectedProjectId;
        updateSelection = setSelectedProjectId;
      }, [selectedProjectId, setSelectedProjectId]);

      return null;
    };

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectSelectionProvider>
            <Tracker />
          </ProjectSelectionProvider>
        </QueryClientProvider>,
      );
      await flushPromises();
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(currentSelection).toBe('project-alpha');

    await act(async () => {
      updateSelection('project-beta');
      await flushPromises();
    });

    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe('project-beta');
    expect(currentSelection).toBe('project-beta');
  });
});
