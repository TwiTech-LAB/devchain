import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { BackendBoundary } from '@/ui/components/BackendBoundary';
import { HOME_BACKEND, buildApiUrl, type BackendId } from '@/ui/lib/api-transport';
import { BackendContext } from '@/ui/lib/backend-context';
import { fetchRuntimeInfo, type RuntimeInfo } from '@/ui/lib/runtime';
import { getAppSocket, releaseAppSocket } from '@/ui/lib/socket';
import { RuntimeProvider, runtimeInfoQueryKey, useRuntime, useRuntimeSync } from './useRuntime';
import { useDismissibleNotice } from './useDismissibleNotice';

jest.mock('@/ui/lib/runtime', () => ({ fetchRuntimeInfo: jest.fn() }));
jest.mock('@/ui/lib/socket', () => ({ getAppSocket: jest.fn(), releaseAppSocket: jest.fn() }));

beforeEach(() => {
  jest.resetAllMocks();
});

// Keep the provider, query cache, BackendBoundary, and socket subscription real to catch reconnect
// freshness bugs. A remote selection gives Layout's subtree its own cache, so run both backends.
// Notice stores live for the page (module) lifetime, so each case uses its own notice id.
it.each<BackendId>([HOME_BACKEND, 'remote-1'])(
  'refetches runtime on a home socket reconnect and reveals a notice closed under the previous boot (%s selected)',
  async (activeBackend) => {
    const socket = new EventEmitter();
    jest.mocked(getAppSocket).mockReturnValue(socket as unknown as Socket);
    jest
      .mocked(fetchRuntimeInfo)
      .mockResolvedValueOnce({ bootId: 'first', version: '1' })
      .mockResolvedValueOnce({ bootId: 'second', version: '2' });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <RuntimeProvider>
          <BackendContext.Provider
            value={{
              activeBackend,
              activeRemote: null,
              ready: true,
              bindings: new Map(),
              bindingsError: null,
              retry: jest.fn(),
              apiFetch: jest.fn(),
              buildApiUrl,
            }}
          >
            <BackendBoundary>{children}</BackendBoundary>
          </BackendContext.Provider>
        </RuntimeProvider>
      </QueryClientProvider>
    );
    const { result, unmount } = renderHook(
      () => {
        useRuntimeSync();
        return {
          runtime: useRuntime(),
          notice: useDismissibleNotice({
            noticeId: `runtime-reconnect-${activeBackend}`,
            itemKeys: ['a'],
          }),
        };
      },
      { wrapper },
    );
    expect(result.current.notice.visible).toBe(false);
    await waitFor(() => expect(result.current.runtime.runtimeInfo?.bootId).toBe('first'));
    expect(result.current.notice.visible).toBe(true);
    act(() => result.current.notice.closeUntilRestart());
    expect(result.current.notice.visible).toBe(false);
    expect(getAppSocket).toHaveBeenCalledWith(HOME_BACKEND);
    act(() => {
      socket.emit('disconnect');
      socket.emit('connect');
    });
    await waitFor(() => expect(result.current.runtime.runtimeInfo?.bootId).toBe('second'));
    expect(result.current.notice.visible).toBe(true);
    unmount();
    expect(socket.listenerCount('connect')).toBe(0);
    expect(socket.listenerCount('disconnect')).toBe(0);
    expect(releaseAppSocket).toHaveBeenCalledWith(HOME_BACKEND);
    client.clear();
  },
);

// A remote browser's first handshake lands after RuntimeProvider's own fetch. fetchRuntimeInfo is
// the network boundary, so its call count is the contract; Date.now is pinned because TanStack
// stamps dataUpdatedAt with it and a mocked fetch can resolve in the mount's millisecond.
it('skips the first handshake when runtime info loaded after mount', async () => {
  const socket = new EventEmitter();
  jest.mocked(getAppSocket).mockReturnValue(socket as unknown as Socket);
  let resolveFirst!: (info: RuntimeInfo) => void;
  jest.mocked(fetchRuntimeInfo).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveFirst = resolve;
    }),
  );
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <RuntimeProvider>{children}</RuntimeProvider>
    </QueryClientProvider>
  );
  try {
    const { result, unmount } = renderHook(
      () => {
        useRuntimeSync();
        return useRuntime();
      },
      { wrapper },
    );
    now.mockReturnValue(2_000);
    await act(async () => {
      resolveFirst({ bootId: 'first', version: '1' });
    });
    await waitFor(() => expect(result.current.runtimeInfo?.bootId).toBe('first'));
    await act(async () => {
      socket.emit('connect');
    });
    expect(fetchRuntimeInfo).toHaveBeenCalledTimes(1);
    unmount();
  } finally {
    now.mockRestore();
    client.clear();
  }
});

// Layout can remount (backend switch) or the pooled socket can be recreated while home is down:
// that hook instance never sees the disconnect, so a socket not connected at mount counts as one.
it('refetches on the first connect when cached runtime info predates the mount', async () => {
  const socket = new EventEmitter();
  jest.mocked(getAppSocket).mockReturnValue(socket as unknown as Socket);
  jest.mocked(fetchRuntimeInfo).mockResolvedValueOnce({ bootId: 'second', version: '2' });
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  client.setQueryData(runtimeInfoQueryKey, { bootId: 'first', version: '1' });
  now.mockReturnValue(2_000);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <RuntimeProvider>{children}</RuntimeProvider>
    </QueryClientProvider>
  );
  try {
    const { result, unmount } = renderHook(
      () => {
        useRuntimeSync();
        return useRuntime();
      },
      { wrapper },
    );
    expect(result.current.runtimeInfo?.bootId).toBe('first');
    await act(async () => {
      socket.emit('connect');
    });
    await waitFor(() => expect(result.current.runtimeInfo?.bootId).toBe('second'));
    unmount();
  } finally {
    now.mockRestore();
    client.clear();
  }
});
