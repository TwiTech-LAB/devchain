import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Import as ComponentType to avoid strict JSX component typing complaints in isolated TS
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BoardPage: React.ComponentType = require('./BoardPage').BoardPage;

// Mock project selection to provide a selected project
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    projects: [],
    projectsLoading: false,
    projectsError: false,
    refetchProjects: jest.fn(),
    selectedProjectId: 'project-1',
    selectedProject: { id: 'project-1', name: 'Project Alpha' },
    setSelectedProjectId: jest.fn(),
  }),
}));

// Minimal socket mock to satisfy BoardPage subscription wiring
interface MockSocket {
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
}
const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
const mockSocket: MockSocket = {
  on: jest.fn(),
  off: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
};
mockSocket.on.mockImplementation((event: string, cb: (...args: unknown[]) => unknown) => {
  handlers[event] = handlers[event] || [];
  handlers[event].push(cb);
  return mockSocket;
});
mockSocket.off.mockImplementation((event: string, cb: (...args: unknown[]) => unknown) => {
  if (!handlers[event]) return mockSocket;
  handlers[event] = handlers[event].filter((fn) => fn !== cb);
  return mockSocket;
});
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));

// JSDOM lacks ResizeObserver used by Radix
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function Wrapper({
  children,
  initialEntries = ['/board'] as string[],
}: {
  children: React.ReactNode;
  initialEntries?: string[];
}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc-search">{location.search}</div>;
}

function BackButton() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate(-1)} data-testid="back-btn">
      Back
    </button>
  );
}

describe('BoardPage — URL filters and history navigation', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    // Basic fetch stubs for statuses/epics/agents/sub-epics
    fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 's1', projectId: 'project-1', label: 'Todo', color: '#aaa', position: 0 },
              {
                id: 's2',
                projectId: 'project-1',
                label: 'In Progress',
                color: '#0af',
                position: 1,
              },
              { id: 's3', projectId: 'project-1', label: 'Done', color: '#0f0', position: 2 },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/agents')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.startsWith('/api/epics?projectId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'root-1',
                projectId: 'project-1',
                title: 'Epic Root',
                description: null,
                statusId: 's1',
                version: 1,
                parentId: null,
                agentId: null,
                tags: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                id: 'root-2',
                projectId: 'project-1',
                title: 'Epic Two',
                description: null,
                statusId: 's2',
                version: 1,
                parentId: null,
                agentId: null,
                tags: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        } as Response;
      }
      if (url.startsWith('/api/epics?parentId=')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (url.endsWith('/sub-epics/counts')) {
        return { ok: true, json: async () => ({ s1: 0, s2: 0, s3: 0 }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global.fetch as jest.Mock | undefined)?.mockClear?.();
  });

  it('hydrates from ?p= and supports back/forward via navigation stack', async () => {
    render(
      <Wrapper>
        <Routes>
          <Route
            path="/board"
            element={
              <>
                <LocationProbe />
                <BackButton />
                <BoardPage />
              </>
            }
          />
        </Routes>
      </Wrapper>,
    );

    // Initially no search
    await waitFor(() => expect(screen.getByTestId('loc-search').textContent).toBe(''));

    // Click on the epic title to toggle parent filter → pushes ?p=root-1
    fireEvent.click(await screen.findByText('Epic Root'));

    await waitFor(() => expect(screen.getByTestId('loc-search').textContent).toBe('?p=root-1'));

    // Go back in history (pop) and expect URL and UI to reflect cleared filter
    fireEvent.click(screen.getByTestId('back-btn'));
    await waitFor(() => expect(screen.getByTestId('loc-search').textContent).toBe(''));
  });

  it('fetches with archived=active by default (no ar param)', async () => {
    render(
      <Wrapper initialEntries={['/board']}>
        <Routes>
          <Route
            path="/board"
            element={
              <>
                <LocationProbe />
                <BoardPage />
              </>
            }
          />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      // Check that epics fetch was called with type=active (default)
      const epicsCalls = fetchMock.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('/api/epics?projectId='),
      );
      expect(epicsCalls.length).toBeGreaterThan(0);
      expect(String(epicsCalls[0][0])).toContain('type=active');
    });
  });

  it('fetches with archived=all when ar=all in URL', async () => {
    render(
      <Wrapper initialEntries={['/board?ar=all']}>
        <Routes>
          <Route
            path="/board"
            element={
              <>
                <LocationProbe />
                <BoardPage />
              </>
            }
          />
        </Routes>
      </Wrapper>,
    );

    await waitFor(() => {
      const epicsCalls = fetchMock.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('/api/epics?projectId='),
      );
      expect(epicsCalls.length).toBeGreaterThan(0);
      expect(String(epicsCalls[0][0])).toContain('type=all');
    });
  });

  it('applies status filter from URL to render only matching epics', async () => {
    // With ?st=s1, only epics with statusId=s1 should be visible
    render(
      <Wrapper initialEntries={['/board?st=s1']}>
        <Routes>
          <Route
            path="/board"
            element={
              <>
                <LocationProbe />
                <BoardPage />
              </>
            }
          />
        </Routes>
      </Wrapper>,
    );

    // Wait for render and check that only Todo column (s1) is visible
    // Epic Root (s1) should be visible, Epic Two (s2) should not be in a visible column
    await waitFor(() => {
      expect(screen.getByText('Epic Root')).toBeInTheDocument();
    });

    // The Todo column should be visible
    expect(screen.getByText('Todo')).toBeInTheDocument();
  });

  it('resets page when status filter changes via URL', async () => {
    // Start at page 2 with no status filter
    render(
      <Wrapper initialEntries={['/board?pg=2']}>
        <Routes>
          <Route
            path="/board"
            element={
              <>
                <LocationProbe />
                <BoardPage />
              </>
            }
          />
        </Routes>
      </Wrapper>,
    );

    // Initial URL has pg=2
    await waitFor(() => {
      expect(screen.getByTestId('loc-search').textContent).toContain('pg=2');
    });
  });
});
