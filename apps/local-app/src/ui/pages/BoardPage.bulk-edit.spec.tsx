import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const BoardPage = require('./BoardPage').BoardPage as React.ComponentType;

// Mock project selection to make BoardPage appear with a project selected
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
const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
const mockSocket = {
  on: jest.fn(),
  off: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
};

(mockSocket.on as jest.Mock).mockImplementation(
  (event: string, cb: (...args: unknown[]) => unknown) => {
    handlers[event] = handlers[event] || [];
    handlers[event].push(cb);
    return mockSocket;
  },
);
(mockSocket.off as jest.Mock).mockImplementation(
  (event: string, cb: (...args: unknown[]) => unknown) => {
    if (!handlers[event]) return mockSocket;
    handlers[event] = handlers[event].filter((fn) => fn !== cb);
    return mockSocket;
  },
);
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));

// JSDOM lacks ResizeObserver used by Radix
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
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
