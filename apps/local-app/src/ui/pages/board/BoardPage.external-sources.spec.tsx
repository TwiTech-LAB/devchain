import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuntimeProvider } from '@/ui/hooks/useRuntime';

// Layer: page integration. The board data hooks are stubbed at the fetch
// boundary so this spec owns the controller's batch-source wiring and the
// Epic-navigation return state: ID derivation before filters, request
// gating, cache suppression, and the exact Board URL seeded into history
// state when a card opens or edits an Epic.
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
  runtimeInfo: null,
  fetchRuntime: jest.fn(),
};

jest.mock('@/ui/hooks/useRuntime', () => {
  const Actual = jest.requireActual('@/ui/hooks/useRuntime');
  return {
    ...Actual,
    useRuntime: () => runtimeAllowed,
  };
});

// Inspects what the real Board controller put into history state when it
// navigated to the Epic route — the Epic window's only validated close
// target is this exact native Board URL.
function EpicStateProbe() {
  const location = useLocation();
  return (
    <div>
      <span data-testid="epic-probe-path">{`${location.pathname}${location.search}`}</span>
      <span data-testid="epic-probe-state">{JSON.stringify(location.state ?? null)}</span>
    </div>
  );
}

function renderBoard(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <RuntimeProvider>
          <Routes>
            <Route path="/board" element={<BoardPage />} />
            <Route path="/epics/:id" element={<EpicStateProbe />} />
          </Routes>
        </RuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { view, queryClient };
}

describe('BoardPage stored source batch read', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    runtimeAllowed.runtimeInfo = {
      integrationAdmission: { allowed: true, reason: null },
    };
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
        return { ok: true, json: async () => ({ items: [epicFixture('child-1')] }) } as Response;
      }
      if (url.endsWith('/sub-epics/counts')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url === '/api/epics/external-sources/batch') {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                epicId: 'root-1',
                provider: 'jira',
                remoteTaskId: 'ENG-1',
                remoteKey: 'ENG-1',
                title: 'Remote root-1',
                workAreaName: 'Delivery',
                statusName: 'In Progress',
                webUrl: 'https://acme.atlassian.net/browse/ENG-1',
                linkedAt: '2026-08-19T10:00:00.000Z',
              },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function batchCalls(): Array<string | undefined> {
    return fetchMock.mock.calls
      .filter(([url, _init]) => String(url) === '/api/epics/external-sources/batch')
      .map(([_url, init]) => String((init as RequestInit | undefined)?.body));
  }

  it('performs one batch read of the loaded root Epics and renders the source note', async () => {
    renderBoard('/board');

    const link = await screen.findByRole('link', { name: 'Open linked task ENG-1 in DevChain' });
    expect(link).toHaveAttribute('href', '/board/jira/linked/root-1');
    expect(screen.getByText('Imported from Jira ·', { exact: false })).toBeInTheDocument();

    await waitFor(() => expect(batchCalls().length).toBeGreaterThanOrEqual(1));
    const bodies = batchCalls();
    for (const body of bodies) {
      expect(body).toBe(JSON.stringify({ epicIds: ['root-1', 'root-2'] }));
    }
    // Native epic root-2 has no stored source: no note anywhere for it.
    expect(screen.queryByText('Imported from Jira · ENG-2')).not.toBeInTheDocument();
  });

  it('keeps the batch body stable when a status filter changes', async () => {
    const { view } = renderBoard('/board?st=s1');

    await screen.findByRole('link', { name: 'Open linked task ENG-1 in DevChain' });
    // Narrowing to one status column hides root-2 but must not fork the
    // batch: IDs derive before status filters.
    const bodies = batchCalls();
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    for (const body of bodies) {
      expect(body).toBe(JSON.stringify({ epicIds: ['root-1', 'root-2'] }));
    }
    void view;
  });

  it('suppresses the batch and cached notes when admission is off', async () => {
    runtimeAllowed.runtimeInfo = { integrationAdmission: { allowed: false, reason: 'worktree' } };
    const { view } = renderBoard('/board');

    await waitFor(() => expect(screen.getByText('Epic root-1')).toBeInTheDocument());
    // Give any wrongly-enabled query a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(batchCalls()).toEqual([]);
    expect(view.queryByRole('link', { name: /Open linked task/ })).not.toBeInTheDocument();
  });

  it('seeds the exact native Board URL as return state when opening epic details', async () => {
    renderBoard('/board?st=s1&pg=2');

    // Root-epic titles toggle the parent filter; Enter on the card group is
    // the documented open-details path. Waiting for the sourced note first
    // keeps the grabbed node live — the card remounts when its source arrives.
    await screen.findByRole('link', { name: 'Open linked task ENG-1 in DevChain' });
    const card = screen.getByRole('group', { name: /Epic: Epic root-1/ });
    fireEvent.keyDown(card, { key: 'Enter' });

    expect(await screen.findByTestId('epic-probe-path')).toHaveTextContent('/epics/root-1');
    expect(screen.getByTestId('epic-probe-state')).toHaveTextContent(
      JSON.stringify({ boardReturnUrl: '/board?st=s1&pg=2' }),
    );
  });

  it('seeds the same exact Board URL as return state when editing from the list view', async () => {
    renderBoard('/board?v=list&st=s1');

    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));

    expect(await screen.findByTestId('epic-probe-path')).toHaveTextContent('/epics/root-1?edit=1');
    expect(screen.getByTestId('epic-probe-state')).toHaveTextContent(
      JSON.stringify({ boardReturnUrl: '/board?v=list&st=s1' }),
    );
  });
});
