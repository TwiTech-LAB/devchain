import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EpicDetailPage } from './EpicDetailPage';

// Layer: page unit. Transport, routing, toasts, and terminal-window
// dependencies are stubbed because this spec owns the estimated-time card
// wiring: admitted runtimes render the summary from the time-logs endpoint,
// worktree runtimes render no card and send no request.
const fetchMock = jest.fn();

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProject: {
      id: 'project-1',
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

const timeLogsPayload = {
  isRoot: true,
  directMinutes: 30,
  totalMinutes: 90,
  items: [{ activityDate: '2026-08-22', agentId: 'agent-1', agentName: 'Alpha', minutes: 75 }],
  taskItems: [],
};

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
    if (url.startsWith('/api/epics/') && url.includes('/comments')) {
      return jsonResponse({ items: [] });
    }
    if (url.startsWith('/api/preflight')) {
      return jsonResponse({ overall: 'pass', checks: [], providers: [] });
    }
    if (url.startsWith(`/api/epics/${epic.id}/time-logs`)) {
      return jsonResponse(timeLogsPayload);
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

describe('EpicDetailPage estimated-time card', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    worktreeRuntime.runtimeResolved = true;
    worktreeRuntime.apiBase = '';
  });

  it('renders the root summary with inclusive total, direct subtotal, and rows', async () => {
    mockPageFetches(rootEpic());

    renderAt('/epics/epic-1');

    expect(await screen.findByText('Estimated agent time')).toBeInTheDocument();
    expect(screen.getByText('Total (incl. sub-epics)')).toBeInTheDocument();
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
    expect(screen.getByText('Direct')).toBeInTheDocument();
    expect(screen.getByText('30m')).toBeInTheDocument();
    expect(screen.getByText('2026-08-22 · Alpha')).toBeInTheDocument();
    expect(screen.getByText('1h 15m')).toBeInTheDocument();
  });

  it('renders the self-only summary for a sub-epic', async () => {
    mockPageFetches(rootEpic({ id: 'sub-epic-1', title: 'Child Epic', parentId: 'epic-1' }));

    renderAt('/epics/sub-epic-1');

    expect(await screen.findByText('Estimated agent time')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.queryByText('Direct')).not.toBeInTheDocument();
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
    expect(screen.getByText('1h 15m')).toBeInTheDocument();
  });

  it('sends no time request and renders no card in a worktree context', async () => {
    mockPageFetches(rootEpic());
    worktreeRuntime.apiBase = '/wt/demo';

    renderAt('/epics/epic-1');

    await waitFor(() => expect(screen.getByText('Parent Epic')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('epic-time-card')).not.toBeInTheDocument());
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requestedUrls.some((url) => url.includes('time-logs'))).toBe(false);
  });
});
