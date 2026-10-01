/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useRemoteStatsHistory } from '@/ui/hooks/useRemoteStatsHistory';
import { useHomeSocket } from '@/ui/hooks/useHomeSocket';
import { MemoryRouter } from 'react-router-dom';
import { BackendBoundary, ProjectGate } from '@/ui/components/BackendBoundary';
import {
  BackendProvider,
  REMOTE_BINDING_EVENT_TYPE,
  isBindingChangeEnvelope,
  toBindingMap,
  useOptionalBackend,
  type BackendContextValue,
  type RemoteProjectBindingRow,
} from './backend-provider';

jest.mock('@/ui/hooks/useHomeSocket', () => ({ useHomeSocket: jest.fn() }));

let mockSelectedProjectId: string | undefined = 'p1';
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: mockSelectedProjectId }),
}));

const REMOTE_ID = '11111111-1111-4111-8111-111111111111';

type MessageHandler = (envelope: unknown) => void;

let providedFetch: BackendContextValue['apiFetch'] | undefined;

function ActiveBackend() {
  const backend = useOptionalBackend();
  providedFetch = backend?.apiFetch;
  return (
    <span data-testid="active" data-ready={String(backend?.ready ?? false)}>
      {backend?.activeBackend ?? 'none'}
    </span>
  );
}

async function waitForReadyBackend(backendId: string) {
  await waitFor(() => {
    const active = screen.getByTestId('active');
    expect(active.textContent).toBe(backendId);
    expect(active).toHaveAttribute('data-ready', 'true');
  });
}

function renderProvider(children: ReactNode = <ActiveBackend />) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BackendProvider>{children}</BackendProvider>
    </QueryClientProvider>,
  );
}

function mockBindings(rows: RemoteProjectBindingRow[]) {
  bindingRows = rows;
}

let bindingRows: RemoteProjectBindingRow[] = [];
let messageHandler: MessageHandler | undefined;
let failBindings = false;
const originalFetch = global.fetch;
const REMOTES = [
  { id: REMOTE_ID, name: 'lab-vm', online: true, version: '1.0.0', versionMatches: true },
];
let remoteRows: Array<Record<string, unknown>> = REMOTES;
const fetchMock = jest.fn(async (url: string) => {
  if (url === '/api/remotes/bindings' && failBindings) {
    throw new Error('temporary binding read failure');
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ items: url === '/api/remotes' ? remoteRows : bindingRows }),
  };
});

function bindingFetchCount(): number {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/remotes/bindings').length;
}

