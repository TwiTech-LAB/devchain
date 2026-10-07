import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuntimeProvider } from '@/ui/hooks/useRuntime';
import { BoardPage } from './BoardPage';
// Mock project selection to provide a selected project
let mockSelectedProject = { id: 'project-1', name: 'Project Alpha' } as {
  id: string;
  name: string;
} | null;
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    projects: [],
    projectsLoading: false,
    projectsError: false,
    refetchProjects: jest.fn(),
    selectedProjectId: mockSelectedProject?.id ?? null,
    selectedProject: mockSelectedProject,
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

const { on, off, disconnect } = mockSocket;
beforeEach(() => {
  mockSelectedProject = { id: 'project-1', name: 'Project Alpha' };
  Object.keys(handlers).forEach((event) => delete handlers[event]);
  jest.clearAllMocks();
  window.localStorage.clear();
});

describe('BoardPage.url-filters', () => {
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
        <QueryClientProvider client={queryClient}>
          <RuntimeProvider>{children}</RuntimeProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
  }

  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="loc-search">{location.search}</div>;
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

    it.each([
      ['/board', 'active'],
      ['/board?ar=all', 'all'],
    ])('fetches %s with type=%s', async (path, type) => {
      render(
        <Wrapper initialEntries={[path]}>
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
        expect(String(epicsCalls[0][0])).toContain('type=' + type);
      });
    });
  });
});

describe('BoardPage.saved-filters', () => {
  function Wrapper({ children }: { children: React.ReactNode }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <MemoryRouter initialEntries={['/board']}>
        <QueryClientProvider client={queryClient}>
          <RuntimeProvider>{children}</RuntimeProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
  }

  describe('BoardPage — saved-filter wiring', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      window.localStorage.clear();
      window.localStorage.setItem(
        'devchain:board:savedFilters:project-1',
        JSON.stringify([{ id: 'todo', name: 'Todo only', qs: 'st=s1' }]),
      );
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/statuses')) {
          return {
            ok: true,
            json: async () => ({
              items: [
                { id: 's1', projectId: 'project-1', label: 'Todo', color: '#aaa', position: 0 },
                { id: 's2', projectId: 'project-1', label: 'Done', color: '#0f0', position: 1 },
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
                  id: 'todo-epic',
                  projectId: 'project-1',
                  title: 'Todo Epic',
                  description: null,
                  statusId: 's1',
                  version: 1,
                  parentId: null,
                  agentId: null,
                  tags: [],
                },
                {
                  id: 'done-epic',
                  projectId: 'project-1',
                  title: 'Done Epic',
                  description: null,
                  statusId: 's2',
                  version: 1,
                  parentId: null,
                  agentId: null,
                  tags: [],
                },
              ],
            }),
          } as Response;
        }
        if (url.startsWith('/api/epics?parentId=')) {
          return { ok: true, json: async () => ({ items: [] }) } as Response;
        }
        if (url.endsWith('/sub-epics/counts')) {
          return { ok: true, json: async () => ({ s1: 0, s2: 0 }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }) as typeof fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('applies a selected saved filter to Board rendering', async () => {
      render(
        <Wrapper>
          <BoardPage />
        </Wrapper>,
      );

      expect(await screen.findByText('Todo Epic')).toBeInTheDocument();
      expect(screen.getByText('Done Epic')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /saved filters/i }));
      fireEvent.click(await screen.findByText('Todo only'));

      await waitFor(() => expect(screen.queryByText('Done Epic')).not.toBeInTheDocument());
      expect(screen.getByText('Todo Epic')).toBeInTheDocument();
    });
  });
});

