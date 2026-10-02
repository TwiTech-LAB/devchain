import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useHomeSocket } from './useHomeSocket';
import { REMOTES_LIST_QUERY_KEY, REMOTE_BINDINGS_QUERY_KEY } from '@/ui/lib/backend-provider';
import { useProjectNewestOperations } from './useProjectNewestOperations';
import { remoteOperationsKeys, useRemoteOperations } from './useRemoteOperations';

type RemoteOperationAction = Parameters<
  ReturnType<typeof useRemoteOperations>['action']['mutate']
>[0];

jest.mock('@/ui/components/BackendBoundary', () => ({ useHomeQueryClient: jest.fn() }));
jest.mock('./useHomeSocket', () => ({ useHomeSocket: jest.fn() }));
jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }));

async function submitAction(
  action: RemoteOperationAction,
  expectedPath: string,
): Promise<RequestInit | undefined> {
  const home = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.mocked(useHomeQueryClient).mockReturnValue(home);
  const originalFetch = global.fetch;
  const operation = {
    id: 'op-1',
    kind: 'attach',
    remoteId: 'r1',
    projectId: 'p1',
    state: 'running',
    steps: [],
    details: {},
    createdAt: 'then',
    updatedAt: 'then',
  };
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
    ok: true,
    json: async () => (init?.method === 'POST' ? operation : { items: [] }),
  })) as unknown as typeof fetch;
  const { result, unmount } = renderHook(() => useRemoteOperations(), {
    wrapper: ({ children }) => <QueryClientProvider client={home}>{children}</QueryClientProvider>,
  });

  try {
    await waitFor(() => expect(home.getQueryData(remoteOperationsKeys.all)).toEqual([]));
    act(() => result.current.action.mutate(action));
    await waitFor(() => expect(result.current.action.isSuccess).toBe(true));

    const postCall = jest
      .mocked(global.fetch)
      .mock.calls.find(
        ([input, init]) => String(input) === expectedPath && init?.method === 'POST',
      );
    expect(postCall).toBeDefined();
    return postCall?.[1];
  } finally {
    unmount();
    home.clear();
    global.fetch = originalFetch;
  }
}

// A running attach in its first file sync, and the same row after a progress report.
const RUNNING_SYNC = {
  id: 'op-1',
  kind: 'attach',
  remoteId: 'r1',
  projectId: 'p1',
  state: 'running',
  steps: [
    { id: 'file_sync_initial', label: 'Sync files to the VM', state: 'running', error: null },
  ],
  details: {},
  createdAt: 'then',
  updatedAt: 'then',
};
const SYNC_PROGRESS = {
  ...RUNNING_SYNC,
  details: {
    fileSync: { folders: { 'code:p1': { completion: 40, needItems: 3, needBytes: 9 } } },
  },
};

/** A fetch that serves RUNNING_SYNC as the only open operation, and no finished ones. */
const serveRunningSync = () =>
  jest.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => ({ items: String(input).includes('state=running') ? [RUNNING_SYNC] : [] }),
  })) as unknown as typeof fetch;

// Hook integration is the cheapest layer that detects writes to the active remote cache instead of home.
it('uses the home cache and home socket while the ambient client belongs to a remote', async () => {
  const home = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const remote = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.mocked(useHomeQueryClient).mockReturnValue(home);
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ items: [] }) }) as Response);
  const { unmount } = renderHook(() => useRemoteOperations(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={remote}>{children}</QueryClientProvider>
    ),
  });
  try {
    await waitFor(() => expect(home.getQueryData(remoteOperationsKeys.all)).toEqual([]));
    expect(remote.getQueryData(remoteOperationsKeys.all)).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/remotes/operations?state=running&limit=200',
      expect.anything(),
    );
    const invalidate = jest.spyOn(home, 'invalidateQueries');
    const handlers = jest.mocked(useHomeSocket).mock.calls.at(-1)![0];
    act(() => handlers.message?.({ topic: 'remote-operations', type: 'progress', payload: {} }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: remoteOperationsKeys.all });
    invalidate.mockClear();
    act(() => handlers.connect?.());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: remoteOperationsKeys.all });
  } finally {
    unmount();
    home.clear();
    remote.clear();
    global.fetch = originalFetch;
  }
});

