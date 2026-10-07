import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { EpicDetailPage } from './EpicDetailPage';

// Layer: page unit. Transport, routing context, toasts, and terminal-window
// dependencies are stubbed at the hook boundary because this spec owns the
// route-window contract: one window shell for every /epics/:id state, the
// two-view switcher admission, terminal coexistence, Escape origin rules,
// and the Board close policy. Router navigation stays real — assertions
// observe routes and location state through probe routes.
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

let canUseIntegrations = true;

jest.mock('@/ui/hooks/useIntegrationAvailability', () => ({
  useIntegrationAvailability: () => ({
    canUseIntegrations,
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
const timeLogsPayload = {
  isRoot: true,
  directMinutes: 30,
  totalMinutes: 90,
  items: [{ activityDate: '2026-08-22', agentId: 'agent-1', agentName: 'Alpha', minutes: 75 }],
  taskItems: [],
};
let pageEpic: typeof epicPayload;
let pageTime = timeLogsPayload;

const epicPayload = {
  id: 'epic-1',
  projectId: 'project-1',
  title: 'Imported Epic',
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
};

const jiraSource = {
  provider: 'jira',
  remoteTaskId: 'ENG-1',
  remoteKey: 'ENG-1',
  title: 'Remote task',
  workAreaName: 'Sprint',
  statusName: 'In Progress',
  webUrl: 'https://acme.atlassian.net/browse/ENG-1',
  linkedAt: '2026-08-01T10:00:00.000Z',
};

type SourcesMode = 'items' | 'empty' | 'error' | 'pending';

let sourcesMode: SourcesMode;
let resolveSources: ((payload: unknown) => void) | undefined;
let epicPending: boolean;
let resolveEpic: ((payload: unknown) => void) | undefined;

function mockPageFetches() {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url === `/api/epics/${pageEpic.id}`) {
      if (epicPending) {
        return new Promise<Response>((resolve) => {
          resolveEpic = (payload: unknown) => resolve(jsonResponse(payload));
        });
      }
      return jsonResponse(pageEpic);
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
    if (url.startsWith(`/api/epics/${pageEpic.id}/relations`)) {
      return jsonResponse(relationsPayload);
    }
    if (url.startsWith(`/api/epics/${pageEpic.id}/time-logs`)) {
      return jsonResponse(pageTime);
    }
    if (url === '/api/epics/epic-1/external-sources') {
      if (sourcesMode === 'error') {
        return { ok: false, json: async () => ({}) } as Response;
      }
      if (sourcesMode === 'pending') {
        return new Promise<Response>((resolve) => {
          resolveSources = (payload: unknown) => resolve(jsonResponse(payload));
        });
      }
      return jsonResponse({ items: sourcesMode === 'items' ? [jiraSource] : [] });
    }
    return jsonResponse({});
  });
}

function BoardProbe() {
  const location = useLocation();
  return (
    <div>
      <span data-testid="board-probe-path">{`${location.pathname}${location.search}`}</span>
    </div>
  );
}

function LinkedRouteProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <div>
      <span data-testid="linked-navigation-type">{navigationType}</span>
      <span data-testid="linked-location-state">{JSON.stringify(location.state ?? null)}</span>
    </div>
  );
}

function renderAt(path: string, state?: unknown, boardFirst = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Object entries keep pathname and search separate, so split before building one.
  const [pathname, search = ''] = path.split('?');
  const entry =
    state === undefined ? path : { pathname, search: search ? `?${search}` : '', state };
  const initialEntries = boardFirst ? ['/board?from=board', entry] : [entry];
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/epics/:id" element={<EpicDetailPage />} />
          <Route path="/epics-missing" element={<EpicDetailPage />} />
          <Route path="/board" element={<BoardProbe />} />
          <Route path="/board/:provider/linked/:epicId" element={<LinkedRouteProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mountBodyTerminal(): HTMLButtonElement {
  const terminal = document.createElement('button');
  terminal.type = 'button';
  terminal.textContent = 'Body terminal';
  document.body.appendChild(terminal);
  return terminal;
}

beforeEach(() => {
  fetchMock.mockReset();
  canUseIntegrations = true;
  sourcesMode = 'items';
  resolveSources = undefined;
  pageEpic = { ...epicPayload };
  pageTime = timeLogsPayload;
  epicPending = false;
  resolveEpic = undefined;
  mockPageFetches();
});

describe('EpicDetailPage route window', () => {
  afterEach(() => {
    window.history.replaceState(null, '');
  });

  it('renders the missing-ID state in the same named route window', () => {
    renderAt('/epics-missing');

    const dialog = screen.getByRole('dialog', { name: 'Epic unavailable' });
    expect(within(dialog).getByText('Epic ID not provided')).toBeInTheDocument();
  });

  it('renders the not-found state in the same named route window', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/epics/epic-1') {
        return { ok: false, json: async () => ({}) } as Response;
      }
      if (url.startsWith('/api/statuses')) return jsonResponse({ items: [] });
      if (url.startsWith('/api/agents')) return jsonResponse({ items: [] });
      if (url.startsWith('/api/sessions')) return jsonResponse([]);
      return jsonResponse({});
    });
    renderAt('/epics/epic-1');

    const dialog = await screen.findByRole('dialog', { name: 'Epic not found' });
    expect(within(dialog).getByText('Not Found')).toBeInTheDocument();
  });

  it('keeps one window shell across loading, loaded, and source-loading states', async () => {
    epicPending = true;
    sourcesMode = 'pending';
    renderAt('/epics/epic-1');

    const loadingDialog = await screen.findByRole('dialog', { name: 'Loading epic' });
    expect(within(loadingDialog).getByText('Loading epic…')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Task view' })).not.toBeInTheDocument();

    await act(async () => {
      resolveEpic?.(epicPayload);
    });
    const loadedDialog = await screen.findByRole('dialog', { name: 'Imported Epic' });
    expect(loadedDialog).toBe(loadingDialog);
    expect(within(loadedDialog).getByRole('button', { name: 'Imported Epic' })).toBeInTheDocument();
    // Source loading never controls the shell: the window and its content
    // are already present while the source request is still pending.
    expect(screen.queryByRole('navigation', { name: 'Task view' })).not.toBeInTheDocument();

    await act(async () => {
      resolveSources?.({ items: [jiraSource] });
    });
    expect(screen.getByRole('dialog')).toBe(loadedDialog);
    await screen.findByRole('navigation', { name: 'Task view' });
  });

  it('shows the switcher with DevChain active and the provider linked route', async () => {
    const { baseElement } = renderAt('/epics/epic-1', { boardReturnUrl: '/board?st=s1' });

    const nav = await screen.findByRole('navigation', { name: 'Task view' });
    const devChainLink = within(nav).getByRole('link', { name: 'DevChain' });
    const providerLink = within(nav).getByRole('link', { name: 'Jira' });
    expect(devChainLink).toHaveAttribute('aria-current', 'page');
    expect(providerLink).toHaveAttribute('href', '/board/jira/linked/epic-1');
    expect(providerLink).not.toHaveAttribute('aria-current');
    expect(await axe(baseElement)).toHaveNoViolations();

    {
      await screen.findByRole('dialog', { name: 'Imported Epic' });
      fireEvent.click(screen.getByRole('link', { name: 'Jira' }));
      expect(screen.getByTestId('linked-navigation-type')).toHaveTextContent('REPLACE');
      expect(screen.getByTestId('linked-location-state')).toHaveTextContent(
        JSON.stringify({ boardReturnUrl: '/board?st=s1' }),
      );
    }
  });

  it('forwards no state to the linked route when the return URL does not validate', async () => {
    renderAt('/epics/epic-1', { boardReturnUrl: '/epics/other' });
    await screen.findByRole('dialog', { name: 'Imported Epic' });

    fireEvent.click(screen.getByRole('link', { name: 'Jira' }));

    expect(screen.getByTestId('linked-location-state')).toHaveTextContent('null');
  });

  it('renders no switcher for unsourced, source-error, and integration-denied Epics', async () => {
    sourcesMode = 'empty';
    const unsourced = renderAt('/epics/epic-1');
    await screen.findByRole('dialog', { name: 'Imported Epic' });
    expect(screen.queryByRole('navigation', { name: 'Task view' })).not.toBeInTheDocument();
    unsourced.unmount();

    sourcesMode = 'error';
    const errored = renderAt('/epics/epic-1');
    await screen.findByRole('dialog', { name: 'Imported Epic' });
    expect(screen.queryByRole('navigation', { name: 'Task view' })).not.toBeInTheDocument();
    errored.unmount();

    canUseIntegrations = false;
    const denied = renderAt('/epics/epic-1');
    await screen.findByRole('dialog', { name: 'Imported Epic' });
    expect(screen.queryByRole('navigation', { name: 'Task view' })).not.toBeInTheDocument();
    denied.unmount();
  });

  it('keeps the window open for outside pointer, focus, and Escape from a body terminal', async () => {
    const terminal = mountBodyTerminal();
    renderAt('/epics/epic-1', { boardReturnUrl: '/board?st=s1' });
    await screen.findByRole('dialog', { name: 'Imported Epic' });

    expect(terminal.hasAttribute('aria-hidden')).toBe(false);

    // Radix attaches its document-level outside-pointer listener on the next
    // macrotask after mount.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.pointerDown(terminal);
    terminal.dispatchEvent(new Event('focusin', { bubbles: true }));
    fireEvent.keyDown(terminal, { key: 'Escape' });

    expect(screen.getByRole('dialog', { name: 'Imported Epic' })).toBeInTheDocument();
    expect(screen.queryByTestId('board-probe-path')).not.toBeInTheDocument();
    terminal.remove();
  });

  it.each([
    {
      name: 'validated Board URL',
      state: { boardReturnUrl: '/board?st=s1&v=list&pg=2' },
      history: false,
      path: '/board?st=s1&v=list&pg=2',
    },
    { name: 'in-app history', state: undefined, history: true, path: '/board?from=board' },
    { name: 'direct deep link', state: undefined, history: false, path: '/board' },
  ])('closes on Escape using $name', async ({ state, history, path }) => {
    if (history) window.history.replaceState({ idx: 2 }, '');
    renderAt('/epics/epic-1', state, history);
    const description = await screen.findByPlaceholderText('Add a description');
    description.focus();
    fireEvent.keyDown(description, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('board-probe-path')).toHaveTextContent(path));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    if (!history) await waitFor(() => expect(document.activeElement).toBe(document.body));
  });

  it('cancels title editing on Escape without closing the window', async () => {
    const user = userEvent.setup();
    renderAt('/epics/epic-1', { boardReturnUrl: '/board?st=s1' });

    await user.click(await screen.findByRole('button', { name: 'Imported Epic' }));

    const input = await screen.findByDisplayValue('Imported Epic');
    expect(input).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.getByRole('dialog', { name: 'Imported Epic' })).toBeInTheDocument();
    expect(screen.queryByTestId('board-probe-path')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Imported Epic' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Imported Epic')).not.toBeInTheDocument();
  });
});

describe('EpicDetailPage card endpoint wiring', () => {
  it.each([false, true])('passes the focal Epic to both cards (sub-epic: %s)', async (isChild) => {
    pageEpic = {
      ...epicPayload,
      id: isChild ? 'sub-epic-1' : 'epic-1',
      parentId: isChild ? 'epic-1' : null,
    } as typeof epicPayload;
    pageTime = { ...timeLogsPayload, isRoot: !isChild, directMinutes: isChild ? 90 : 30 };
    mockPageFetches();
    renderAt('/epics/' + pageEpic.id);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/epics/' + pageEpic.id + '/relations?limit=20&offset=0',
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/epics/' +
          pageEpic.id +
          '/time-logs?timeZone=' +
          encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone),
        expect.anything(),
      ),
    );
  });
});
