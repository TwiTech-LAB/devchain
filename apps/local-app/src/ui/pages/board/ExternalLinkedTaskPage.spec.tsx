import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import type { IntegrationConnectionState } from '@/ui/hooks/useIntegrationConnections';
import { parseBoardReturnUrl } from '@/ui/lib/external-board';
import { ExternalLinkedTaskRoute } from './ExternalLinkedTaskPage';

// Layer: UI page unit. Availability, connections, sources, and the task dialog
// are mocked because this spec owns the route-page contract (state machine,
// earliest-source selection, return-URL admission, close navigation); each
// dependency has its own suite.
const mockNavigate = jest.fn();
let canUseIntegrations = true;
const useIntegrationConnectionsMock = jest.fn();
const useEpicExternalSourcesMock = jest.fn();
const mockDialogProps: { last: Record<string, unknown> | null } = { last: null };

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

jest.mock('../../hooks/useEpicExternalSources', () => ({
  useEpicExternalSources: (epicId: string, options?: unknown) =>
    useEpicExternalSourcesMock(epicId, options),
}));

jest.mock('../../components/board/ExternalTaskDetailDialog', () => ({
  ExternalTaskDetailDialog: (props: {
    provider: string;
    taskId: string | null;
    onOpenChange: (open: boolean) => void;
    [key: string]: unknown;
  }) => {
    mockDialogProps.last = props;
    return (
      <aside>
        Task dialog
        <button type="button" onClick={() => props.onOpenChange(false)}>
          Simulate dialog close
        </button>
      </aside>
    );
  },
}));

