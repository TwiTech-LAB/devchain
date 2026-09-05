import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import type { IntegrationConnectionState } from '@/ui/hooks/useIntegrationConnections';
import {
  boardReturnUrlFromState,
  hasInAppHistoryBack,
  parseBoardReturnUrl,
} from '@/ui/lib/external-board';
import { ExternalLinkedTaskRoute } from './ExternalLinkedTaskPage';

const mockNavigate = jest.fn();
let canUseIntegrations = true;
const useIntegrationConnectionsMock = jest.fn();
const useEpicExternalSourcesMock = jest.fn();
const useLinkedTaskOwnershipMock = jest.fn();
const activateProjectMock = jest.fn();
const mockDialogProps: { last: Record<string, unknown> | null } = { last: null };
const mockSelection: Record<string, unknown> = {
  selectedWorkspaceId: 'workspace-1',
  selectedProjectId: 'project-1',
  selectedProject: { id: 'project-1' },
  projectsLoading: false,
  isWorkspaceSelectionLocked: false,
  projectActivation: null,
  activateProject: activateProjectMock,
};

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useIntegrationAvailability', () => ({
  useIntegrationAvailability: () => ({
    canUseIntegrations,
    runtimeResolved: true,
    reason: null,
  }),
}));

jest.mock('../../hooks/useIntegrationConnections', () => ({
  useIntegrationConnections: (options?: unknown) => useIntegrationConnectionsMock(options),
}));

jest.mock('../../hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockSelection,
}));

jest.mock('../../hooks/board/useLinkedTaskOwnership', () => ({
  useLinkedTaskOwnership: (...args: unknown[]) => useLinkedTaskOwnershipMock(...args),
}));

jest.mock('../../hooks/useEpicExternalSources', () => ({
  useEpicExternalSources: (epicId: string, options?: unknown) =>
    useEpicExternalSourcesMock(epicId, options),
}));

jest.mock('../../components/board/ExternalBoardNav', () => ({
  ExternalBoardNav: () => (
    <nav>
      Board navigation
      <button type="button">Add board</button>
    </nav>
  ),
}));

jest.mock('../../components/board/ExternalTaskDetailDialog', () => ({
  ExternalTaskDetailDialog: (props: {
    onOpenChange: (open: boolean) => void;
    routeWindowNav?: React.ReactNode;
    [key: string]: unknown;
  }) => {
    mockDialogProps.last = props;
    return (
      <aside>
        Task dialog
        {props.routeWindowNav}
        <button type="button" onClick={() => props.onOpenChange(false)}>
          Simulate dialog close
        </button>
      </aside>
    );
  },
}));

function connection(connected: boolean): IntegrationConnectionState {
  return {
    provider: 'jira',
    connected,
    connectionId: connected ? 'conn-1' : null,
    generation: connected ? 1 : null,
    subtaskSyncEnabled: false,
    syncSettingRevision: null,
    updatedAt: connected ? '2026-01-01T00:00:00Z' : null,
  };
}

