import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { render, waitFor } from '@testing-library/react';
// Import as ComponentType to avoid strict JSX component typing complaints in isolated TS
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BoardPage: React.ComponentType = require('./BoardPage').BoardPage;

// Mock project selection hook
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

// Minimal socket mock to capture handlers and trigger messages
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

// Aliases for test assertions
const { on, off, disconnect } = mockSocket;

jest.mock('socket.io-client', () => ({
  io: () => mockSocket,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return { Wrapper, queryClient };
}

describe('BoardPage realtime subscription', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
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

    // Sub-epic event with parentId should invalidate parent's sub-counts
    handlers['message']?.forEach((fn) =>
      fn({
        topic: 'project/project-1/epics',
        type: 'updated',
        payload: { epic: { id: 'sub-1', parentId: 'root-1' } },
        ts: new Date().toISOString(),
      }),
    );
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['epics', 'root-1', 'sub-counts'] });
    });
  });

  it('cleans up message listener on unmount without disconnecting socket', async () => {
    const { Wrapper } = createWrapper();
    const { unmount } = render(<BoardPage />, { wrapper: Wrapper });

    // Ensure an on(message) registration happened
    expect(on).toHaveBeenCalledWith('message', expect.any(Function));

    unmount();

    // Verify off(message) was called during cleanup
    expect(off).toHaveBeenCalledWith('message', expect.any(Function));
    // Shared socket should not be disconnected by BoardPage cleanup
    expect(disconnect).not.toHaveBeenCalled();
  });
});
