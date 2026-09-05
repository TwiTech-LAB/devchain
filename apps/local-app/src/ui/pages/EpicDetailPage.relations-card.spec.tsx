import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EpicDetailPage } from './EpicDetailPage';

// Layer: page unit. Transport, routing, toasts, and terminal-window
// dependencies are stubbed because this spec owns the relations card wiring:
// the detail page mounts the grouped focal-relative relation surface backed by
// the relation REST resources.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProject: {
      id: 'project-1',
      workspaceId: 'ws-1',
      name: 'Demo Project',
      rootPath: '/workspace/project',
    },
  }),
}));

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/ui/hooks/useIntegrationAvailability', () => ({
  useIntegrationAvailability: () => ({
    canUseIntegrations: true,
    runtimeResolved: true,
    reason: null,
  }),
}));

jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => jest.fn(),
}));

jest.mock('@/ui/components/skills/SkillDetailDrawer', () => ({
  SkillDetailDrawer: () => null,
}));

jest.mock('@/ui/components/shared/SubEpicsBoard', () => ({
  SubEpicsBoard: () => null,
}));

jest.mock('@/ui/components/shared/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

const worktreeRuntime = {
  activeWorktree: null,
  setActiveWorktree: () => undefined,
  apiBase: '',
  worktrees: [],
  worktreesLoading: false,
  runtimeResolved: true,
};

jest.mock('@/ui/hooks/useWorktreeTab', () => ({
  useOptionalWorktreeTab: () => worktreeRuntime,
}));

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data } as Response;
}

const relationsPayload = {
  items: [
    {
      relationId: 'rel-1',
      type: 'related',
      relatedEpic: {
        id: '11111111-1111-1111-1111-111111111111',
        shortId: '11111111',
        title: 'Design API',
        status: { id: 'status-1', label: 'In Progress', color: '#2563eb' },
        project: { id: 'project-1', name: 'Demo Project' },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      relationId: 'rel-2',
      type: 'blocked_by',
      relatedEpic: {
        id: '22222222-2222-2222-2222-222222222222',
        shortId: '22222222',
        title: 'Ship CLI',
        status: { id: 'status-1', label: 'In Progress', color: '#2563eb' },
        project: { id: 'project-2', name: 'Other Project' },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  total: 2,
  limit: 20,
  offset: 0,
};

function rootEpic(overrides: Record<string, unknown> = {}) {
  return {
    id: 'epic-1',
    projectId: 'project-1',
    title: 'Parent Epic',
    description: null,
    statusId: 'status-1',
    version: 1,
    parentId: null,
    agentId: null,
    createdBy: null,
    tags: [],
    skillsRequired: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function mockPageFetches(epic: Record<string, unknown>) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url === `/api/epics/${epic.id}`) {
      return jsonResponse(epic);
    }
    if (url.startsWith('/api/statuses')) {
      return jsonResponse({ items: [] });
    }
    if (url.startsWith('/api/agents')) {
      return jsonResponse({ items: [] });
    }
    if (url.startsWith('/api/sessions')) {
      return jsonResponse([]);
    }
    if (url.startsWith('/api/epics?parentId=')) {
      return jsonResponse({ items: [] });
    }
    if (url.startsWith(`/api/epics/${epic.id}/relations`)) {
      return jsonResponse(relationsPayload);
    }
    if (url.startsWith('/api/epics/') && url.includes('/comments')) {
      return jsonResponse({ items: [] });
    }
    if (url.startsWith('/api/preflight')) {
      return jsonResponse({ overall: 'pass', checks: [], providers: [] });
    }
    return jsonResponse({});
  });
}

function renderAt(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/epics/:id" element={<EpicDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EpicDetailPage relations card', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    worktreeRuntime.runtimeResolved = true;
    worktreeRuntime.apiBase = '';
  });

  it('renders grouped focal-relative relations from the relations endpoint', async () => {
    mockPageFetches(rootEpic());

    renderAt('/epics/epic-1');

    expect(await screen.findByText('Relations (2)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Related (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Blocked by (1)' })).toBeInTheDocument();
    expect(screen.getByText('Design API')).toBeInTheDocument();
    expect(screen.getByText('Ship CLI')).toBeInTheDocument();
    expect(screen.getByText('Other Project')).toBeInTheDocument();
    expect(screen.getByText('22222222')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/epics/epic-1/relations?limit=20&offset=0',
      expect.anything(),
    );
  });

  it('renders the relations card for sub-epics as well', async () => {
    mockPageFetches(rootEpic({ id: 'sub-epic-1', title: 'Child Epic', parentId: 'epic-1' }));

    renderAt('/epics/sub-epic-1');

    expect(await screen.findByText('Relations (2)')).toBeInTheDocument();
    expect(screen.getAllByText('Child Epic').length).toBeGreaterThan(0);
  });
});