describe('BoardPage.realtime', () => {
  function createWrapper() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <RuntimeProvider>{children}</RuntimeProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
    return { Wrapper, queryClient };
  }

  describe('BoardPage realtime subscription', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      Object.keys(handlers).forEach((event) => delete handlers[event]);
      on.mockClear();
      off.mockClear();
      disconnect.mockClear();
      mockSocket.emit.mockClear();

      // Basic fetch stubs for statuses/epics/agents
      global.fetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/statuses')) {
          return { ok: true, json: async () => ({ items: [] }) } as Response;
        }
        if (url.startsWith('/api/epics?projectId=')) {
          return { ok: true, json: async () => ({ items: [] }) } as Response;
        }
        if (url.startsWith('/api/agents')) {
          return { ok: true, json: async () => ({ items: [] }) } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }) as unknown as typeof fetch;
    });

    afterEach(() => {
      if (originalFetch) {
        global.fetch = originalFetch;
      }
    });

    it('invalidates epics cache on project-scoped epic events', async () => {
      const { Wrapper, queryClient } = createWrapper();
      const spy = jest.spyOn(queryClient, 'invalidateQueries');

      render(<BoardPage />, { wrapper: Wrapper });

      // Trigger epic lifecycle envelopes
      handlers['message']?.forEach((fn) =>
        fn({
          topic: 'project/project-1/epics',
          type: 'updated',
          payload: {},
          ts: new Date().toISOString(),
        }),
      );

      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith({ queryKey: ['epics', 'project-1'] });
      });

      handlers['message']?.forEach((fn) =>
        fn({
          topic: 'project/project-1/epics',
          type: 'created',
          payload: {},
          ts: new Date().toISOString(),
        }),
      );
      handlers['message']?.forEach((fn) =>
        fn({
          topic: 'project/project-1/epics',
          type: 'deleted',
          payload: {},
          ts: new Date().toISOString(),
        }),
      );

      await waitFor(() => {
        // called multiple times for the same key
        expect(
          spy.mock.calls.filter(
            (c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: ['epics', 'project-1'] }),
          ).length,
        ).toBeGreaterThanOrEqual(3);
      });
    });

    it('invalidates cached sub-epic counts when the socket reconnects', async () => {
      const { Wrapper, queryClient } = createWrapper();
      const countKey = ['epics', 'root-1', 'sub-counts'] as const;
      queryClient.setQueryData(countKey, { status: 1 });

      render(<BoardPage />, { wrapper: Wrapper });
      handlers['connect']?.forEach((fn) => fn());

      await waitFor(() => {
        expect(queryClient.getQueryState(countKey)?.isInvalidated).toBe(true);
      });
    });

    it('cleans up message listener and releases socket on unmount', async () => {
      const { Wrapper } = createWrapper();
      const { unmount } = render(<BoardPage />, { wrapper: Wrapper });

      // Ensure an on(message) registration happened
      expect(on).toHaveBeenCalledWith('message', expect.any(Function));

      unmount();

      // Verify off(message) was called during cleanup
      expect(off).toHaveBeenCalledWith('message', expect.any(Function));
      // With leak fix, final consumer cleanup should release/disconnect the socket.
      expect(disconnect).toHaveBeenCalled();
    });
  });
});