it('applies a progress envelope to the cached row without a request unless the state changed', async () => {
  const home = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.mocked(useHomeQueryClient).mockReturnValue(home);
  const originalFetch = global.fetch;
  global.fetch = serveRunningSync();
  const { result, unmount } = renderHook(() => useRemoteOperations(), {
    wrapper: ({ children }) => <QueryClientProvider client={home}>{children}</QueryClientProvider>,
  });
  try {
    await waitFor(() => expect(result.current.operations).toHaveLength(1));
    const requests = jest.mocked(global.fetch).mock.calls.length;
    const invalidate = jest.spyOn(home, 'invalidateQueries');
    const handlers = jest.mocked(useHomeSocket).mock.calls.at(-1)![0];

    act(() =>
      handlers.message?.({ topic: 'remote-operations', type: 'progress', payload: SYNC_PROGRESS }),
    );

    await waitFor(() => expect(result.current.operations).toEqual([SYNC_PROGRESS]));
    expect(invalidate).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(requests);

    const done = { ...SYNC_PROGRESS, state: 'done' };
    act(() => handlers.message?.({ topic: 'remote-operations', type: 'progress', payload: done }));

    await waitFor(() => expect(result.current.operations).toEqual([done]));
    // Any state change, of any kind, refreshes the bindings and the VM list…
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: REMOTE_BINDINGS_QUERY_KEY });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: REMOTES_LIST_QUERY_KEY });
    // …and the project's newest operation, which carries a cleanup error.
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: remoteOperationsKeys.newestOfProject('p1'),
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: remoteOperationsKeys.all });
  } finally {
    unmount();
    home.clear();
    global.fetch = originalFetch;
  }
});

it("refetches a project's newest operation on a state change, and not on step progress", async () => {
  const home = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.mocked(useHomeQueryClient).mockReturnValue(home);
  const originalFetch = global.fetch;
  const newestCalls = () =>
    jest
      .mocked(global.fetch)
      .mock.calls.filter(([input]) => String(input).includes('projectId=p1'));
  global.fetch = serveRunningSync();
  const { result, unmount } = renderHook(
    () => ({ ops: useRemoteOperations(), newest: useProjectNewestOperations(['p1']) }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={home}>{children}</QueryClientProvider>
      ),
    },
  );

  try {
    await waitFor(() => expect(newestCalls()).toHaveLength(1));
    const requests = jest.mocked(global.fetch).mock.calls.length;
    const handlers = jest.mocked(useHomeSocket).mock.calls.at(-1)![0];

    act(() =>
      handlers.message?.({ topic: 'remote-operations', type: 'progress', payload: SYNC_PROGRESS }),
    );
    await waitFor(() => expect(result.current.ops.operations).toEqual([SYNC_PROGRESS]));
    expect(newestCalls()).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(requests);

    const cancelled = { ...SYNC_PROGRESS, state: 'cancelled' };
    act(() =>
      handlers.message?.({ topic: 'remote-operations', type: 'progress', payload: cancelled }),
    );
    await waitFor(() => expect(newestCalls()).toHaveLength(2));
  } finally {
    unmount();
    home.clear();
    global.fetch = originalFetch;
  }
});

it('loads open work in full and only the newest finished work', async () => {
  const home = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.mocked(useHomeQueryClient).mockReturnValue(home);
  const originalFetch = global.fetch;
  const finished = (state: 'done' | 'cancelled', minute: number) => ({
    id: `${state}-${minute}`,
    kind: 'attach',
    remoteId: 'r1',
    projectId: 'p1',
    state,
    steps: [],
    details: {},
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, minute)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 1, 0, minute)).toISOString(),
  });
  const done = Array.from({ length: 20 }, (_, index) => finished('done', index * 2));
  const cancelled = Array.from({ length: 20 }, (_, index) => finished('cancelled', index * 2 + 1));
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const state = new URL(String(input), 'http://localhost').searchParams.get('state');
    return {
      ok: true,
      json: async () => ({
        items: state === 'done' ? done : state === 'cancelled' ? cancelled : [],
      }),
    };
  }) as unknown as typeof fetch;
  const { result, unmount } = renderHook(() => useRemoteOperations(), {
    wrapper: ({ children }) => <QueryClientProvider client={home}>{children}</QueryClientProvider>,
  });
  try {
    await waitFor(() => expect(result.current.operations).toHaveLength(40));
    expect(jest.mocked(global.fetch).mock.calls.map(([input]) => String(input))).toEqual([
      '/api/remotes/operations?state=running&limit=200',
      '/api/remotes/operations?state=failed&limit=200',
      '/api/remotes/operations?state=done&limit=20',
      '/api/remotes/operations?state=cancelled&limit=20',
    ]);
    expect(result.current.recentFinished).toHaveLength(20);
    expect(result.current.recentFinished[0].id).toBe('cancelled-39');
    expect(result.current.recentFinished.at(-1)!.id).toBe('done-20');
  } finally {
    unmount();
    home.clear();
    global.fetch = originalFetch;
  }
});

it('refreshes the VM list after any successful request', async () => {
  const home = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = jest.spyOn(home, 'invalidateQueries');
  jest.mocked(useHomeQueryClient).mockReturnValue(home);
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
    ok: true,
    json: async () =>
      init?.method === 'POST'
        ? { id: 'op-1', kind: 'attach', state: 'cancelled', steps: [], details: {} }
        : { items: [] },
  })) as unknown as typeof fetch;
  const { result, unmount } = renderHook(() => useRemoteOperations(), {
    wrapper: ({ children }) => <QueryClientProvider client={home}>{children}</QueryClientProvider>,
  });
  try {
    act(() => result.current.action.mutate({ action: 'cancel', operationId: 'op-1' }));
    await waitFor(() => expect(result.current.action.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: REMOTES_LIST_QUERY_KEY });
  } finally {
    unmount();
    home.clear();
    global.fetch = originalFetch;
  }
});

