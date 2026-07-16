import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DEBUG_METRICS_HISTORY_LIMIT,
  DEBUG_METRICS_POLL_MS,
  SnapshotRing,
  type DebugMetricsSnapshot,
  useDebugMetrics,
} from './useDebugMetrics';

function snapshot(index: number): DebugMetricsSnapshot {
  return {
    timestamp: new Date(index * 1000).toISOString(),
    process: {
      pid: 1,
      memory: { rss: index, heapTotal: 2, heapUsed: 1, external: 0, arrayBuffers: 0 },
      eventLoopDelay: null,
      listeners: { SIGINT: 1 },
    },
    caches: { aggregate: { entries: 0, bytesEstimated: index, hits: 0, misses: 0, hitRate: 0 } },
    frameBuffers: { sessions: 0, totalFrames: 0, bytesEstimated: 0 },
    pty: { activeSessions: 0 },
    sockets: { connectedClients: 0 },
  };
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useDebugMetrics', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('hard-bounds and clears its snapshot ring', () => {
    const ring = new SnapshotRing();
    let values: DebugMetricsSnapshot[] = [];
    for (let index = 0; index < DEBUG_METRICS_HISTORY_LIMIT + 5; index += 1) {
      values = ring.push(snapshot(index));
    }
    expect(values).toHaveLength(DEBUG_METRICS_HISTORY_LIMIT);
    expect(values[0].process.memory.rss).toBe(5);
    ring.clear();
    expect(ring.size).toBe(0);
  });

  it('polls every ten seconds and clears local history on unmount', async () => {
    jest.useFakeTimers();
    const clearSpy = jest.spyOn(SnapshotRing.prototype, 'clear');
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => snapshot(1) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useDebugMetrics(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.history).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(DEBUG_METRICS_POLL_MS);
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    unmount();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(DEBUG_METRICS_POLL_MS * 2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
