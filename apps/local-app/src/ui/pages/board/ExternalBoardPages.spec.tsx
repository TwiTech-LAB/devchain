import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ExternalBoardMyWorkPage } from './ExternalBoardMyWorkPage';
import { ExternalBoardKanbanPage } from './ExternalBoardKanbanPage';
import type { ExternalMyWorkLanding } from '@/ui/hooks/board/useExternalMyWorkLanding';

// Layer: UI component unit. The connection and landing-controller hooks are mocked
// because this spec owns the route-page composition contract (states, toolbar wiring,
// navigation); both hooks have their own suites.
const useIntegrationConnectionsMock = jest.fn();
const useExternalMyWorkLandingMock = jest.fn();
const useExternalWorkAreaMock = jest.fn();
const useExternalTaskLinksMock = jest.fn();
const useFetchFactoryMock = jest.fn();

jest.mock('../../hooks/useIntegrationAvailability', () => ({
  useIntegrationAvailability: () => ({
    canUseIntegrations: true,
    runtimeResolved: true,
    reason: null,
  }),
}));

jest.mock('../../hooks/useIntegrationConnections', () => ({
  useIntegrationConnections: () => useIntegrationConnectionsMock(),
}));

jest.mock('../../hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: mockSelectedProject.id }),
}));

jest.mock('../../hooks/useFetchFactory', () => ({
  useFetchFactory: () => useFetchFactoryMock(),
}));

jest.mock('../../hooks/board/useExternalMyWorkLanding', () => ({
  useExternalMyWorkLanding: (provider: 'clickup' | 'jira') =>
    useExternalMyWorkLandingMock(provider),
}));

jest.mock('../../hooks/board/useExternalWorkArea', () => ({
  useExternalWorkArea: (
    provider: 'clickup' | 'jira',
    workAreaId: string,
    options: { includeCompleted: boolean },
  ) => useExternalWorkAreaMock(provider, workAreaId, options),
}));

// Retained resolver handle: jest.mock factories may only reference variables
// prefixed with "mock". Radix invokes onCloseAutoFocus after onOpenChange(false)
// and the resulting rerender, so tests replay that exact ordering.
const mockRetainedDialogFocus: { resolver: (() => HTMLElement | null) | null } = {
  resolver: null,
};

// Mirrors the mock above for the Import dialog; also records the last props
// the page passed so wiring assertions stay behavior-level.
const mockRetainedImportFocus: { resolver: (() => HTMLElement | null) | null } = {
  resolver: null,
};
const mockImportProps: { initialProjectId: string | undefined } = { initialProjectId: undefined };
const mockSelectedProject: { id: string | undefined } = { id: undefined };

jest.mock('../../components/board/ExternalTaskDetailDialog', () => ({
  ExternalTaskDetailDialog: ({
    open,
    taskId,
    onOpenChange,
    onCreateDevChainTask,
    returnFocusTo,
    onImportFocusTargetReady,
  }: {
    open: boolean;
    taskId: string | null;
    onOpenChange: (open: boolean) => void;
    onCreateDevChainTask?: (detail: unknown) => void;
    returnFocusTo?: () => HTMLElement | null;
    onImportFocusTargetReady?: (resolve: (() => HTMLElement | null) | null) => void;
  }) => {
    mockRetainedDialogFocus.resolver = returnFocusTo ?? null;
    return open ? (
      <aside>
        Task dialog {taskId}
        <button
          type="button"
          onClick={() => {
            onImportFocusTargetReady?.(() => document.body);
            onCreateDevChainTask?.({ remoteId: taskId });
          }}
        >
          Create DevChain task
        </button>
        {/* Mirrors the Radix lifecycle: open-state change first; the test then
            invokes the retained resolver as onCloseAutoFocus would. */}
        <button type="button" onClick={() => onOpenChange(false)}>
          Simulate dialog close
        </button>
      </aside>
    ) : null;
  },
}));

jest.mock('../../components/board/ExternalTaskImportDialog', () => ({
  ExternalTaskImportDialog: ({
    open,
    onOpenChange,
    initialProjectId,
    returnFocusTo,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialProjectId?: string;
    returnFocusTo?: () => HTMLElement | null;
  }) => {
    mockImportProps.initialProjectId = initialProjectId;
    mockRetainedImportFocus.resolver = returnFocusTo ?? null;
    return open ? (
      <aside>
        Import dialog
        <button type="button" onClick={() => onOpenChange(false)}>
          Close import
        </button>
      </aside>
    ) : null;
  },
}));

jest.mock('../../hooks/board/useExternalTaskLinks', () => ({
  useExternalTaskLinks: (...args: unknown[]) => useExternalTaskLinksMock(...args),
}));

const useExternalTaskMoveMock = jest.fn();

// Only the hook is stubbed; the module's pure move rules stay real so the page
// is asserted against the same eligibility logic production uses.
jest.mock('../../hooks/board/useExternalTaskMove', () => ({
  ...jest.requireActual('../../hooks/board/useExternalTaskMove'),
  useExternalTaskMove: (...args: unknown[]) => useExternalTaskMoveMock(...args),
}));

