import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ExternalBoardNav } from './ExternalBoardNav';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';

const mockSelectedProject: { id: string | null; name: string | null } = {
  id: PROJECT_A,
  name: 'Acme Project',
};

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProjectId: mockSelectedProject.id,
    selectedProject:
      mockSelectedProject.id === null
        ? null
        : { id: mockSelectedProject.id, name: mockSelectedProject.name },
  }),
}));
import {
  IntegrationConnectionApiError,
  type IntegrationConnectionState,
} from '@/ui/hooks/useIntegrationConnections';

// Layer: UI component unit. The connection hook is mocked because this spec owns the
// tab derivation and Add-board composition contract; the hook's query plumbing has
// its own suite.
const useIntegrationConnectionsMock = jest.fn();
const useManagedSubtaskSyncHealthMock = jest.fn();
let canUseIntegrations = true;

jest.mock('../../hooks/useIntegrationAvailability', () => ({
  useIntegrationAvailability: () => ({
    canUseIntegrations,
    runtimeResolved: true,
    reason: null,
  }),
}));

jest.mock('../../hooks/useIntegrationConnections', () => ({
  // Keep the real error class and types; only the hook itself is replaced.
  ...jest.requireActual('../../hooks/useIntegrationConnections'),
  useIntegrationConnections: (options?: unknown) => useIntegrationConnectionsMock(options),
}));

jest.mock('../../hooks/useManagedSubtaskSyncHealth', () => ({
  useManagedSubtaskSyncHealth: (...args: unknown[]) =>
    (useManagedSubtaskSyncHealthMock as unknown as (...values: unknown[]) => unknown)(...args),
}));

function connection(provider: 'clickup' | 'jira', connected: boolean): IntegrationConnectionState {
  return {
    provider,
    connected,
    connectionId: connected ? `connection-${provider}` : null,
    generation: connected ? 1 : null,
    subtaskSyncEnabled: false,
    syncSettingRevision: connected ? 1 : null,
    updatedAt: connected ? '2026-01-01T00:00:00Z' : null,
  };
}

function baseHookValue(
  overrides: Partial<{
    connections: IntegrationConnectionState[];
    isLoading: boolean;
    error: unknown;
    replaceConnection: ReturnType<typeof jest.fn>;
    disconnectConnection: ReturnType<typeof jest.fn>;
    updateSubtaskSync: ReturnType<typeof jest.fn>;
    replacingProvider: 'clickup' | 'jira' | undefined;
    disconnectingProvider: 'clickup' | 'jira' | undefined;
    updatingSyncProvider: 'clickup' | 'jira' | undefined;
  }> = {},
) {
  return {
    connections: [] as IntegrationConnectionState[],
    isLoading: false,
    error: null,
    replaceConnection: jest.fn(),
    disconnectConnection: jest.fn(),
    updateSubtaskSync: jest.fn(),
    replacingProvider: undefined,
    disconnectingProvider: undefined,
    updatingSyncProvider: undefined,
    ...overrides,
  };
}

function withinDialog(dialog: HTMLElement) {
  return within(dialog);
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="current-location">{`${location.pathname}${location.search}`}</div>;
}

