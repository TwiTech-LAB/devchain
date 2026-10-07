/** @jest-environment jsdom */

import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { useHomeSocket } from '@/ui/hooks/useHomeSocket';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useRemotes } from '@/ui/hooks/useRemotes';
import { BackendProvider, REMOTES_LIST_QUERY_KEY } from '@/ui/lib/backend-provider';
import { setAppSocket } from '@/ui/lib/socket';
import { BackendBoundary, HomeQueryScope, ProjectGate, RemoteBadge } from './BackendBoundary';

jest.mock('socket.io-client', () => ({ io: jest.fn() }));

let mockSelectedProjectId: string | undefined;
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({ selectedProjectId: mockSelectedProjectId }),
}));

const REMOTE_ID = '11111111-1111-4111-8111-111111111111';
const BOUND_PROJECT = 'bound-project';
const LOCAL_PROJECT = 'local-project';

interface MockSocket {
  path: string;
  on: jest.Mock;
  off: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
}

let sockets: MockSocket[] = [];
let remotes: Array<Record<string, unknown>> = [];
let mounts = 0;
let seenSockets: { app?: Socket; home?: Socket } = {};

const fetchMock = jest.fn(async (url: string) => {
  let body: unknown = {};
  if (url === '/api/remotes/bindings') {
    body = { items: [{ projectId: BOUND_PROJECT, remoteId: REMOTE_ID, state: 'remote' }] };
  } else if (url === '/api/remotes') {
    body = { items: remotes };
  } else if (url.endsWith('/api/providers')) {
    body = { source: url.startsWith('/r/') ? 'remote' : 'home' };
  }
  return { ok: true, status: 200, json: async () => body } as Response;
});

function ProjectPage() {
  seenSockets = { app: useAppSocket({}), home: useHomeSocket({}) };
  const fetchFn = useFetchFactory();
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: async () => (await fetchFn('/api/providers')).json() as Promise<{ source: string }>,
  });
  useEffect(() => {
    mounts++;
  }, []);
  return <div data-testid="providers">{providers.data?.source ?? 'loading'}</div>;
}

