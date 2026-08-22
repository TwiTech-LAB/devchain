import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuntimeProvider } from '@/ui/hooks/useRuntime';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const BoardPage: React.ComponentType = require('./BoardPage').BoardPage;

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

const mockSocket = {
  on: jest.fn().mockReturnThis(),
  off: jest.fn().mockReturnThis(),
  emit: jest.fn().mockReturnThis(),
  disconnect: jest.fn(),
};
jest.mock('socket.io-client', () => ({ io: () => mockSocket }));

(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