function navRouter(initialEntry = '/board') {
  return (
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/board" element={<ExternalBoardNav />} />
        <Route path="/board/:providerName" element={<ExternalBoardNav />} />
        <Route path="/board/:providerName/:workAreaId" element={<ExternalBoardNav />} />
        <Route path="/board/:providerName/linked/:epicId" element={<ExternalBoardNav />} />
        <Route path="*" element={<div data-testid="not-found" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>
  );
}

function renderNav(initialEntry = '/board') {
  return render(navRouter(initialEntry));
}

beforeEach(() => {
  useManagedSubtaskSyncHealthMock.mockReset();
  useManagedSubtaskSyncHealthMock.mockReturnValue({
    health: undefined,
    isLoading: false,
    error: null,
    verify: jest.fn(),
    retry: jest.fn(),
    pendingAction: undefined,
  });
});

describe('ExternalBoardNav', () => {
  beforeEach(() => {
    canUseIntegrations = true;
    window.sessionStorage.clear();
    mockSelectedProject.id = PROJECT_A;
    mockSelectedProject.name = 'Acme Project';
    useIntegrationConnectionsMock.mockReset();
    useIntegrationConnectionsMock.mockReturnValue(baseHookValue({}));
  });

  afterEach(() => {
    cleanup();
  });

  it('renders only connected provider tabs from a single connection query call', async () => {
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({
        connections: [connection('clickup', true), connection('jira', false)],
      }),
    );

    renderNav();

    expect(useIntegrationConnectionsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'DevChain' })).toHaveAttribute('href', '/board');
    expect(screen.getByRole('link', { name: /^ClickUp/ })).toHaveAttribute(
      'href',
      '/board/clickup',
    );
    expect(screen.queryByRole('link', { name: /^Jira/ })).not.toBeInTheDocument();

    {
      expect(screen.queryByText('Connected')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Open ClickUp board settings' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Open Jira board settings' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /^Jira/ })).not.toBeInTheDocument();
    }
  });

  it('hides provider tabs, connection state, and Add board when integrations are unavailable', () => {
    canUseIntegrations = false;
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({ connections: [connection('clickup', true)] }),
    );

    renderNav('/board/clickup');

    expect(useIntegrationConnectionsMock).toHaveBeenCalledWith({
      projectId: PROJECT_A,
      enabled: false,
    });
    expect(screen.getByRole('link', { name: 'DevChain' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^ClickUp/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add board' })).not.toBeInTheDocument();
  });

  it('omits provider settings controls while the connection query is loading', () => {
    useIntegrationConnectionsMock.mockReturnValue(baseHookValue({ isLoading: true }));

    renderNav();

    expect(screen.queryByRole('button', { name: /board settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^ClickUp/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Jira/ })).not.toBeInTheDocument();
  });

  it.each([
    ['/board', 'DevChain'],
    ['/board/jira', 'Jira'],
    ['/board/clickup/space-901', 'ClickUp'],
    ['/board/jira/linked/epic-1', 'Jira'],
  ])('marks the active tab on %s', (route, active) => {
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({ connections: [connection('clickup', true), connection('jira', true)] }),
    );
    renderNav(route);
    for (const name of ['DevChain', 'ClickUp', 'Jira']) {
      const link = screen.getByRole('link', { name: new RegExp('^' + name) });
      const styled = name === 'DevChain' ? link : link.parentElement;
      if (name === active) {
        expect(link).toHaveAttribute('aria-current', 'page');
        expect(styled).toHaveClass('bg-selected', 'text-selected-foreground');
      } else {
        expect(link).not.toHaveAttribute('aria-current');
        expect(styled).not.toHaveClass('bg-selected');
      }
    }
  });

  it('opens the connected provider settings without navigating away', async () => {
    const user = userEvent.setup();
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({ connections: [connection('clickup', true)] }),
    );
    renderNav('/board');

    await user.click(screen.getByRole('button', { name: 'Open ClickUp board settings' }));

    screen.getByRole('dialog', { name: 'ClickUp board settings' });

    expect(screen.getByTestId('current-location')).toHaveTextContent('/board');
  });

  it('returns each board source to its last full route', async () => {
    const user = userEvent.setup();
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({
        connections: [connection('clickup', true), connection('jira', true)],
      }),
    );
    renderNav('/board/clickup/list-42?completed=1');

    await user.click(screen.getByRole('link', { name: /^Jira/ }));
    expect(screen.getByTestId('current-location')).toHaveTextContent('/board/jira');

    await user.click(screen.getByRole('link', { name: /^ClickUp/ }));
    expect(screen.getByTestId('current-location')).toHaveTextContent(
      '/board/clickup/list-42?completed=1',
    );

    await user.click(screen.getByRole('link', { name: 'DevChain' }));
    expect(screen.getByTestId('current-location')).toHaveTextContent('/board');
  });

  it('restores the last native Board query state', async () => {
    const user = userEvent.setup();
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({ connections: [connection('clickup', true)] }),
    );
    renderNav('/board?status=active');

    await user.click(screen.getByRole('link', { name: /^ClickUp/ }));
    await user.click(screen.getByRole('link', { name: 'DevChain' }));

    expect(screen.getByTestId('current-location')).toHaveTextContent('/board?status=active');
  });

  it('never remembers a linked workspace route as the provider Board route', async () => {
    const user = userEvent.setup();
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({ connections: [connection('jira', true)] }),
    );
    window.sessionStorage.setItem(
      `devchain:board:lastRoute:${PROJECT_A}:jira`,
      '/board/jira/list-9?completed=1',
    );

    renderNav('/board/jira/linked/epic-9');
    await act(async () => {});

    expect(window.sessionStorage.getItem(`devchain:board:lastRoute:${PROJECT_A}:jira`)).toBe(
      '/board/jira/list-9?completed=1',
    );
    await user.click(screen.getByRole('link', { name: /^Jira/ }));
    expect(screen.getByTestId('current-location')).toHaveTextContent(
      '/board/jira/list-9?completed=1',
    );
  });

  it('rejects a remembered linked route when restoring the provider tab', async () => {
    const user = userEvent.setup();
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({ connections: [connection('jira', true)] }),
    );
    window.sessionStorage.setItem(
      `devchain:board:lastRoute:${PROJECT_A}:jira`,
      '/board/jira/linked/epic-9',
    );

    renderNav('/board');

    await user.click(screen.getByRole('link', { name: /^Jira/ }));
    expect(screen.getByTestId('current-location')).toHaveTextContent('/board/jira');
  });

  it('restores route memory per project without crossing projects', () => {
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({ connections: [connection('clickup', true)] }),
    );
    window.sessionStorage.setItem(
      `devchain:board:lastRoute:${PROJECT_A}:clickup`,
      '/board/clickup/list-a?completed=1',
    );
    window.sessionStorage.setItem(
      `devchain:board:lastRoute:${PROJECT_B}:clickup`,
      '/board/clickup/list-b',
    );

    const view = renderNav('/board');
    expect(screen.getByRole('link', { name: /^ClickUp/ })).toHaveAttribute(
      'href',
      '/board/clickup/list-a?completed=1',
    );

    mockSelectedProject.id = PROJECT_B;
    view.rerender(navRouter('/board'));

    expect(screen.getByRole('link', { name: /^ClickUp/ })).toHaveAttribute(
      'href',
      '/board/clickup/list-b',
    );
  });

  it('never restores a legacy unscoped route-memory key', () => {
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({ connections: [connection('jira', true)] }),
    );
    window.sessionStorage.setItem('devchain:board:lastRoute:jira', '/board/jira/legacy-1');
    window.sessionStorage.setItem('devchain:board:lastRoute:devchain', '/board?status=active');

    renderNav('/board');

    expect(screen.getByRole('link', { name: /^Jira/ })).toHaveAttribute('href', '/board/jira');
    expect(screen.getByRole('link', { name: 'DevChain' })).toHaveAttribute('href', '/board');
  });

  it('removes the legacy unscoped key when remembering a project route', async () => {
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({ connections: [connection('jira', true)] }),
    );
    window.sessionStorage.setItem('devchain:board:lastRoute:jira', '/board/jira/legacy-1');

    renderNav('/board/jira/list-2');
    await act(async () => {});

    expect(window.sessionStorage.getItem('devchain:board:lastRoute:jira')).toBeNull();
    expect(window.sessionStorage.getItem(`devchain:board:lastRoute:${PROJECT_A}:jira`)).toBe(
      '/board/jira/list-2',
    );
  });

  it('does not remember board routes without a selected project', async () => {
    mockSelectedProject.id = null;
    useIntegrationConnectionsMock.mockReturnValue(
      baseHookValue({ connections: [connection('clickup', true)] }),
    );

    renderNav('/board/clickup/list-9?completed=1');
    await act(async () => {});

    const remembered = Object.keys(window.sessionStorage).filter((key) =>
      key.startsWith('devchain:board:lastRoute:'),
    );
    expect(remembered).toEqual([]);
  });
});