describe('BoardPage.bulk-edit', () => {
  // Radix Select checks pointer capture APIs that JSDOM does not implement
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false;
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {};
  }

  function Wrapper({ children }: { children: React.ReactNode }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <RuntimeProvider>{children}</RuntimeProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );
  }

  describe('BoardPage bulk edit for parent epics', () => {
    const originalFetch = global.fetch;
    let putCalls: Array<{ url: string; body: unknown }>;

    beforeEach(() => {
      const parentEpic = {
        id: 'parent-1',
        projectId: 'project-1',
        title: 'Parent Epic',
        description: 'Parent description',
        statusId: 's1',
        version: 1,
        parentId: null,
        agentId: null,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const subEpic = {
        id: 'child-1',
        projectId: 'project-1',
        title: 'Child Epic',
        description: 'Child description',
        statusId: 's1',
        version: 1,
        parentId: 'parent-1',
        agentId: 'agent-1',
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const agents = [
        { id: 'agent-1', projectId: 'project-1', profileId: 'p1', name: 'Alpha' },
        { id: 'agent-2', projectId: 'project-1', profileId: 'p1', name: 'Bravo' },
      ];
      const statuses = [
        { id: 's1', projectId: 'project-1', label: 'Todo', color: '#ccc', position: 0 },
        { id: 's2', projectId: 'project-1', label: 'In Progress', color: '#888', position: 1 },
      ];
      putCalls = [];

      global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('/api/statuses')) {
          return { ok: true, json: async () => ({ items: statuses }) } as Response;
        }
        if (url.startsWith('/api/agents')) {
          return { ok: true, json: async () => ({ items: agents }) } as Response;
        }
        if (url.startsWith('/api/epics?projectId=')) {
          return { ok: true, json: async () => ({ items: [parentEpic] }) } as Response;
        }
        if (url.startsWith('/api/epics?parentId=')) {
          return { ok: true, json: async () => ({ items: [subEpic] }) } as Response;
        }
        if (url.endsWith('/sub-epics/counts')) {
          return { ok: true, json: async () => ({ s1: 1, s2: 0 }) } as Response;
        }
        if (url === '/api/epics/bulk-update' && init?.method === 'POST') {
          const parsedBody = init.body ? JSON.parse(init.body as string) : {};
          putCalls.push({ url, body: parsedBody });
          return {
            ok: true,
            json: async () =>
              parsedBody.updates.map(
                ({
                  id,
                  statusId,
                  agentId,
                }: {
                  id: string;
                  statusId?: string;
                  agentId?: string | null;
                }) => ({
                  ...subEpic,
                  id,
                  statusId: statusId ?? subEpic.statusId,
                  agentId: agentId ?? subEpic.agentId,
                }),
              ),
          } as Response;
        }
        return { ok: true, json: async () => ({}) } as Response;
      }) as unknown as typeof fetch;
    });

    afterEach(() => {
      if (originalFetch) {
        global.fetch = originalFetch;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as unknown as { fetch?: any }).fetch?.mockClear?.();
    });

    it('shows parent-only bulk icon and updates sub-epic via modal', async () => {
      render(<BoardPage />, { wrapper: Wrapper });

      // Card renders with parent epic
      await waitFor(() => expect(screen.getByText('Parent Epic')).toBeInTheDocument());

      const bulkButton = screen.getByLabelText(/Bulk edit parent and sub-epics/i);
      expect(bulkButton).toBeInTheDocument();

      fireEvent.click(bulkButton);

      await waitFor(() =>
        expect(screen.getByText(/Bulk edit parent & sub-epics/i)).toBeInTheDocument(),
      );
      await waitFor(() => expect(screen.getByTestId('bulk-row-parent-1')).toBeInTheDocument());
      expect(screen.getByTestId('bulk-row-child-1')).toBeInTheDocument();

      // Change Child Epic status to s2
      const childRow = within(screen.getByTestId('bulk-row-child-1'));
      const statusTrigger = childRow.getByRole('combobox', { name: /status/i });
      fireEvent.click(statusTrigger);
      const statusOptions = screen.getAllByText('In Progress');
      fireEvent.click(statusOptions[statusOptions.length - 1]);

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      await waitFor(() => expect(saveButton).not.toBeDisabled());
      fireEvent.click(saveButton);

      await waitFor(() => expect(screen.queryByText(/Bulk edit parent & sub-epics/i)).toBeNull());

      expect(putCalls.length).toBe(1);
      expect(putCalls[0].url).toBe('/api/epics/bulk-update');
      expect(putCalls[0].body).toMatchObject({
        updates: [
          {
            id: 'child-1',
            statusId: 's2',
            version: 1,
          },
        ],
      });
    });
  });
});

describe('BoardPage.external-nav', () => {
  function zeroConnectionItems() {
    return {
      items: [
        { provider: 'clickup', connected: false, generation: null, updatedAt: null },
        { provider: 'jira', connected: false, generation: null, updatedAt: null },
      ],
    };
  }

  function renderBoardRoute({
    integrationAdmission,
  }: {
    integrationAdmission: { allowed: boolean; reason: string | null };
  }) {
    mockSelectedProject = null;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/runtime')) {
        return {
          ok: true,
          json: async () => ({
            mode: 'normal',
            version: 'test',
            dockerAvailable: false,
            integrationAdmission,
          }),
        } as Response;
      }
      if (url.startsWith('/api/integrations/connections')) {
        return { ok: true, json: async () => zeroConnectionItems() } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as jest.Mock;

    return render(
      <QueryClientProvider client={queryClient}>
        <RuntimeProvider>
          <MemoryRouter initialEntries={['/board']}>
            <Routes>
              <Route path="/board" element={<BoardPage />} />
              <Route path="/board/:providerName" element={<div data-testid="my-work-route" />} />
            </Routes>
          </MemoryRouter>
        </RuntimeProvider>
      </QueryClientProvider>,
    );
  }

  describe('BoardPage external navigation composition', () => {
    it('renders DevChain, hides disconnected provider tabs, and keeps Add board with the native view', async () => {
      renderBoardRoute({
        integrationAdmission: { allowed: true, reason: null },
      });

      const nav = await screen.findByRole('navigation', { name: 'Board source' });
      expect(nav).toBeInTheDocument();

      screen.getByRole('link', { name: 'DevChain' });

      expect(await screen.findByRole('button', { name: /add board/i })).toBeInTheDocument();

      // The native view renders below the navigation (no project selected
      // renders its own no-project state).
      expect(screen.getByRole('heading', { name: 'Epic Board' })).toBeInTheDocument();
      expect(
        screen.getByText('Select a project from the header to view its Kanban board.'),
      ).toBeInTheDocument();
      expect(screen.getByText('No Project Selected')).toBeInTheDocument();
    });
  });
});