function connection(provider: 'clickup' | 'jira', connected: boolean): IntegrationConnectionState {
  return {
    provider,
    connected,
    connectionId: connected ? 'conn-1' : null,
    generation: connected ? 1 : null,
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

function renderRoute(provider = 'jira', epicId = 'epic-1', state?: unknown) {
  return render(
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
      </Routes>
    </MemoryRouter>,
  );
}

describe('ExternalLinkedTaskPage route validation', () => {
  beforeEach(() => {
    canUseIntegrations = true;
    mockNavigate.mockReset();
    mockDialogProps.last = null;
    useIntegrationConnectionsMock.mockReset();
    useIntegrationConnectionsMock.mockReturnValue({
      connections: [connection('jira', true)],
      isLoading: false,
    });
    useEpicExternalSourcesMock.mockReset();
    useEpicExternalSourcesMock.mockReturnValue(sourcesValue({ data: { items: [source()] } }));
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  it('reuses the unknown-provider fallback for an unrecognized provider segment', () => {
    renderRoute('github');
    expect(screen.getByText('Unknown board provider')).toBeInTheDocument();
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
  });

  it('renders the unavailable state without the workspace when runtime admission is denied', () => {
    canUseIntegrations = false;
    renderRoute();
    expect(useEpicExternalSourcesMock).toHaveBeenCalledWith('epic-1', { enabled: false });
    expect(screen.getByText('External boards unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
  });

  it('renders a loading state while the connection resolves', () => {
    useIntegrationConnectionsMock.mockReturnValue({ connections: [], isLoading: true });
    renderRoute();
    expect(screen.getByText('Resolving the Jira connection…')).toBeInTheDocument();
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
  });

  it('renders the disconnected state with the Settings connection path', () => {
    useIntegrationConnectionsMock.mockReturnValue({
      connections: [connection('jira', false)],
      isLoading: false,
    });
    renderRoute();
    expect(screen.getByRole('link', { name: 'Settings → Integrations' })).toBeInTheDocument();
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
  });

  it('renders a loading state while the durable source resolves', () => {
    useEpicExternalSourcesMock.mockReturnValue(sourcesValue({ isLoading: true }));
    renderRoute();
    expect(screen.getByText('Resolving the linked task…')).toBeInTheDocument();
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
  });

  it('renders the error state and retries the source read', () => {
    const refetch = jest.fn();
    useEpicExternalSourcesMock.mockReturnValue(
      sourcesValue({ isError: true, error: new Error('Source read failed.'), refetch }),
    );
    renderRoute();

    expect(screen.getByRole('alert')).toHaveTextContent('Linked task unavailable');
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('renders the missing-link state when no durable source matches the provider', () => {
    useEpicExternalSourcesMock.mockReturnValue(
      sourcesValue({ data: { items: [source({ provider: 'clickup', remoteTaskId: 'CU-1' })] } }),
    );
    renderRoute('jira');

    expect(screen.getByRole('alert')).toHaveTextContent('not linked to a Jira task');
    expect(screen.getByRole('link', { name: 'Open DevChain task' })).toHaveAttribute(
      'href',
      '/epics/epic-1',
    );
    expect(screen.queryByText('Task dialog')).not.toBeInTheDocument();
  });

  it('opens the workspace on the earliest-created matching source with the expected-Epic gate', () => {
    useEpicExternalSourcesMock.mockReturnValue(
      sourcesValue({
        data: {
          items: [
            source({ remoteTaskId: 'ENG-9', linkedAt: '2026-08-05T00:00:00.000Z' }),
            source({ remoteTaskId: 'ENG-1', linkedAt: '2026-08-01T00:00:00.000Z' }),
            source({
              provider: 'clickup',
              remoteTaskId: 'CU-1',
              linkedAt: '2026-07-01T00:00:00.000Z',
            }),
          ],
        },
      }),
    );
    renderRoute();

    expect(useEpicExternalSourcesMock).toHaveBeenCalledWith('epic-1', { enabled: true });
    expect(screen.getByText('Task dialog')).toBeInTheDocument();
    const props = mockDialogProps.last!;
    expect(props.provider).toBe('jira');
    expect(props.taskId).toBe('ENG-1');
    expect(props.expectedLinkedEpicId).toBe('epic-1');
    expect(props.connectionEpoch).toBe('conn-1:1');
    expect(props.open).toBe(true);
    // Internal navigation resolves the durable source only; the vendor URL is
    // never an internal target.
    expect(String(props.taskId)).not.toContain('http');
  });

  it('closes with replace to the exact validated native Board URL', () => {
    renderRoute('jira', 'epic-1', { boardReturnUrl: '/board?st=s1&v=list&pg=2' });

    fireEvent.click(screen.getByRole('button', { name: 'Simulate dialog close' }));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/board?st=s1&v=list&pg=2', { replace: true });
  });

  it.each([
    ['a direct link without state', undefined],
    ['non-string state', 42],
    ['state without the return key', { other: '/board?x=1' }],
    ['an absolute URL', { boardReturnUrl: 'https://evil.example/board' }],
    ['a protocol-relative URL', { boardReturnUrl: '//evil.example/board' }],
    ['a hash', { boardReturnUrl: '/board#section' }],
    ['a /board subpath', { boardReturnUrl: '/board/jira' }],
    ['an empty query marker', { boardReturnUrl: '/board?' }],
    ['a malformed value', { boardReturnUrl: 'javascript:alert(1)' }],
    ['a non-object value', '/board?st=s1'],
  ])('falls back to /board on close for %s', (_label, state) => {
    renderRoute('jira', 'epic-1', state);

    fireEvent.click(screen.getByRole('button', { name: 'Simulate dialog close' }));

    expect(mockNavigate).toHaveBeenCalledWith('/board', { replace: true });
  });
});

describe('parseBoardReturnUrl', () => {
  it('accepts only the native /board entry with an optional query', () => {
    expect(parseBoardReturnUrl({ boardReturnUrl: '/board' })).toBe('/board');
    expect(parseBoardReturnUrl({ boardReturnUrl: '/board?st=s1&v=list&pg=2' })).toBe(
      '/board?st=s1&v=list&pg=2',
    );
  });

  it('rejects non-objects, non-strings, and off-board shapes', () => {
    expect(parseBoardReturnUrl(undefined)).toBe('/board');
    expect(parseBoardReturnUrl(null)).toBe('/board');
    expect(parseBoardReturnUrl('/board')).toBe('/board');
    expect(parseBoardReturnUrl({})).toBe('/board');
    expect(parseBoardReturnUrl({ boardReturnUrl: '/board/sub' })).toBe('/board');
    expect(parseBoardReturnUrl({ boardReturnUrl: '//host/board' })).toBe('/board');
    expect(parseBoardReturnUrl({ boardReturnUrl: '/board#h' })).toBe('/board');
  });
});