function renderBoundary() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BackendProvider>
        <MemoryRouter initialEntries={['/board']}>
          <BackendBoundary>
            <ProjectGate scope="page">
              <span data-testid="page">mounted</span>
            </ProjectGate>
          </BackendBoundary>
        </MemoryRouter>
      </BackendProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockSelectedProjectId = 'p1';
  bindingRows = [];
  remoteRows = REMOTES;
  messageHandler = undefined;
  providedFetch = undefined;
  failBindings = false;
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.mocked(useHomeSocket).mockImplementation((handlers) => {
    messageHandler = handlers.message as MessageHandler;
    return {} as ReturnType<typeof useHomeSocket>;
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('BackendProvider', () => {
  it('loads bindings from home and exposes the active project backend', async () => {
    mockBindings([{ projectId: 'p1', remoteId: REMOTE_ID, state: 'remote' }]);

    renderProvider();

    await waitForReadyBackend(REMOTE_ID);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/remotes/bindings',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await providedFetch!('/api/epics/e1');
    expect(fetchMock).toHaveBeenLastCalledWith(`/r/${REMOTE_ID}/api/epics/e1`, undefined);
  });

  it('refuses project-routed requests until routing is known, but lets home-always ones through', async () => {
    failBindings = true;
    renderProvider();
    await waitFor(() => expect(bindingFetchCount()).toBe(1));
    expect(screen.getByTestId('active')).toHaveAttribute('data-ready', 'false');
    fetchMock.mockClear();

    await expect(providedFetch!('/api/epics/e1')).rejects.toMatchObject({
      name: 'ROUTING_UNKNOWN',
    });
    await providedFetch!('/api/projects');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/projects']);
  });

  it('refetches the binding map when a remotes socket event arrives', async () => {
    renderProvider();
    await waitFor(() => expect(bindingFetchCount()).toBe(1));
    expect(screen.getByTestId('active').textContent).toBe('home');

    mockBindings([{ projectId: 'p1', remoteId: REMOTE_ID, state: 'remote' }]);
    act(() => messageHandler?.({ topic: 'remotes', type: 'state', payload: {}, ts: '' }));

    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe(REMOTE_ID));
    expect(bindingFetchCount()).toBe(2);
  });

  it('refetches on a project binding event and ignores unrelated events', async () => {
    mockBindings([{ projectId: 'p1', remoteId: REMOTE_ID, state: 'remote' }]);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe(REMOTE_ID));

    act(() => messageHandler?.({ topic: 'project/p1', type: 'epic.updated', payload: {}, ts: '' }));
    expect(bindingFetchCount()).toBe(1);

    mockBindings([]);
    act(() =>
      messageHandler?.({
        topic: 'project/p1',
        type: REMOTE_BINDING_EVENT_TYPE,
        payload: {},
        ts: '',
      }),
    );

    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('home'));
    expect(bindingFetchCount()).toBe(2);
  });

  it('keeps the previous fetch bound to its backend after the active project changes', async () => {
    mockBindings([{ projectId: 'p1', remoteId: REMOTE_ID, state: 'remote' }]);
    const view = renderProvider();
    await waitForReadyBackend(REMOTE_ID);
    const remoteFetch = providedFetch!;

    mockSelectedProjectId = 'p-local';
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <BackendProvider>
          <ActiveBackend />
        </BackendProvider>
      </QueryClientProvider>,
    );
    await waitForReadyBackend('home');

    await remoteFetch('/api/epics/e1');
    expect(fetchMock).toHaveBeenLastCalledWith(`/r/${REMOTE_ID}/api/epics/e1`, undefined);
    await providedFetch!('/api/epics/e1');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/epics/e1', undefined);
  });
});

