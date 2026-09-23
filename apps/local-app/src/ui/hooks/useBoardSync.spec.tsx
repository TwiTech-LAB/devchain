import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { boardCacheKeys } from '@/ui/lib/board-cache';
import { dispatchRealtimeEnvelope } from '@/ui/lib/realtime-invalidation-registry';
import { useBoardSync } from './useBoardSync';
import { useAppSocket } from './useAppSocket';

jest.mock('./useAppSocket', () => ({ useAppSocket: jest.fn() }));
jest.mock('@/ui/lib/realtime-invalidation-registry', () => {
  const actual = jest.requireActual('@/ui/lib/realtime-invalidation-registry');
  return { ...actual, dispatchRealtimeEnvelope: jest.fn() };
});

const useAppSocketMock = jest.mocked(useAppSocket);
const dispatchRealtimeEnvelopeMock = jest.mocked(dispatchRealtimeEnvelope);

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useBoardSync', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useAppSocketMock.mockClear();
    dispatchRealtimeEnvelopeMock.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('refreshes at 60 seconds and cleans up the timer on unmount', () => {
    const queryClient = createQueryClient();
    const projectListKey = boardCacheKeys.list('project-1', 'active');
    const countKey = boardCacheKeys.subCounts('root-1');
    const parentKey = boardCacheKeys.children('root-1');
    queryClient.setQueryData(projectListKey, { items: [] });
    queryClient.setQueryData(countKey, { total: 1 });
    queryClient.setQueryData(parentKey, { items: [] });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');

    const { unmount } = renderHook(
      () => useBoardSync({ selectedProjectId: 'project-1', parentFilter: 'root-1' }),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      jest.advanceTimersByTime(59999);
    });
    expect(invalidate).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(queryClient.getQueryState(projectListKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(countKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(parentKey)?.isInvalidated).toBe(true);

    unmount();
    invalidate.mockClear();
    act(() => {
      jest.advanceTimersByTime(60000);
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('keeps the registry and socket callbacks stable across an unrelated render', () => {
    const queryClient = createQueryClient();
    const { rerender } = renderHook(
      ({ revision }: { revision: number }) => {
        useBoardSync({ selectedProjectId: 'project-1', parentFilter: 'root-1' });
        return revision;
      },
      {
        initialProps: { revision: 0 },
        wrapper: createWrapper(queryClient),
      },
    );

    const firstCall = useAppSocketMock.mock.calls[0];
    const firstHandlers = firstCall[0];
    const firstDeps = firstCall[1];
    rerender({ revision: 1 });
    const secondCall = useAppSocketMock.mock.calls[1];
    const secondHandlers = secondCall[0];
    const secondDeps = secondCall[1];

    expect(secondHandlers.message).toBe(firstHandlers.message);
    expect(secondHandlers.connect).toBe(firstHandlers.connect);
    expect(secondDeps[0]).toBe(firstDeps[0]);
    expect(secondDeps[1]).toBe(firstDeps[1]);

    const envelope = {
      topic: 'project/project-1/epics',
      type: 'updated',
      payload: {},
      ts: new Date().toISOString(),
    };
    act(() => {
      firstHandlers.message(envelope);
      secondHandlers.message(envelope);
    });

    expect(dispatchRealtimeEnvelopeMock).toHaveBeenCalledTimes(2);
    expect(dispatchRealtimeEnvelopeMock.mock.calls[0][1]).toBe(
      dispatchRealtimeEnvelopeMock.mock.calls[1][1],
    );
  });
});