it('sends Update VM without a JSON content type or body', async () => {
  const init = await submitAction(
    { action: 'updateHost', remoteId: 'r1' },
    '/api/remotes/r1/update',
  );

  expect(init).toEqual({ method: 'POST' });
});

it('sends Retry without provider choices without a JSON content type or body', async () => {
  const init = await submitAction(
    { action: 'retry', operationId: 'op-1' },
    '/api/remotes/operations/op-1/retry',
  );

  expect(init).toEqual({ method: 'POST' });
});

it('sends Cancel without a JSON content type or body', async () => {
  const init = await submitAction(
    { action: 'cancel', operationId: 'op-1' },
    '/api/remotes/operations/op-1/cancel',
  );

  expect(init).toEqual({ method: 'POST' });
});

it('keeps the JSON content type and body for Attach', async () => {
  const init = await submitAction(
    { action: 'attach', remoteId: 'r1', projectId: 'p1' },
    '/api/remotes/r1/attach',
  );

  expect(init).toEqual({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'p1' }),
  });
});

it('starts a host install with SSH credentials and estimate inputs', async () => {
  const init = await submitAction(
    {
      action: 'installHost',
      body: {
        address: '192.168.1.20',
        ssh: { user: 'ubuntu', password: 'secret' },
        providerAuth: { codex: 'generate' },
        minDiskGib: 12,
      },
    },
    '/api/remotes/host-install',
  );

  expect(init).toEqual({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: '192.168.1.20',
      ssh: { user: 'ubuntu', password: 'secret' },
      providerAuth: { codex: 'generate' },
      minDiskGib: 12,
    }),
  });
});

it('sends SSH credentials in a failed host-install retry', async () => {
  const init = await submitAction(
    {
      action: 'retry',
      operationId: 'install-op',
      ssh: { user: 'ubuntu', privateKey: 'PRIVATE KEY', passphrase: 'pass' },
    },
    '/api/remotes/operations/install-op/retry',
  );

  expect(init).toEqual({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ssh: { user: 'ubuntu', privateKey: 'PRIVATE KEY', passphrase: 'pass' },
    }),
  });
});

it.each([
  { label: 'install success', action: 'install' as const, fails: false },
  { label: 'install failure', action: 'install' as const, fails: true },
  { label: 'SSH retry success', action: 'retry' as const, fails: false },
  { label: 'SSH retry failure', action: 'retry' as const, fails: true },
])('removes credential values from mutation state and cache after $label', async (scenario) => {
  const home = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  jest.mocked(useHomeQueryClient).mockReturnValue(home);
  const originalFetch = global.fetch;
  const secrets =
    scenario.action === 'install'
      ? ['install-password-secret', 'install-sudo-secret']
      : ['retry-private-key-secret', 'retry-passphrase-secret', 'retry-sudo-secret'];
  let posted: RequestInit | undefined;
  global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted = init;
      return {
        ok: !scenario.fails,
        status: scenario.fails ? 502 : 202,
        json: async () =>
          scenario.fails
            ? { message: 'request failed' }
            : {
                id: 'op-secret-test',
                kind: 'install_host',
                remoteId: 'remote-1',
                projectId: null,
                state: 'running',
                steps: [],
                details: {},
                createdAt: 'then',
                updatedAt: 'then',
              },
      } as Response;
    }
    return { ok: true, json: async () => ({ items: [] }) } as Response;
  }) as unknown as typeof fetch;
  const { result, unmount } = renderHook(() => useRemoteOperations(), {
    wrapper: ({ children }) => <QueryClientProvider client={home}>{children}</QueryClientProvider>,
  });

  try {
    await waitFor(() => expect(home.getQueryData(remoteOperationsKeys.all)).toEqual([]));
    const action: RemoteOperationAction =
      scenario.action === 'install'
        ? {
            action: 'installHost',
            body: {
              address: '192.168.1.20',
              ssh: {
                user: 'ubuntu',
                password: secrets[0],
                sudoPassword: secrets[1],
              },
              providerAuth: {},
              minDiskGib: 8,
            },
          }
        : {
            action: 'retry',
            operationId: 'install-op',
            ssh: {
              user: 'ubuntu',
              privateKey: secrets[0],
              passphrase: secrets[1],
              sudoPassword: secrets[2],
            },
          };

    act(() => result.current.action.mutate(action));
    await waitFor(() =>
      expect(scenario.fails ? result.current.action.isError : result.current.action.isSuccess).toBe(
        true,
      ),
    );

    const requestBody = String(posted?.body);
    for (const secret of secrets) expect(requestBody).toContain(secret);
    const retained = JSON.stringify({
      observer: result.current.action.variables,
      cache: home
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    });
    for (const secret of secrets) expect(retained).not.toContain(secret);
  } finally {
    unmount();
    home.clear();
    global.fetch = originalFetch;
  }
});