function source(overrides: Partial<ExternalTaskSourceSummary> = {}): ExternalTaskSourceSummary {
  return {
    provider: 'jira',
    remoteTaskId: 'ENG-1',
    remoteKey: 'ENG-1',
    title: 'Ship the linked workspace',
    workAreaName: 'Sprint board',
    statusName: 'In Progress',
    webUrl: 'https://acme.atlassian.net/browse/ENG-1',
    linkedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function sourcesValue(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
    ...overrides,
  };
}

function ownershipValue(overrides: Record<string, unknown> = {}) {
  return {
    epic: { id: 'epic-1', projectId: 'project-1' },
    project: { id: 'project-1', workspaceId: 'workspace-1', name: 'Product' },
    isLoading: false,
    isError: false,
    error: null,
    refetch: jest.fn(),
    ...overrides,
  };
}

function routeTree(provider = 'jira', epicId = 'epic-1', state?: unknown) {
  return (
    <MemoryRouter
      initialEntries={[
        state === undefined
          ? { pathname: `/board/${provider}/linked/${epicId}` }
          : { pathname: `/board/${provider}/linked/${epicId}`, state },
      ]}
    >
      <Routes>
        <Route path="/board/:provider/linked/:epicId" element={<ExternalLinkedTaskRoute />} />
        <Route path="/board" element={<div data-testid="board-home" />} />
        <Route path="/epics/:epicId" element={<EpicLocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

// Observes what the DevChain switch link actually did: the navigation type
// proves replace versus push, and the rendered state proves exactly which
// history state crossed the switch.
function EpicLocationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <div>
      <span data-testid="epic-navigation-type">{navigationType}</span>
      <span data-testid="epic-location-state">{JSON.stringify(location.state ?? null)}</span>
    </div>
  );
}

function renderRoute(provider = 'jira', epicId = 'epic-1', state?: unknown) {
  return render(routeTree(provider, epicId, state));
}

function expectDevChainSwitch(boardReturnUrl: string): void {
  expect(screen.queryByRole('link', { name: 'Open DevChain task' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'DevChain' }));
  expect(screen.getByTestId('epic-navigation-type')).toHaveTextContent('REPLACE');
  expect(screen.getByTestId('epic-location-state')).toHaveTextContent(
    JSON.stringify({ boardReturnUrl }),
  );
}

describe('ExternalLinkedTaskPage route ownership', () => {
  beforeEach(() => {
    canUseIntegrations = true;
    mockNavigate.mockReset();
    activateProjectMock.mockReset();
    mockDialogProps.last = null;
    Object.assign(mockSelection, {
      selectedWorkspaceId: 'workspace-1',
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1' },
      projectsLoading: false,
      isWorkspaceSelectionLocked: false,
      projectActivation: null,
      activateProject: activateProjectMock,
    });
    useLinkedTaskOwnershipMock.mockReset();
    useLinkedTaskOwnershipMock.mockReturnValue(ownershipValue());
    useIntegrationConnectionsMock.mockReset();
    useIntegrationConnectionsMock.mockReturnValue({
      connections: [connection(true)],
      isLoading: false,
    });
    useEpicExternalSourcesMock.mockReset();
    useEpicExternalSourcesMock.mockReturnValue(sourcesValue({ data: { items: [source()] } }));
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    // Keep the pure history helper isolated: jsdom's window history is shared
    // across tests in this file.
    window.history.replaceState(null, '');
  });

  it('reuses the unknown-provider fallback for an unrecognized provider segment', () => {
    renderRoute('github');
    expect(screen.getByText('Unknown board provider')).toBeInTheDocument();
    expect(useLinkedTaskOwnershipMock).not.toHaveBeenCalled();
  });

  it('does not enable connection or source queries before ownership resolves', () => {
    useLinkedTaskOwnershipMock.mockReturnValue(
      ownershipValue({ epic: undefined, project: undefined, isLoading: true }),
    );
    renderRoute();

    expect(screen.getByText('Resolving the owning DevChain project…')).toBeInTheDocument();
    expect(useIntegrationConnectionsMock).toHaveBeenCalledWith({
      projectId: null,
      enabled: false,
    });
    expect(useEpicExternalSourcesMock).toHaveBeenCalledWith('epic-1', { enabled: false });
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
  });

  it('activates a cross-workspace owner before enabling its connection and detail', () => {
    const owningProject = { id: 'project-2', workspaceId: 'workspace-2', name: 'Platform' };
    useLinkedTaskOwnershipMock.mockReturnValue(
      ownershipValue({
        epic: { id: 'epic-1', projectId: owningProject.id },
        project: owningProject,
      }),
    );
    const view = renderRoute();

    expect(activateProjectMock).toHaveBeenCalledWith(owningProject);
    expect(useIntegrationConnectionsMock).toHaveBeenLastCalledWith({
      projectId: null,
      enabled: false,
    });
    expect(screen.getByText('Activating Platform…')).toBeInTheDocument();
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();

    Object.assign(mockSelection, {
      selectedWorkspaceId: 'workspace-2',
      selectedProjectId: 'project-2',
      selectedProject: { id: 'project-2' },
      projectActivation: {
        workspaceId: 'workspace-2',
        projectId: 'project-2',
        status: 'confirmed',
      },
    });
    view.rerender(routeTree());

    expect(useIntegrationConnectionsMock).toHaveBeenLastCalledWith({
      projectId: 'project-2',
      enabled: true,
    });
    expect(screen.getByText('Task dialog')).toBeInTheDocument();
    expect(mockDialogProps.last).toEqual(
      expect.objectContaining({ projectId: 'project-2', expectedLinkedEpicId: 'epic-1' }),
    );
  });

  it('shows an actionable safe state when the owning project has no connection', async () => {
    useIntegrationConnectionsMock.mockReturnValue({
      connections: [connection(false)],
      isLoading: false,
    });
    const { baseElement } = renderRoute();

    expect(screen.getByText(/Use Add board.*connect Jira for Product/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add board' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Settings.*Integrations/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it('does not activate away from a locked workspace', () => {
    Object.assign(mockSelection, { isWorkspaceSelectionLocked: true });
    useLinkedTaskOwnershipMock.mockReturnValue(
      ownershipValue({
        project: { id: 'project-2', workspaceId: 'workspace-2', name: 'Platform' },
      }),
    );
    renderRoute('jira', 'epic-1', { boardReturnUrl: '/board?st=locked&v=list' });

    expect(activateProjectMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Open the owning project');
    expect(useIntegrationConnectionsMock).toHaveBeenCalledWith({
      projectId: null,
      enabled: false,
    });
    expectDevChainSwitch('/board?st=locked&v=list');
  });

  it('offers an explicit retry when cross-workspace activation fails', () => {
    const owningProject = { id: 'project-2', workspaceId: 'workspace-2', name: 'Platform' };
    useLinkedTaskOwnershipMock.mockReturnValue(ownershipValue({ project: owningProject }));
    Object.assign(mockSelection, {
      projectActivation: {
        workspaceId: owningProject.workspaceId,
        projectId: owningProject.id,
        status: 'failed',
      },
    });
    renderRoute();

    expect(screen.getByRole('alert')).toHaveTextContent('could not be activated');
    expect(activateProjectMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(activateProjectMock).toHaveBeenCalledWith(owningProject);
    expect(useIntegrationConnectionsMock).toHaveBeenCalledWith({
      projectId: null,
      enabled: false,
    });
  });

  it('reactivates the owner if selection drifts after an earlier confirmation', () => {
    const owningProject = { id: 'project-2', workspaceId: 'workspace-2', name: 'Platform' };
    useLinkedTaskOwnershipMock.mockReturnValue(ownershipValue({ project: owningProject }));
    Object.assign(mockSelection, {
      projectActivation: {
        workspaceId: owningProject.workspaceId,
        projectId: owningProject.id,
        status: 'confirmed',
      },
    });
    renderRoute();

    expect(activateProjectMock).toHaveBeenCalledWith(owningProject);
    expect(useIntegrationConnectionsMock).toHaveBeenCalledWith({
      projectId: null,
      enabled: false,
    });
  });

  it('renders ownership errors without any vendor admission and retries', () => {
    const refetch = jest.fn();
    useLinkedTaskOwnershipMock.mockReturnValue(
      ownershipValue({
        project: undefined,
        isError: true,
        error: new Error('Project read failed.'),
        refetch,
      }),
    );
    renderRoute();

    expect(screen.getByRole('alert')).toHaveTextContent('Project read failed.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(useIntegrationConnectionsMock).toHaveBeenCalledWith({
      projectId: null,
      enabled: false,
    });
  });

  it('renders the unavailable state without enabling vendor queries', () => {
    canUseIntegrations = false;
    renderRoute('jira', 'epic-1', { boardReturnUrl: '/board?st=unavailable&pg=2' });
    expect(screen.getByText('External boards unavailable')).toBeInTheDocument();
    expect(useIntegrationConnectionsMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      enabled: false,
    });
    expect(useEpicExternalSourcesMock).toHaveBeenCalledWith('epic-1', { enabled: false });
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
    expectDevChainSwitch('/board?st=unavailable&pg=2');
  });

  it('uses the shared DevChain switch when the durable provider source is missing', () => {
    useEpicExternalSourcesMock.mockReturnValue(sourcesValue({ data: { items: [] } }));
    renderRoute('jira', 'epic-1', { boardReturnUrl: '/board?st=missing&v=kanban' });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This DevChain task is not linked to a Jira task in the current project.',
    );
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
    expectDevChainSwitch('/board?st=missing&v=kanban');
  });

  it('opens the earliest source only after ownership activation with the expected-Epic gate', () => {
    useEpicExternalSourcesMock.mockReturnValue(
      sourcesValue({
        data: {
          items: [
            source({ remoteTaskId: 'ENG-9', linkedAt: '2026-08-05T00:00:00.000Z' }),
            source({ remoteTaskId: 'ENG-1', linkedAt: '2026-08-01T00:00:00.000Z' }),
          ],
        },
      }),
    );
    renderRoute();

    expect(mockDialogProps.last).toEqual(
      expect.objectContaining({
        provider: 'jira',
        projectId: 'project-1',
        taskId: 'ENG-1',
        expectedLinkedEpicId: 'epic-1',
        connectionEpoch: 'conn-1:1',
      }),
    );
  });

  it('closes with replace to the exact validated native Board URL', () => {
    renderRoute('jira', 'epic-1', { boardReturnUrl: '/board?st=s1&v=list&pg=2' });
    fireEvent.click(screen.getByRole('button', { name: 'Simulate dialog close' }));
    expect(mockNavigate).toHaveBeenCalledWith('/board?st=s1&v=list&pg=2', { replace: true });
  });

  it('closes through in-app history back when no validated return URL exists', () => {
    window.history.replaceState({ idx: 3 }, '');
    renderRoute();
    fireEvent.click(screen.getByRole('button', { name: 'Simulate dialog close' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('closes to /board with replace for a direct deep link without in-app history', () => {
    renderRoute();
    fireEvent.click(screen.getByRole('button', { name: 'Simulate dialog close' }));
    expect(mockNavigate).toHaveBeenCalledWith('/board', { replace: true });
  });

  it('shows the Task view navigation with the provider view active', async () => {
    const { baseElement } = renderRoute();

    const nav = screen.getByRole('navigation', { name: 'Task view' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(2);
    const devChainLink = within(nav).getByRole('link', { name: 'DevChain' });
    const providerLink = within(nav).getByRole('link', { name: 'Jira' });
    expect(devChainLink).toHaveAttribute('href', '/epics/epic-1');
    expect(providerLink).toHaveAttribute('href', '/board/jira/linked/epic-1');
    expect(providerLink).toHaveAttribute('aria-current', 'page');
    expect(devChainLink).not.toHaveAttribute('aria-current');
    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it('switches to the DevChain view with replace, forwarding validated Board return state', () => {
    renderRoute('jira', 'epic-1', { boardReturnUrl: '/board?st=s1' });
    expectDevChainSwitch('/board?st=s1');
  });

  it('forwards no state across the switch when the return URL does not validate', () => {
    renderRoute('jira', 'epic-1', { boardReturnUrl: '/epics/epic-1' });
    fireEvent.click(screen.getByRole('link', { name: 'DevChain' }));

    expect(screen.getByTestId('epic-location-state')).toHaveTextContent('null');
  });

  it('keeps the switcher visible in a fallback state while the route window is closed', () => {
    useIntegrationConnectionsMock.mockReturnValue({
      connections: [connection(false)],
      isLoading: false,
    });
    renderRoute();

    expect(screen.getByRole('navigation', { name: 'Task view' })).toBeInTheDocument();
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
  });
});

describe('parseBoardReturnUrl', () => {
  it('accepts only the native /board entry with an optional query', () => {
    expect(parseBoardReturnUrl({ boardReturnUrl: '/board' })).toBe('/board');
    expect(parseBoardReturnUrl({ boardReturnUrl: '/board?st=s1&v=list&pg=2' })).toBe(
      '/board?st=s1&v=list&pg=2',
    );
  });

  it('rejects non-objects, absolute URLs, hashes, and off-board paths', () => {
    expect(parseBoardReturnUrl(undefined)).toBe('/board');
    expect(parseBoardReturnUrl('/board')).toBe('/board');
    expect(parseBoardReturnUrl({ boardReturnUrl: '//host/board' })).toBe('/board');
    expect(parseBoardReturnUrl({ boardReturnUrl: '/board#h' })).toBe('/board');
    expect(parseBoardReturnUrl({ boardReturnUrl: '/board/sub' })).toBe('/board');
  });
});

describe('boardReturnUrlFromState', () => {
  it('returns the validated native /board URL when state carries one', () => {
    expect(boardReturnUrlFromState({ boardReturnUrl: '/board' })).toBe('/board');
    expect(boardReturnUrlFromState({ boardReturnUrl: '/board?st=s1' })).toBe('/board?st=s1');
  });

  it('returns null for missing, non-object, non-string, and off-board values', () => {
    expect(boardReturnUrlFromState(undefined)).toBeNull();
    expect(boardReturnUrlFromState(null)).toBeNull();
    expect(boardReturnUrlFromState('/board')).toBeNull();
    expect(boardReturnUrlFromState({})).toBeNull();
    expect(boardReturnUrlFromState({ boardReturnUrl: 7 })).toBeNull();
    expect(boardReturnUrlFromState({ boardReturnUrl: '//host/board' })).toBeNull();
    expect(boardReturnUrlFromState({ boardReturnUrl: '/board#h' })).toBeNull();
    expect(boardReturnUrlFromState({ boardReturnUrl: '/board/sub' })).toBeNull();
  });
});

describe('hasInAppHistoryBack', () => {
  afterEach(() => window.history.replaceState(null, ''));

  it('returns true only for a positive integer history index', () => {
    window.history.replaceState({ idx: 1 }, '');
    expect(hasInAppHistoryBack()).toBe(true);
    window.history.replaceState({ idx: 4 }, '');
    expect(hasInAppHistoryBack()).toBe(true);
  });

  it('returns false for missing, null, zero, and malformed idx values', () => {
    window.history.replaceState(null, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({ idx: null }, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({}, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({ idx: 0 }, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({ idx: -2 }, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({ idx: '2' }, '');
    expect(hasInAppHistoryBack()).toBe(false);
    window.history.replaceState({ idx: 1.5 }, '');
    expect(hasInAppHistoryBack()).toBe(false);
  });
});
