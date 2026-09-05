import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuntimeProvider } from '@/ui/hooks/useRuntime';

// Layer: page integration. The board data hooks are stubbed at the fetch
// boundary so this spec owns the controller's relation-batch wiring: root
// versus parent-filter ID derivation, badge rendering, and the
// decorative-failure contract.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BoardPage: React.ComponentType = require('../BoardPage').BoardPage;

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

jest.mock('socket.io-client', () => ({
  io: () => ({
    on: jest.fn().mockReturnThis(),
    off: jest.fn().mockReturnThis(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function epicFixture(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: 'project-1',
    title: `Epic ${id}`,
    description: null,
    statusId: 's1',
    version: 1,
    parentId: null,
    agentId: null,
    tags: [],
    createdAt: '2026-08-21T10:00:00.000Z',
    updatedAt: '2026-08-21T10:00:00.000Z',
    ...overrides,
  };
}

const runtimeAllowed = {
  runtimeInfo: null as null | { integrationAdmission: { allowed: boolean; reason: string | null } },
  fetchRuntime: jest.fn(),
};

jest.mock('@/ui/hooks/useRuntime', () => {
  const Actual = jest.requireActual('@/ui/hooks/useRuntime');
  return {
    ...Actual,
    useRuntime: () => runtimeAllowed,
  };
});

function renderBoard(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <RuntimeProvider>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
          </Routes>
        </RuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { view, queryClient };
}

type RelationsBatchHandler = () => {
  ok: boolean;
  json: () => Promise<unknown>;
};

describe('BoardPage relation count batch read', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let relationsBatch: RelationsBatchHandler;

  beforeEach(() => {
    runtimeAllowed.runtimeInfo = {
      integrationAdmission: { allowed: true, reason: null },
    };
    relationsBatch = () => ({
      ok: true,
      json: async () => ({ items: [] }),
    });
    fetchMock = jest.fn(async (input: RequestInfo | URL) => {
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
            items: [epicFixture('root-1'), epicFixture('root-2', { statusId: 's2' })],
          }),
        } as Response;
      }
      if (url.startsWith('/api/epics?parentId=')) {
        return {
          ok: true,
          json: async () => ({
            items: [epicFixture('child-1', { parentId: 'root-1' })],
          }),
        } as Response;
      }
      if (url.endsWith('/sub-epics/counts')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url === '/api/epics/relations/batch') {
        return relationsBatch() as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function relationBatchCalls(): Array<string | undefined> {
    return fetchMock.mock.calls
      .filter(([url, _init]) => String(url) === '/api/epics/relations/batch')
      .map(([_url, init]) => String((init as RequestInit | undefined)?.body));
  }

  it('performs one batch read of the loaded root Epics and renders typed badges', async () => {
    relationsBatch = () => ({
      ok: true,
      json: async () => ({
        items: [{ epicId: 'root-1', related: 2, blocks: 0, blockedBy: 1, total: 3 }],
      }),
    });
    renderBoard('/board');

    expect(await screen.findByText('Related 2')).toBeInTheDocument();
    expect(screen.getByText('Blocked by 1')).toBeInTheDocument();
    expect(screen.queryByText(/Blocks /)).not.toBeInTheDocument();
    // root-2 has no relation summary: no badges anywhere for it.
    expect(screen.getByText('Epic root-2')).toBeInTheDocument();

    await waitFor(() => expect(relationBatchCalls().length).toBeGreaterThanOrEqual(1));
    for (const body of relationBatchCalls()) {
      expect(body).toBe(JSON.stringify({ epicIds: ['root-1', 'root-2'] }));
    }
  });

  it('renders directional Related pieces when the batch carries a complete group', async () => {
    relationsBatch = () => ({
      ok: true,
      json: async () => ({
        items: [
          {
            epicId: 'root-1',
            related: 3,
            blocks: 0,
            blockedBy: 1,
            total: 4,
            relatedSources: 1,
            relatedTargets: 1,
            relatedNeutral: 1,
          },
        ],
      }),
    });
    renderBoard('/board');

    // One source, one target, and one legacy neutral piece replace the plain
    // Related total; Blocks and Blocked by stay separate.
    expect(await screen.findByTitle(/Related sources: 1\./)).toBeInTheDocument();
    expect(screen.getByTitle(/Related targets: 1\./)).toBeInTheDocument();
    expect(screen.getByTitle('Related without direction: 1')).toBeInTheDocument();
    expect(screen.getByText('Blocked by 1')).toBeInTheDocument();
    expect(screen.queryByText('Related 3')).not.toBeInTheDocument();
  });

  it('batches the loaded sub-Epics under a parent filter', async () => {
    relationsBatch = () => ({
      ok: true,
      json: async () => ({
        items: [{ epicId: 'child-1', related: 0, blocks: 2, blockedBy: 0, total: 2 }],
      }),
    });
    renderBoard('/board?p=root-1');

    expect(await screen.findByText('Blocks 2')).toBeInTheDocument();

    await waitFor(() => expect(relationBatchCalls().length).toBeGreaterThanOrEqual(1));
    for (const body of relationBatchCalls()) {
      expect(body).toBe(JSON.stringify({ epicIds: ['child-1'] }));
    }
  });

  it('keeps the Board rendered and badge-free when the batch read fails', async () => {
    relationsBatch = () => ({ ok: false, status: 502, json: async () => ({}) });
    renderBoard('/board');

    expect(await screen.findByText('Epic root-1')).toBeInTheDocument();
    expect(screen.getByText('Epic root-2')).toBeInTheDocument();
    await waitFor(() => expect(relationBatchCalls().length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByTestId('epic-relation-badges')).not.toBeInTheDocument();
  });

  it('renders no badges when the batch returns no relation summaries', async () => {
    renderBoard('/board');

    expect(await screen.findByText('Epic root-1')).toBeInTheDocument();
    await waitFor(() => expect(relationBatchCalls().length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByTestId('epic-relation-badges')).not.toBeInTheDocument();
  });
});