describe('ExternalBoardNav Add board', () => {
  let hookValue: ReturnType<typeof baseHookValue>;

  beforeEach(() => {
    window.sessionStorage.clear();
    mockSelectedProject.id = PROJECT_A;
    mockSelectedProject.name = 'Acme Project';
    hookValue = baseHookValue();
    useIntegrationConnectionsMock.mockReset();
    useIntegrationConnectionsMock.mockImplementation(() => hookValue);
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    { name: 'loading', value: baseHookValue({ isLoading: true }) },
    {
      name: 'both connected',
      value: baseHookValue({
        connections: [connection('clickup', true), connection('jira', true)],
      }),
    },
  ])('hides Add board for $name', ({ value }) => {
    hookValue = value;

    renderNav();

    expect(screen.queryByRole('button', { name: /add board/i })).not.toBeInTheDocument();
  });

  it('offers both providers when nothing is connected', () => {
    renderNav();
    fireEvent.click(screen.getByRole('button', { name: /add board/i }));

    expect(screen.getByRole('dialog', { name: 'Add board' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect ClickUp' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Jira' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Personal API token')).not.toBeInTheDocument();
    expect(screen.getByText('Connect an external work board to Acme Project.')).toBeInTheDocument();
  });

  it('offers only the missing provider when one provider is connected', () => {
    hookValue = baseHookValue({ connections: [connection('clickup', true)] });

    renderNav();
    fireEvent.click(screen.getByRole('button', { name: /add board/i }));

    const dialog = screen.getByRole('dialog', { name: 'Add board' });
    expect(screen.queryByRole('button', { name: 'Connect ClickUp' })).not.toBeInTheDocument();

    expect(
      withinDialog(dialog).queryByRole('button', { name: /disconnect/i }),
    ).not.toBeInTheDocument();
  });

  it('keeps the dialog open and preserves input when the connect request fails', async () => {
    const user = userEvent.setup();
    hookValue = baseHookValue({
      replaceConnection: jest.fn(async () => {
        throw new IntegrationConnectionApiError('Token rejected.', {
          code: 'clickup_authentication_failed',
          field: 'token',
        });
      }),
    });

    renderNav();
    fireEvent.click(screen.getByRole('button', { name: /add board/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect ClickUp' }));
    await user.type(screen.getByLabelText('Personal API token'), 'bad-token');
    fireEvent.click(screen.getByRole('button', { name: /connect clickup/i }));

    expect(await screen.findByText('Token rejected.')).toBeInTheDocument();
    expect(screen.getByLabelText('Personal API token')).toHaveValue('bad-token');
    expect(screen.getByRole('dialog', { name: 'Add board' })).toBeInTheDocument();
    expect(screen.getByTestId('current-location')).toHaveTextContent('/board');
  });

  it('navigates to the provider landing and clears the dialog after a successful connect', async () => {
    const user = userEvent.setup();
    const replaceConnection = jest.fn(async () => undefined);
    hookValue = baseHookValue({ replaceConnection });

    renderNav();
    fireEvent.click(screen.getByRole('button', { name: /add board/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect ClickUp' }));
    await user.type(screen.getByLabelText('Personal API token'), 'good-token');
    fireEvent.click(screen.getByRole('button', { name: /connect clickup/i }));

    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent('/board/clickup');
    });
    expect(replaceConnection).toHaveBeenCalledWith({
      provider: 'clickup',
      token: 'good-token',
      subtaskSyncEnabled: false,
    });
    expect(screen.queryByRole('dialog', { name: 'Add board' })).not.toBeInTheDocument();
  });

  it('marks the newly connected provider tab after success', async () => {
    const user = userEvent.setup();
    // Connecting the second provider: the mutation resolves and the refreshed
    // connection list carries both providers, mirroring invalidation → refetch.
    const replaceConnection = jest.fn(async (input: { provider: 'clickup' | 'jira' }) => {
      hookValue = baseHookValue({
        connections: [connection('clickup', true), connection(input.provider, true)],
        replaceConnection,
      });
    });
    hookValue = baseHookValue({
      connections: [connection('clickup', true)],
      replaceConnection,
    });

    renderNav();
    fireEvent.click(screen.getByRole('button', { name: /add board/i }));
    // Single candidate opens the Jira form directly, without a selection step.
    await user.type(screen.getByLabelText('Jira site URL'), 'https://acme.atlassian.net');
    await user.type(screen.getByLabelText('Account email'), 'you@example.com');
    await user.type(screen.getByLabelText('Classic API token (without scopes)'), 'good-token');
    fireEvent.click(screen.getByRole('button', { name: /connect jira/i }));

    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent('/board/jira');
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /add board/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Open ClickUp board settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Jira board settings' })).toBeInTheDocument();
  });
});