// UI tests keep the real query cache and history hooks so request counts exercise
// subscription matching and timer behavior without a browser or running server.
describe('BackendProvider health event invalidation', () => {
  const remoteIds = [REMOTE_ID, 'vm-2', 'vm-3'];
  const historyUrl = (id: string) => `/api/remotes/${id}/stats/history`;
  const count = (url: string) => fetchMock.mock.calls.filter(([path]) => path === url).length;

  function History({ id }: { id: string }) {
    useRemoteStatsHistory(id);
    return null;
  }

  async function setup() {
    mockBindings([{ projectId: 'p1', remoteId: REMOTE_ID, state: 'remote' }]);
    const view = renderProvider(
      <>
        <ActiveBackend />
        {remoteIds.map((id) => (
          <History key={id} id={id} />
        ))}
        <History id={REMOTE_ID} />
      </>,
    );
    await waitForReadyBackend(REMOTE_ID);
    fetchMock.mockClear();
    return view;
  }

  async function emit(remoteId?: string) {
    await act(async () => {
      messageHandler?.({ topic: 'remotes', type: 'state', payload: { remoteId }, ts: '' });
    });
  }

  async function emitBinding(remoteId: string) {
    await act(async () => {
      messageHandler?.({ topic: 'remotes', type: 'binding', payload: { remoteId }, ts: '' });
    });
  }

  async function advance(ms: number) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('refetches only the named VM history, including shared row and drawer observers', async () => {
    await setup();
    await emit(REMOTE_ID);
    expect(count(historyUrl(REMOTE_ID))).toBe(1);
    expect(count(historyUrl('vm-2'))).toBe(0);
    expect(count(historyUrl('vm-3'))).toBe(0);
    expect(count('/api/remotes')).toBe(0);
    expect(bindingFetchCount()).toBe(0);
    await advance(250);
    expect(remoteIds.map((id) => count(historyUrl(id)))).toEqual([1, 0, 0]);
  });

  it('coalesces staggered VM events into one list and bindings request per trailing window', async () => {
    await setup();
    for (const id of remoteIds) {
      await emit(id);
      await advance(100);
    }
    await advance(149);
    expect(count('/api/remotes')).toBe(0);
    expect(bindingFetchCount()).toBe(0);
    await advance(1);
    expect(count('/api/remotes')).toBe(1);
    expect(bindingFetchCount()).toBe(1);
    expect(remoteIds.map((id) => count(historyUrl(id)))).toEqual([1, 1, 1]);
    await emit(REMOTE_ID);
    await advance(250);
    expect(count('/api/remotes')).toBe(2);
    expect(bindingFetchCount()).toBe(2);
  });

  it('updates project routing immediately during a pending health batch', async () => {
    await setup();
    await emit(REMOTE_ID);
    mockBindings([]);
    await act(async () => {
      messageHandler?.({ topic: 'project/p1', type: REMOTE_BINDING_EVENT_TYPE, payload: {} });
    });
    expect(bindingFetchCount()).toBe(1);
    await advance(1);
    expect(screen.getByTestId('active').textContent).toBe('home');
    expect(count('/api/remotes')).toBe(0);
  });

  it('refreshes the bindings at once for a binding envelope, without the history or the list', async () => {
    await setup();
    mockBindings([]);
    await emitBinding(REMOTE_ID);
    expect(bindingFetchCount()).toBe(1);
    expect(count(historyUrl(REMOTE_ID))).toBe(0);
    expect(count('/api/remotes')).toBe(0);
    await advance(1);
    expect(screen.getByTestId('active').textContent).toBe('home');
    await advance(250);
    expect(bindingFetchCount()).toBe(1);
    expect(count(historyUrl(REMOTE_ID))).toBe(0);
    expect(count('/api/remotes')).toBe(0);
  });

  it('leaves a pending health batch running when a binding envelope arrives', async () => {
    await setup();
    await emit(REMOTE_ID);
    await advance(100);
    await emitBinding(REMOTE_ID);
    expect(bindingFetchCount()).toBe(1);
    expect(count(historyUrl(REMOTE_ID))).toBe(1);
    expect(count('/api/remotes')).toBe(0);
    await advance(149);
    expect(count('/api/remotes')).toBe(0);
    expect(bindingFetchCount()).toBe(1);
    await advance(1);
    expect(count('/api/remotes')).toBe(1);
    expect(bindingFetchCount()).toBe(2);
  });

  it('immediately refreshes the whole prefix without remoteId and cancels the pending batch', async () => {
    await setup();
    await emit(REMOTE_ID);
    fetchMock.mockClear();
    await emit();
    expect(count('/api/remotes')).toBe(1);
    expect(bindingFetchCount()).toBe(1);
    expect(remoteIds.map((id) => count(historyUrl(id)))).toEqual([1, 1, 1]);
    await advance(250);
    expect(count('/api/remotes')).toBe(1);
    expect(bindingFetchCount()).toBe(1);
  });

  it('keeps the context value when a VM event changes only status fields', async () => {
    let latest: BackendContextValue | undefined;
    function Capture() {
      latest = useOptionalBackend();
      return null;
    }
    mockBindings([{ projectId: 'p1', remoteId: REMOTE_ID, state: 'remote', hostCursor: 'c1' }]);
    remoteRows = [{ ...REMOTES[0], stats: { cpuPercent: 10 }, lastSeenAt: 't1' }];
    renderProvider(
      <>
        <ActiveBackend />
        <Capture />
      </>,
    );
    await waitForReadyBackend(REMOTE_ID);
    const initial = latest;
    fetchMock.mockClear();

    mockBindings([{ projectId: 'p1', remoteId: REMOTE_ID, state: 'remote', hostCursor: 'c2' }]);
    remoteRows = [{ ...REMOTES[0], stats: { cpuPercent: 55 }, lastSeenAt: 't2' }];
    await emit(REMOTE_ID);
    await advance(260);
    expect(count('/api/remotes')).toBe(1);
    expect(bindingFetchCount()).toBe(1);
    expect(latest).toBe(initial);

    // A field the context carries still reaches it.
    remoteRows = [{ ...REMOTES[0], online: false, stats: { cpuPercent: 55 }, lastSeenAt: 't3' }];
    await emit(REMOTE_ID);
    await advance(260);
    expect(latest).not.toBe(initial);
    expect(latest?.activeRemote?.online).toBe(false);
  });

  it('cancels a pending batch on unmount', async () => {
    const view = await setup();
    await emit(REMOTE_ID);
    const invalidate = jest.spyOn(QueryClient.prototype, 'invalidateQueries');
    view.unmount();
    await advance(250);
    expect(invalidate).not.toHaveBeenCalled();
    invalidate.mockRestore();
  });
});