function moveControllerValue(overrides: Record<string, unknown> = {}) {
  return {
    dragSource: null,
    startDrag: jest.fn(),
    endDrag: jest.fn(),
    pendingTaskId: null,
    isMovePending: false,
    announcement: null,
    choice: null,
    isChoiceResolving: false,
    settledMove: null,
    requestMove: jest.fn(),
    resolveChoice: jest.fn(),
    cancelChoice: jest.fn(),
    notifyBoundary: jest.fn(),
    ...overrides,
  };
}

function baseConnectionsValue(connections: unknown[] = []) {
  return {
    connections,
    isLoading: false,
    error: null,
    replaceConnection: jest.fn(),
    disconnectConnection: jest.fn(),
    replacingProvider: undefined,
    disconnectingProvider: undefined,
  };
}

function landingValue(overrides: Partial<ExternalMyWorkLanding> = {}): ExternalMyWorkLanding {
  return {
    status: 'ready',
    cards: [],
    visibleCardCount: 0,
    search: '',
    setSearch: jest.fn(),
    includeCompleted: false,
    toggleIncludeCompleted: jest.fn(),
    isRefreshing: false,
    isStale: false,
    error: null,
    refreshedAt: null,
    refresh: jest.fn(),
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="current-location">{`${location.pathname}${location.search}`}</div>;
}

// The kanban page reads the shared query client for the quick-import detail
// fetch, so every kanban-page render needs a provider.
let pageQueryClient: QueryClient;

function withPageQueryClient(node: ReactNode): ReactNode {
  return <QueryClientProvider client={pageQueryClient}>{node}</QueryClientProvider>;
}

function freshPageQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

beforeEach(() => {
  pageQueryClient = freshPageQueryClient();
  mockSelectedProject.id = undefined;
  mockImportProps.initialProjectId = undefined;
  mockRetainedImportFocus.resolver = null;
  useExternalTaskLinksMock.mockReset();
  useExternalTaskLinksMock.mockReturnValue({
    data: { items: [] },
    isFetching: false,
    isError: false,
  });
  useFetchFactoryMock.mockReset();
  useFetchFactoryMock.mockImplementation(() =>
    Promise.resolve({ ok: true, json: async () => ({}) }),
  );
});

afterEach(() => {
  pageQueryClient.clear();
  pageQueryClient = freshPageQueryClient();
});

const sampleCard = {
  key: 'team-1:list-1',
  remoteId: 'list-1',
  scopeKey: 'team-1',
  name: 'Sprint board',
  kindLabel: 'List',
  description: 'Current sprint work',
  assignedTaskCount: 3,
  locationLabel: 'Workspace / Product',
  workflowSummary: 'To do → Doing',
  refreshState: 'fresh' as const,
};

function renderMyWork(provider: 'clickup' | 'jira') {
  return render(
    <MemoryRouter initialEntries={[`/board/${provider}`]}>
      <Routes>
        <Route
          path="/board/:providerName"
          element={<ExternalBoardMyWorkPage provider={provider} />}
        />
        <Route
          path="/board/:providerName/:workAreaId"
          element={<div data-testid="work-area-route" />}
        />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function renderKanbanAt(path: string) {
  return render(
    withPageQueryClient(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
          <Route path="/epics/:id" element={<div data-testid="epic-route" />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}

describe('ExternalBoardMyWorkPage', () => {
  beforeEach(() => {
    useIntegrationConnectionsMock.mockReset();
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalMyWorkLandingMock.mockReset();
    useExternalMyWorkLandingMock.mockReturnValue(landingValue());
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the provider My Work heading with the board source nav', () => {
    renderMyWork('clickup');

    expect(screen.getByRole('heading', { name: 'ClickUp My Work' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Board source' })).toBeInTheDocument();
  });

  it('renders the Jira My Work heading for the jira route', () => {
    renderMyWork('jira');

    expect(screen.getByRole('heading', { name: 'Jira My Work' })).toBeInTheDocument();
  });

  it('shows the Settings connect hint when the provider is disconnected', () => {
    useExternalMyWorkLandingMock.mockReturnValue(landingValue({ status: 'disconnected' }));

    renderMyWork('clickup');

    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute(
      'href',
      '/settings?section=integrations',
    );
    expect(screen.getByText(/connect clickup in/i)).toBeInTheDocument();
  });

  it('renders the skeleton while the landing loads', () => {
    useExternalMyWorkLandingMock.mockReturnValue(landingValue({ status: 'loading' }));

    const { container } = renderMyWork('clickup');

    expect(screen.queryByText(/connect clickup in/i)).not.toBeInTheDocument();
    const skeletons = container.querySelectorAll('.animate-pulse, [class*="animate-pulse"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows an actionable retry state on first-load failure', () => {
    const refresh = jest.fn();
    useExternalMyWorkLandingMock.mockReturnValue(
      landingValue({
        status: 'error',
        error: new Error('ClickUp is down.'),
        refresh,
      }),
    );

    renderMyWork('clickup');

    expect(screen.getByText('Assigned work unavailable')).toBeInTheDocument();
    expect(screen.getByText('ClickUp is down.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps cards visible with a stale warning when a refetch fails', () => {
    useExternalMyWorkLandingMock.mockReturnValue(
      landingValue({
        status: 'ready',
        isStale: true,
        error: new Error('Refresh failed.'),
        cards: [sampleCard],
        visibleCardCount: 1,
        refreshedAt: '2026-08-19T00:00:00.000Z',
      }),
    );

    renderMyWork('clickup');

    expect(screen.getByText('Showing previous data')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sprint board/i })).toBeInTheDocument();
  });

  it('wires the search box, completed control, and refresh to the controller', async () => {
    const user = userEvent.setup();
    const setSearch = jest.fn();
    const toggleIncludeCompleted = jest.fn();
    const refresh = jest.fn();
    useExternalMyWorkLandingMock.mockReturnValue(
      landingValue({
        cards: [sampleCard],
        visibleCardCount: 1,
        setSearch,
        toggleIncludeCompleted,
        refresh,
      }),
    );

    renderMyWork('clickup');

    await user.type(screen.getByRole('searchbox', { name: 'Search work areas' }), 'sp');
    expect(setSearch).toHaveBeenLastCalledWith('p');

    await user.click(screen.getByRole('checkbox', { name: /include completed/i }));
    expect(toggleIncludeCompleted).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /refresh/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('navigates to the work-area route on card selection', async () => {
    const user = userEvent.setup();
    useExternalMyWorkLandingMock.mockReturnValue(
      landingValue({ cards: [sampleCard], visibleCardCount: 1 }),
    );

    renderMyWork('clickup');

    await user.click(screen.getByRole('button', { name: /sprint board/i }));

    expect(screen.getByTestId('current-location')).toHaveTextContent('/board/clickup/list-1');
    expect(screen.getByTestId('work-area-route')).toBeInTheDocument();
  });

  it('shows the empty state when the provider has no work areas', () => {
    useExternalMyWorkLandingMock.mockReturnValue(landingValue({ status: 'empty' }));

    renderMyWork('clickup');

    expect(screen.getByText('No assigned work')).toBeInTheDocument();
  });

  it('notes an unsupported provider capability', () => {
    useExternalMyWorkLandingMock.mockReturnValue(landingValue({ status: 'unsupported' }));

    renderMyWork('clickup');

    expect(screen.getByText(/does not support my work yet/i)).toBeInTheDocument();
  });
});

describe('ExternalBoardKanbanPage', () => {
  beforeEach(() => {
    useIntegrationConnectionsMock.mockReset();
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalWorkAreaMock.mockReset();
    useExternalTaskMoveMock.mockReset();
    useExternalTaskMoveMock.mockReturnValue(moveControllerValue());
    useExternalWorkAreaMock.mockReturnValue({
      data: {
        workArea: {
          remoteId: 'space-901',
          scopeKey: 'workspace-1',
          name: 'Sprint delivery',
          description: 'Current assigned work',
        },
        columns: [
          {
            key: 'open',
            name: 'OPEN',
            color: '#87909e',
            tasks: [
              {
                remoteId: 'task-1',
                title: 'Ship exact board',
                statusName: 'OPEN',
                statusCategory: 'active',
                updatedAt: '2026-08-19T10:00:00.000Z',
                dueAt: null,
                webUrl: null,
              },
            ],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the exact work area with breadcrumbs and opens a task drawer', async () => {
    const user = userEvent.setup();
    renderKanbanAt('/board/clickup/space-901');

    expect(screen.getByRole('heading', { name: 'Sprint delivery' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to ClickUp My Work' })).toHaveAttribute(
      'href',
      '/board/clickup',
    );
    expect(screen.getByRole('heading', { name: 'OPEN' })).toBeInTheDocument();
    expect(screen.getByText('Status:')).toHaveTextContent('Status: OPEN');
    expect(screen.getByRole('navigation', { name: 'Board source' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Open Ship exact board/ }));
    expect(screen.getByText('Task dialog task-1')).toBeInTheDocument();
  });

  it('keeps the task dialog open behind the nested Import dialog', async () => {
    const user = userEvent.setup();
    renderKanbanAt('/board/clickup/space-901');

    await user.click(screen.getByRole('button', { name: /Open Ship exact board/ }));
    await user.click(screen.getByRole('button', { name: 'Create DevChain task' }));

    expect(screen.getByText('Import dialog')).toBeInTheDocument();
    expect(screen.getByText('Task dialog task-1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close import' }));

    expect(screen.queryByText('Import dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Task dialog task-1')).toBeInTheDocument();
  });

  it('returns focus to the current card after a status-driven column move', async () => {
    const user = userEvent.setup();
    const { rerender } = renderKanbanAt('/board/clickup/space-901');

    await user.click(screen.getByRole('button', { name: /Open Ship exact board/ }));

    // Simulate a status change moving the card to another column: same task,
    // remounted card element.
    useExternalWorkAreaMock.mockReturnValue({
      ...useExternalWorkAreaMock.mock.results[0].value,
      data: {
        ...useExternalWorkAreaMock.mock.results[0].value.data,
        columns: [
          { key: 'open', name: 'OPEN', color: '#87909e', tasks: [] },
          {
            key: 'done',
            name: 'DONE',
            color: '#36b37e',
            tasks: [
              {
                remoteId: 'task-1',
                title: 'Ship exact board',
                statusName: 'DONE',
                statusCategory: 'completed',
                updatedAt: '2026-08-19T10:00:00.000Z',
                dueAt: null,
                webUrl: null,
              },
            ],
          },
        ],
      },
    });
    const routes = withPageQueryClient(
      <MemoryRouter initialEntries={['/board/clickup/space-901']}>
        <Routes>
          <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
        </Routes>
      </MemoryRouter>,
    );
    rerender(routes);

    // Radix lifecycle: open state flips first, the page rerenders and the
    // dialog unmounts, then onCloseAutoFocus runs the retained resolver.
    await user.click(screen.getByRole('button', { name: 'Simulate dialog close' }));
    await waitFor(() => expect(screen.queryByText('Task dialog task-1')).not.toBeInTheDocument());
    const resolver = mockRetainedDialogFocus.resolver;
    expect(resolver).toBeInstanceOf(Function);
    act(() => {
      resolver!().focus();
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Open Ship exact board/ })).toHaveFocus(),
    );
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('returns focus to the Kanban region when the card no longer exists', async () => {
    const user = userEvent.setup();
    const { rerender } = renderKanbanAt('/board/clickup/space-901');

    await user.click(screen.getByRole('button', { name: /Open Ship exact board/ }));

    useExternalWorkAreaMock.mockReturnValue({
      ...useExternalWorkAreaMock.mock.results[0].value,
      data: {
        ...useExternalWorkAreaMock.mock.results[0].value.data,
        columns: [{ key: 'open', name: 'OPEN', color: '#87909e', tasks: [] }],
      },
    });
    rerender(
      withPageQueryClient(
        <MemoryRouter initialEntries={['/board/clickup/space-901']}>
          <Routes>
            <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Simulate dialog close' }));
    await waitFor(() => expect(screen.queryByText('Task dialog task-1')).not.toBeInTheDocument());
    const fallbackResolver = mockRetainedDialogFocus.resolver;
    expect(fallbackResolver).toBeInstanceOf(Function);
    act(() => {
      fallbackResolver!().focus();
    });

    await waitFor(() => expect(screen.getByRole('region', { name: 'Task board' })).toHaveFocus());
  });

  it('leaves the Board keyboard-interactive after both dialogs close', async () => {
    const user = userEvent.setup();
    renderKanbanAt('/board/clickup/space-901');

    const card = screen.getByRole('button', { name: /Open Ship exact board/ });
    await user.click(card);
    await user.click(screen.getByRole('button', { name: 'Create DevChain task' }));
    await user.click(screen.getByRole('button', { name: 'Close import' }));
    await user.click(screen.getByRole('button', { name: 'Simulate dialog close' }));

    expect(screen.queryByText('Import dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Task dialog/)).not.toBeInTheDocument();
    // No body lock residue and the card is focusable/activatable again.
    expect(document.body).not.toHaveAttribute('data-scroll-locked');
    card.focus();
    expect(card).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Task dialog task-1')).toBeInTheDocument();
  });

  it('renders an unknown-provider state with a path back to the native board', () => {
    renderKanbanAt('/board/asana/list-1');

    expect(screen.getByRole('heading', { name: 'Unknown board provider' })).toBeInTheDocument();
    const backLink = screen.getByRole('link', { name: /return to the devchain board/i });
    expect(backLink).toHaveAttribute('href', '/board');
  });
});

describe('ExternalBoardKanbanPage move wiring', () => {
  const task = {
    remoteId: 'task-1',
    title: 'Ship exact board',
    statusName: 'OPEN',
    statusCategory: 'active' as const,
    updatedAt: '2026-08-19T10:00:00.000Z',
    dueAt: null,
    webUrl: null,
  };

  function moveBoardResult(workAreaRemoteId = 'space-901') {
    return {
      data: {
        // The builder reports observed-status areas as not workflow ordered;
        // see external-work-area.spec.ts for that derivation.
        workflowOrdered: workAreaRemoteId !== 'other-assigned',
        workArea: {
          remoteId: workAreaRemoteId,
          scopeKey: 'workspace-1',
          name: 'Sprint delivery',
          description: null,
        },
        columns: [
          {
            key: 'open',
            name: 'OPEN',
            color: '#87909e',
            remoteId: 'st-open',
            remoteStatusIds: ['st-open'],
            synthetic: false,
            tasks: [task],
          },
          {
            key: 'done',
            name: 'DONE',
            color: '#36b37e',
            remoteId: 'st-done',
            remoteStatusIds: ['st-done'],
            synthetic: false,
            tasks: [],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
    };
  }

  function renderMoveBoard(
    path: string,
    moveOverrides: Record<string, unknown> = {},
    workAreaRemoteId = 'space-901',
  ) {
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalWorkAreaMock.mockReturnValue(moveBoardResult(workAreaRemoteId));
    useExternalTaskMoveMock.mockReturnValue(moveControllerValue(moveOverrides));
    return render(
      withPageQueryClient(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
            <Route path="/epics/:id" element={<div data-testid="epic-route" />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
  }

  function cardButton() {
    return screen.getByRole('button', { name: /Open Ship exact board/ });
  }

  function columnSection(name: string) {
    return screen.getByRole('heading', { name }).closest('section')!;
  }

  afterEach(() => {
    cleanup();
  });

  it('announces move outcomes through one polite live region', () => {
    renderMoveBoard('/board/clickup/space-901', { announcement: 'Task moved.' });

    expect(screen.getByText('Task moved.')).toHaveAttribute('aria-live', 'polite');
  });

  it('routes a pointer drop through requestMove with the converted target and clears the drag', () => {
    const move = moveControllerValue({
      dragSource: { taskId: 'task-1', columnKey: 'open' },
    });
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalWorkAreaMock.mockReturnValue(moveBoardResult());
    useExternalTaskMoveMock.mockReturnValue(move);
    render(
      withPageQueryClient(
        <MemoryRouter initialEntries={['/board/clickup/space-901']}>
          <Routes>
            <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    fireEvent.dragStart(cardButton().closest('article')!);
    expect(move.startDrag).toHaveBeenCalledWith({ taskId: 'task-1', columnKey: 'open' });

    fireEvent.drop(columnSection('DONE'));
    expect(move.endDrag).toHaveBeenCalledTimes(1);
    expect(move.requestMove).toHaveBeenCalledWith({
      source: { taskId: 'task-1', columnKey: 'open' },
      target: {
        columnKey: 'done',
        name: 'DONE',
        remoteId: 'st-done',
        remoteStatusIds: ['st-done'],
        synthetic: false,
      },
    });
  });

  it('moves with arrow keys to the adjacent column and reports the boundary', () => {
    const move = moveControllerValue();
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalWorkAreaMock.mockReturnValue(moveBoardResult());
    useExternalTaskMoveMock.mockReturnValue(move);
    render(
      withPageQueryClient(
        <MemoryRouter initialEntries={['/board/clickup/space-901']}>
          <Routes>
            <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    const card = cardButton();

    // fireEvent returns false when a handler cancels the event; the arrow key
    // must cancel so the board never scrolls horizontally.
    const right = fireEvent.keyDown(card, { key: 'ArrowRight' });
    expect(right).toBe(false);
    expect(move.requestMove).toHaveBeenCalledWith({
      source: { taskId: 'task-1', columnKey: 'open' },
      target: {
        columnKey: 'done',
        name: 'DONE',
        remoteId: 'st-done',
        remoteStatusIds: ['st-done'],
        synthetic: false,
      },
    });

    fireEvent.keyDown(card, { key: 'ArrowLeft' });
    expect(move.notifyBoundary).toHaveBeenCalledTimes(1);
    expect(move.requestMove).toHaveBeenCalledTimes(1);
  });

  it('excludes arrow movement in the Jira other-assigned area', () => {
    const move = moveControllerValue();
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalWorkAreaMock.mockReturnValue(moveBoardResult('other-assigned'));
    useExternalTaskMoveMock.mockReturnValue(move);
    render(
      withPageQueryClient(
        <MemoryRouter initialEntries={['/board/jira/other-assigned']}>
          <Routes>
            <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    const card = screen.getByRole('button', { name: 'Open Ship exact board' });
    expect(card).not.toHaveAttribute('aria-label', expect.stringContaining('arrow'));

    fireEvent.keyDown(card, { key: 'ArrowRight' });

    expect(move.requestMove).not.toHaveBeenCalled();
    expect(move.notifyBoundary).not.toHaveBeenCalled();
  });

  it('keeps a pending card focusable and inert', () => {
    const move = moveControllerValue({ pendingTaskId: 'task-1' });
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalWorkAreaMock.mockReturnValue(moveBoardResult());
    useExternalTaskMoveMock.mockReturnValue(move);
    render(
      withPageQueryClient(
        <MemoryRouter initialEntries={['/board/clickup/space-901']}>
          <Routes>
            <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    const card = cardButton();

    expect(card).toHaveAttribute('aria-disabled', 'true');
    expect(card).not.toHaveAttribute('disabled');
    fireEvent.click(card);
    expect(screen.queryByText(/Task dialog/)).not.toBeInTheDocument();
  });

  it('opens the accessible choice dialog for multiple transitions and resolves the choice', async () => {
    const user = userEvent.setup();
    const choice = {
      taskId: 'task-1',
      taskTitle: 'Ship exact board',
      source: { taskId: 'task-1', columnKey: 'open' },
      target: {
        columnKey: 'done',
        name: 'DONE',
        remoteId: 'st-done',
        remoteStatusIds: ['st-done'],
        synthetic: false,
      },
      options: [
        {
          actionValue: '31',
          actionLabel: 'Finish',
          remoteId: 'st-done',
          remoteStatusIds: ['st-done'],
          name: 'Done',
          color: '#36b37e',
          category: 'completed' as const,
          position: 0,
        },
      ],
    };
    const move = moveControllerValue({ choice });
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalWorkAreaMock.mockReturnValue(moveBoardResult());
    useExternalTaskMoveMock.mockReturnValue(move);
    render(
      withPageQueryClient(
        <MemoryRouter initialEntries={['/board/clickup/space-901']}>
          <Routes>
            <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    const dialog = screen.getByRole('dialog', { name: 'Choose a move for Ship exact board' });
    expect(dialog).toHaveTextContent('Multiple actions lead to DONE');

    await user.click(screen.getByRole('button', { name: 'Finish (Done)' }));
    expect(move.resolveChoice).toHaveBeenCalledWith(choice.options[0]);
  });

  it('cancels the choice without a write and restores focus to the card', async () => {
    const user = userEvent.setup();
    const choice = {
      taskId: 'task-1',
      taskTitle: 'Ship exact board',
      source: { taskId: 'task-1', columnKey: 'open' },
      target: {
        columnKey: 'done',
        name: 'DONE',
        remoteId: 'st-done',
        remoteStatusIds: ['st-done'],
        synthetic: false,
      },
      options: [
        {
          actionValue: '31',
          actionLabel: 'Finish',
          remoteId: 'st-done',
          remoteStatusIds: ['st-done'],
          name: 'Done',
          color: '#36b37e',
          category: 'completed' as const,
          position: 0,
        },
      ],
    };
    const move = moveControllerValue({ choice });
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalWorkAreaMock.mockReturnValue(moveBoardResult());
    useExternalTaskMoveMock.mockReturnValue(move);
    render(
      withPageQueryClient(
        <MemoryRouter initialEntries={['/board/clickup/space-901']}>
          <Routes>
            <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    await user.keyboard('{Escape}');

    expect(move.cancelChoice).toHaveBeenCalledTimes(1);
    expect(move.resolveChoice).not.toHaveBeenCalled();
  });

  it('focuses the remounted card after a successful move', async () => {
    renderMoveBoard('/board/clickup/space-901', {
      settledMove: { taskId: 'task-1', removed: false, nonce: 1 },
    });

    await waitFor(() => expect(cardButton()).toHaveFocus());
  });

  it('focuses the Board fallback after an active-only completed removal', async () => {
    renderMoveBoard('/board/clickup/space-901', {
      settledMove: { taskId: 'task-1', removed: true, nonce: 1 },
    });

    await waitFor(() => expect(screen.getByRole('region', { name: 'Task board' })).toHaveFocus());
  });
});

describe('ExternalBoardKanbanPage quick import', () => {
  const unlinkedEntry = {
    scopeKey: 'workspace-1',
    taskId: 'task-1',
    linked: false,
    epicId: null,
    projectId: null,
    projectName: null,
  };
  const secondUnlinkedEntry = { ...unlinkedEntry, taskId: 'task-2' };

  function quickDetail(overrides: Partial<ExternalTaskDetail> = {}): ExternalTaskDetail {
    return {
      remoteId: 'task-1',
      remoteKey: 'CU-1',
      title: 'Ship exact board',
      description: null,
      descriptionTruncated: false,
      status: {
        remoteId: 'open',
        name: 'OPEN',
        color: '#87909e',
        category: 'active',
        position: 0,
      },
      dueAt: null,
      priority: null,
      webUrl: 'https://app.clickup.com/t/task-1',
      location: {
        scopeKey: 'workspace-1',
        workAreaId: 'space-901',
        workAreaName: 'Sprint delivery',
      },
      allowedStatuses: [],
      actions: [],
      linkState: { linked: false, epicId: null },
      ...overrides,
    };
  }

  function quickBoardResult() {
    return {
      data: {
        workArea: {
          remoteId: 'space-901',
          scopeKey: 'workspace-1',
          name: 'Sprint delivery',
          description: null,
        },
        columns: [
          {
            key: 'open',
            name: 'OPEN',
            color: '#87909e',
            remoteId: 'st-open',
            remoteStatusIds: ['st-open'],
            synthetic: false,
            tasks: [
              {
                remoteId: 'task-1',
                title: 'Ship exact board',
                statusName: 'OPEN',
                statusCategory: 'active' as const,
                updatedAt: '2026-08-19T10:00:00.000Z',
                dueAt: null,
                webUrl: null,
              },
              {
                remoteId: 'task-2',
                title: 'Second task',
                statusName: 'OPEN',
                statusCategory: 'active' as const,
                updatedAt: '2026-08-19T10:00:00.000Z',
                dueAt: null,
                webUrl: null,
              },
            ],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
    };
  }

  const quickFetch = jest.fn();

  function renderQuickBoard() {
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalWorkAreaMock.mockReturnValue(quickBoardResult());
    useExternalTaskMoveMock.mockReturnValue(moveControllerValue());
    useExternalTaskLinksMock.mockReturnValue({
      data: { items: [unlinkedEntry, secondUnlinkedEntry] },
      isFetching: false,
      isError: false,
    });
    useFetchFactoryMock.mockImplementation(() => quickFetch);
    return renderKanbanAt('/board/clickup/space-901');
  }

  function taskArticle(title: string) {
    const article = screen.getByText(title).closest('article')!;
    return within(article);
  }

  function quickButton(title: string): HTMLElement {
    return taskArticle(title).getByRole('button', { name: 'Create DevChain task' });
  }

  beforeEach(() => {
    quickFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('opens Import directly from an unlinked card with one detail fetch and no comments', async () => {
    quickFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => quickDetail() }),
    );
    renderQuickBoard();

    fireEvent.click(quickButton('Ship exact board'));

    expect(await screen.findByText('Import dialog')).toBeInTheDocument();
    expect(screen.queryByText(/Task dialog/)).not.toBeInTheDocument();
    expect(quickFetch).toHaveBeenCalledTimes(1);
    expect(String(quickFetch.mock.calls[0][0])).toBe(
      '/api/integrations/my-work/clickup/tasks/task-1',
    );
    expect(quickFetch.mock.calls.filter(([url]) => String(url).includes('/comments'))).toHaveLength(
      0,
    );
  });

  it('navigates to the linked Epic when the fresh detail is already linked', async () => {
    quickFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => quickDetail({ linkState: { linked: true, epicId: 'epic-9' } }),
      }),
    );
    renderQuickBoard();

    fireEvent.click(quickButton('Ship exact board'));

    expect(await screen.findByTestId('epic-route')).toBeInTheDocument();
    expect(screen.queryByText('Import dialog')).not.toBeInTheDocument();
  });

  it('blocks repeated and cross-task clicks while one quick fetch is pending', async () => {
    let resolveDetail: (response: unknown) => void = () => {};
    quickFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );
    renderQuickBoard();
    const first = quickButton('Ship exact board');
    const second = quickButton('Second task');

    // Same act batch: the component's pending guard cannot re-render between
    // clicks, so only the page's synchronous latch can block the second call.
    act(() => {
      fireEvent.click(first);
      fireEvent.click(second);
    });
    fireEvent.click(first);

    expect(quickFetch).toHaveBeenCalledTimes(1);

    resolveDetail({ ok: true, json: async () => quickDetail() });
    expect(await screen.findByText('Import dialog')).toBeInTheDocument();
  });

  it('shows a safe error and refocuses the live quick button on fetch failure', async () => {
    quickFetch.mockImplementation(() => Promise.resolve({ ok: false, json: async () => null }));
    renderQuickBoard();
    const button = quickButton('Ship exact board');

    fireEvent.click(button);

    expect(await screen.findByText('Quick import unavailable')).toBeInTheDocument();
    expect(screen.getByText('Task detail could not be loaded.')).toBeInTheDocument();
    await waitFor(() => expect(button).not.toHaveAttribute('aria-disabled'));
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('restores focus to the quick button when a card-origin Import closes', async () => {
    quickFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => quickDetail() }),
    );
    renderQuickBoard();
    const button = quickButton('Ship exact board');

    fireEvent.click(button);
    await screen.findByText('Import dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Close import' }));
    await waitFor(() => expect(screen.queryByText('Import dialog')).not.toBeInTheDocument());

    const resolver = mockRetainedImportFocus.resolver;
    expect(resolver).toBeInstanceOf(Function);
    act(() => {
      resolver!().focus();
    });
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('focuses the Board fallback when the quick button no longer exists on close', async () => {
    quickFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => quickDetail() }),
    );
    const { rerender } = renderQuickBoard();

    fireEvent.click(quickButton('Ship exact board'));
    await screen.findByText('Import dialog');

    useExternalWorkAreaMock.mockReturnValue({
      ...quickBoardResult(),
      data: {
        ...quickBoardResult().data,
        columns: [
          {
            ...quickBoardResult().data.columns[0],
            tasks: [quickBoardResult().data.columns[0].tasks[1]],
          },
        ],
      },
    });
    rerender(
      withPageQueryClient(
        <MemoryRouter initialEntries={['/board/clickup/space-901']}>
          <Routes>
            <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
            <Route path="/epics/:id" element={<div data-testid="epic-route" />} />
          </Routes>
        </MemoryRouter>,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close import' }));
    await waitFor(() => expect(screen.queryByText('Import dialog')).not.toBeInTheDocument());

    const resolver = mockRetainedImportFocus.resolver;
    expect(resolver).toBeInstanceOf(Function);
    act(() => {
      resolver!().focus();
    });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Task board' })).toHaveFocus());
  });

  it('keeps detail-origin import focus on the detail dialog resolver', async () => {
    const user = userEvent.setup();
    quickFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => quickDetail() }),
    );
    renderQuickBoard();

    await user.click(screen.getByRole('button', { name: /Open Ship exact board/ }));
    const detailAside = screen.getByText('Task dialog task-1').closest('aside')!;
    await user.click(within(detailAside).getByRole('button', { name: 'Create DevChain task' }));
    expect(await screen.findByText('Import dialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close import' }));
    await waitFor(() => expect(screen.queryByText('Import dialog')).not.toBeInTheDocument());

    const resolver = mockRetainedImportFocus.resolver;
    expect(resolver).toBeInstanceOf(Function);
    act(() => {
      resolver!().focus();
    });
    // The detail dialog's registered resolver targets document.body; the card
    // quick buttons must not have stolen the origin.
    await waitFor(() => expect(document.body).toHaveFocus());
    expect(
      screen
        .getAllByRole('button', { name: 'Create DevChain task' })
        .every((button) => button !== document.activeElement),
    ).toBe(true);
  });

  it('passes the current selected project to the import dialog', async () => {
    mockSelectedProject.id = 'project-7';
    quickFetch.mockImplementation(() =>
      Promise.resolve({ ok: true, json: async () => quickDetail() }),
    );
    renderQuickBoard();

    fireEvent.click(quickButton('Ship exact board'));

    expect(await screen.findByText('Import dialog')).toBeInTheDocument();
    expect(mockImportProps.initialProjectId).toBe('project-7');
  });
});

describe('External board completed scope through navigation', () => {
  beforeEach(() => {
    useIntegrationConnectionsMock.mockReset();
    useIntegrationConnectionsMock.mockReturnValue(baseConnectionsValue());
    useExternalMyWorkLandingMock.mockReset();
    useExternalWorkAreaMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  const completedOnlyCard = {
    ...sampleCard,
    key: 'team-1:list-done',
    remoteId: 'list-done',
    name: 'Archive list',
    assignedTaskCount: 2,
  };

  function boardResult(overrides: Record<string, unknown> = {}) {
    return {
      data: {
        workArea: {
          remoteId: 'list-done',
          scopeKey: 'team-1',
          name: 'Archive list',
          kind: 'list',
          description: null,
          hierarchy: [],
        },
        columns: [
          {
            key: 'st-done',
            name: 'Done',
            color: '#36b37e',
            tasks: [
              {
                remoteId: 'task-9',
                title: 'Shipped feature',
                statusName: 'Done',
                statusCategory: 'completed',
                updatedAt: '2026-08-19T09:00:00.000Z',
                dueAt: null,
                webUrl: null,
              },
            ],
          },
        ],
        ...overrides,
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: jest.fn(),
    };
  }

  function renderFlow() {
    return render(
      withPageQueryClient(
        <MemoryRouter initialEntries={['/board/clickup']}>
          <Routes>
            <Route
              path="/board/:providerName"
              element={<ExternalBoardMyWorkPage provider="clickup" />}
            />
            <Route path="/board/:provider/:workAreaId" element={<ExternalBoardKanbanPage />} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>,
      ),
    );
  }

  it('carries the completed selection from the landing toggle into the work-area route', async () => {
    const user = userEvent.setup();
    useExternalMyWorkLandingMock.mockReturnValue(
      landingValue({
        cards: [completedOnlyCard, sampleCard],
        visibleCardCount: 2,
        includeCompleted: true,
      }),
    );
    useExternalWorkAreaMock.mockReturnValue(boardResult());

    renderFlow();

    await user.click(screen.getByRole('button', { name: /archive list/i }));

    expect(screen.getByTestId('current-location')).toHaveTextContent(
      '/board/clickup/list-done?completed=1',
    );
    expect(useExternalWorkAreaMock).toHaveBeenCalledWith(
      'clickup',
      'list-done',
      expect.objectContaining({ includeCompleted: true }),
    );
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByText('Shipped feature')).toBeInTheDocument();

    const backLink = screen.getByRole('link', { name: 'Back to ClickUp My Work' });
    expect(backLink).toHaveAttribute('href', '/board/clickup?completed=1');
    const breadcrumb = screen.getByRole('link', { name: 'ClickUp My Work' });
    expect(breadcrumb).toHaveAttribute('href', '/board/clickup?completed=1');
  });

  it('keeps active-only scope on the work-area request when completed is not selected', async () => {
    const user = userEvent.setup();
    useExternalMyWorkLandingMock.mockReturnValue(
      landingValue({ cards: [sampleCard], visibleCardCount: 1, includeCompleted: false }),
    );
    useExternalWorkAreaMock.mockReturnValue(boardResult());

    renderFlow();

    await user.click(screen.getByRole('button', { name: /sprint board/i }));

    expect(screen.getByTestId('current-location')).toHaveTextContent('/board/clickup/list-1');
    expect(useExternalWorkAreaMock).toHaveBeenCalledWith(
      'clickup',
      'list-1',
      expect.objectContaining({ includeCompleted: false }),
    );
  });

  it('preserves the completed scope on a direct work-area load with the param present', () => {
    useExternalWorkAreaMock.mockReturnValue(boardResult());

    renderKanbanAt('/board/clickup/list-done?completed=1');

    expect(useExternalWorkAreaMock).toHaveBeenCalledWith(
      'clickup',
      'list-done',
      expect.objectContaining({ includeCompleted: true }),
    );
    expect(screen.getByRole('heading', { name: 'Archive list' })).toBeInTheDocument();
  });

  it('retains recently completed cards in a mixed work area', () => {
    useExternalWorkAreaMock.mockReturnValue(
      boardResult({
        columns: [
          {
            key: 'st-open',
            name: 'To do',
            color: '#6b778c',
            tasks: [
              {
                remoteId: 'task-1',
                title: 'Active feature',
                statusName: 'To do',
                statusCategory: 'active',
                updatedAt: '2026-08-19T09:00:00.000Z',
                dueAt: null,
                webUrl: null,
              },
            ],
          },
          {
            key: 'st-done',
            name: 'Done',
            color: '#36b37e',
            tasks: [
              {
                remoteId: 'task-9',
                title: 'Shipped feature',
                statusName: 'Done',
                statusCategory: 'completed',
                updatedAt: '2026-08-19T08:00:00.000Z',
                dueAt: null,
                webUrl: null,
              },
            ],
          },
        ],
      }),
    );

    renderKanbanAt('/board/clickup/list-mixed?completed=1');

    expect(screen.getByRole('heading', { name: 'To do' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByText('Active feature')).toBeInTheDocument();
    expect(screen.getByText('Shipped feature')).toBeInTheDocument();
  });
});