function renderApp(homeClient: QueryClient) {
  return render(
    <MemoryRouter initialEntries={['/board']}>
      <QueryClientProvider client={homeClient}>
        <BackendProvider>
          <BackendBoundary>
            <RemoteBadge />
            <ProjectGate scope="page">
              <ProjectPage />
            </ProjectGate>
          </BackendBoundary>
        </BackendProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function openSockets(path: string): MockSocket[] {
  return sockets.filter((socket) => socket.path === path && !socket.disconnect.mock.calls.length);
}

const originalFetch = global.fetch;

beforeEach(() => {
  mockSelectedProjectId = LOCAL_PROJECT;
  sockets = [];
  mounts = 0;
  seenSockets = {};
  remotes = [
    { id: REMOTE_ID, name: 'lab-vm', online: true, version: '1.0.0', versionMatches: true },
  ];
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.mocked(io).mockImplementation(((_url: string, options: { path: string }) => {
    const socket: MockSocket = {
      path: options.path,
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
      disconnect: jest.fn(),
    };
    sockets.push(socket);
    return socket;
  }) as unknown as typeof io);
});

afterEach(() => {
  global.fetch = originalFetch;
  setAppSocket(null);
});

function newHomeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('BackendBoundary', () => {
  it('shares one pooled socket between the project and home hooks for a local project', async () => {
    const { unmount } = renderApp(newHomeClient());
    await waitFor(() => expect(screen.getByTestId('providers').textContent).toBe('home'));

    expect(seenSockets.app).toBeDefined();
    expect(seenSockets.app).toBe(seenSockets.home);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].path).toBe('/socket.io');
    expect(screen.queryByTestId('remote-backend-badge')).toBeNull();

    unmount();

    // Provider, page project hook and page home hook each held one ref.
    expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('switches to a bound project with one remote socket, one remount and an empty cache', async () => {
    const homeClient = newHomeClient();
    const { rerender } = renderApp(homeClient);
    await waitFor(() => expect(screen.getByTestId('providers').textContent).toBe('home'));
    expect(mounts).toBe(1);
    expect(homeClient.getQueryData(['providers'])).toEqual({ source: 'home' });

    mockSelectedProjectId = BOUND_PROJECT;
    rerender(
      <MemoryRouter initialEntries={['/board']}>
        <QueryClientProvider client={homeClient}>
          <BackendProvider>
            <BackendBoundary>
              <RemoteBadge />
              <ProjectGate scope="page">
                <ProjectPage />
              </ProjectGate>
            </BackendBoundary>
          </BackendProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // The remote subtree never sees the home ['providers'] entry.
    expect(screen.getByTestId('providers').textContent).toBe('loading');
    await waitFor(() => expect(screen.getByTestId('providers').textContent).toBe('remote'));
    expect(mounts).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith(`/r/${REMOTE_ID}/api/providers`, undefined);
    expect(openSockets(`/r/${REMOTE_ID}/socket.io`)).toHaveLength(1);
    expect(seenSockets.app).not.toBe(seenSockets.home);
    expect(screen.getByTestId('remote-backend-badge').textContent).toBe('Remote: lab-vm');

    mockSelectedProjectId = LOCAL_PROJECT;
    rerender(
      <MemoryRouter initialEntries={['/board']}>
        <QueryClientProvider client={homeClient}>
          <BackendProvider>
            <BackendBoundary>
              <RemoteBadge />
              <ProjectGate scope="page">
                <ProjectPage />
              </ProjectGate>
            </BackendBoundary>
          </BackendProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Back home: the cached home entry shows at once and the remote socket is released.
    expect(screen.getByTestId('providers').textContent).toBe('home');
    expect(mounts).toBe(3);
    expect(openSockets(`/r/${REMOTE_ID}/socket.io`)).toHaveLength(0);
    expect(openSockets('/socket.io')).toHaveLength(1);
    expect(screen.queryByTestId('remote-backend-badge')).toBeNull();
  });

  it('starts a bound project on its remote without first querying home', async () => {
    mockSelectedProjectId = BOUND_PROJECT;
    renderApp(newHomeClient());

    await waitFor(() => expect(screen.getByTestId('providers').textContent).toBe('remote'));
    const providerCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith('/api/providers'));
    expect(providerCalls).toEqual([[`/r/${REMOTE_ID}/api/providers`, undefined]]);
    expect(mounts).toBe(1);
  });

  it.each([
    {
      label: 'version differs',
      remote: {
        id: REMOTE_ID,
        name: 'lab-vm',
        online: true,
        version: '0.9.0',
        versionMatches: false,
      },
      text: 'needs update',
      version: '0.9.0',
    },
    {
      label: 'API key rejected',
      remote: {
        id: REMOTE_ID,
        name: 'lab-vm',
        online: true,
        apiKeyRejected: true,
        version: '1.0.0',
        versionMatches: true,
      },
      text: "rejected this PC's API key",
      version: null,
    },
  ] as const)('blocks page query when $label', async ({ remote, text, version }) => {
    remotes = [remote];
    mockSelectedProjectId = BOUND_PROJECT;
    renderApp(newHomeClient());
    const banner = await screen.findByTestId('remote-unavailable-banner');
    expect(banner.textContent).toContain(text);
    if (version) expect(banner.textContent).toContain(version);
    expect(screen.getByTestId('remote-backend-badge').textContent).toBe('Remote: lab-vm');
    expect(screen.queryByTestId('providers')).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/api/providers'))).toBe(false);
  });

  it('refreshes the badge and banner when the remote comes back up to date', async () => {
    remotes = [
      { id: REMOTE_ID, name: 'lab-vm', online: true, version: '0.9.0', versionMatches: false },
    ];
    mockSelectedProjectId = BOUND_PROJECT;
    renderApp(newHomeClient());
    await screen.findByTestId('remote-unavailable-banner');

    remotes = [
      { id: REMOTE_ID, name: 'lab-vm', online: true, version: '1.0.0', versionMatches: true },
    ];
    const homeHandler = sockets[0].on.mock.calls
      .filter(([event]) => event === 'message')
      .map(([, handler]) => handler as (envelope: unknown) => void);
    act(() => homeHandler.forEach((handler) => handler({ topic: 'remotes', type: 'state' })));

    await waitFor(() => expect(screen.getByTestId('providers').textContent).toBe('remote'));
    expect(screen.queryByTestId('remote-unavailable-banner')).toBeNull();
  });

  it('gives useRemotes the home client under a remote boundary, distinct from the remote client', async () => {
    mockSelectedProjectId = BOUND_PROJECT;
    const homeClient = newHomeClient();
    let remoteScopedClient: QueryClient | undefined;
    let remotesFromHook: Array<{ id: string }> = [];

    function AmbientClientProbe() {
      remoteScopedClient = useQueryClient();
      return null;
    }

    function RemotesProbe() {
      const { remotes } = useRemotes();
      remotesFromHook = remotes as Array<{ id: string }>;
      return <div data-testid="remotes-count">{remotes.length}</div>;
    }

    render(
      <MemoryRouter initialEntries={['/cloud']}>
        <QueryClientProvider client={homeClient}>
          <BackendProvider>
            <BackendBoundary>
              <AmbientClientProbe />
              <HomeQueryScope>
                <RemotesProbe />
              </HomeQueryScope>
            </BackendBoundary>
          </BackendProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('remotes-count').textContent).toBe('1'));

    // Under this boundary the ambient client is remote-scoped (project is bound), but
    // `useRemotes` (inside `HomeQueryScope`) reads and caches on the home client instead.
    expect(remoteScopedClient).toBeDefined();
    expect(remoteScopedClient).not.toBe(homeClient);
    expect(homeClient.getQueryData(REMOTES_LIST_QUERY_KEY)).toEqual(remotesFromHook);
    expect(remoteScopedClient!.getQueryData(REMOTES_LIST_QUERY_KEY)).toBeUndefined();
  });

  it('bypasses the unavailable banner on a home route but shows it again on a project route', async () => {
    remotes = [
      { id: REMOTE_ID, name: 'lab-vm', online: false, version: '1.0.0', versionMatches: true },
    ];
    mockSelectedProjectId = BOUND_PROJECT;

    function renderAt(path: string) {
      return render(
        <MemoryRouter initialEntries={[path]}>
          <QueryClientProvider client={newHomeClient()}>
            <BackendProvider>
              <BackendBoundary>
                <ProjectGate scope="page">
                  <ProjectPage />
                </ProjectGate>
              </BackendBoundary>
            </BackendProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    }

    const onCloud = renderAt('/cloud');
    await screen.findByTestId('providers');
    expect(screen.queryByTestId('remote-unavailable-banner')).toBeNull();
    onCloud.unmount();

    renderAt('/board');
    await screen.findByTestId('remote-unavailable-banner');
    expect(screen.queryByTestId('providers')).toBeNull();
  });
});