describe('BackendBoundary readiness gate', () => {
  it('blocks a bound project behind a retryable error panel while bindings fail, then mounts on retry', async () => {
    failBindings = true;
    renderBoundary();

    const panel = await screen.findByTestId('backend-bindings-error');
    expect(panel).toHaveTextContent('temporary binding read failure');
    expect(screen.queryByTestId('page')).toBeNull();

    failBindings = false;
    mockBindings([{ projectId: 'p1', remoteId: REMOTE_ID, state: 'remote' }]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await screen.findByTestId('page');
    expect(screen.queryByTestId('backend-bindings-error')).toBeNull();
  });

  it('marks a successfully loaded empty map ready and mounts local projects on home', async () => {
    mockSelectedProjectId = 'local-project';
    mockBindings([]);
    renderBoundary();

    await screen.findByTestId('page');
    expect(screen.queryByTestId('backend-bindings-error')).toBeNull();
  });

  it('keeps the last-known map and the mounted subtree when a refetch fails', async () => {
    mockBindings([{ projectId: 'p1', remoteId: REMOTE_ID, state: 'remote' }]);
    renderBoundary();
    await screen.findByTestId('page');

    failBindings = true;
    act(() => messageHandler?.({ topic: 'remotes', type: 'state', payload: {}, ts: '' }));

    await waitFor(() => expect(bindingFetchCount()).toBe(2));
    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(screen.queryByTestId('backend-bindings-error')).toBeNull();
  });
});

describe('toBindingMap', () => {
  it('routes only bindings the remote owns', () => {
    const map = toBindingMap([
      { projectId: 'a', remoteId: 'r1', state: 'attaching' },
      { projectId: 'b', remoteId: 'r1', state: 'remote' },
      { projectId: 'c', remoteId: 'r2', state: 'detaching' },
      { projectId: 'd', remoteId: 'r2', state: 'failed' },
    ]);
    expect([...map.entries()]).toEqual([
      ['b', 'r1'],
      ['c', 'r2'],
    ]);
  });

  it('keeps routing a remote-owned project whose live sync failed', () => {
    const map = toBindingMap([
      { projectId: 'a', remoteId: 'r1', state: 'remote', syncError: 'apply failed' },
    ]);
    expect([...map.entries()]).toEqual([['a', 'r1']]);
  });
});

describe('isBindingChangeEnvelope', () => {
  it.each([
    [{ topic: 'remotes', type: 'state' }, true],
    [{ topic: 'project/p1', type: REMOTE_BINDING_EVENT_TYPE }, true],
    [{ topic: 'project/p1', type: 'epic.updated' }, false],
    [{ topic: 'system', type: 'ping' }, false],
    [null, false],
  ])('%j → %s', (envelope, expected) => {
    expect(isBindingChangeEnvelope(envelope)).toBe(expected);
  });
});
