import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import {
  useSessionTranscript,
  transcriptQueryKeys,
  computeAdaptiveDebounceMs,
  type TranscriptSummary,
} from './useSessionTranscript';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { fetchTranscriptSummary } from '@/ui/lib/sessions';
import type { WsEnvelope } from '@/ui/lib/socket';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchTranscriptSummary: jest.fn(),
}));

const useAppSocketMock = useAppSocket as jest.MockedFunction<typeof useAppSocket>;
const fetchTranscriptSummaryMock = fetchTranscriptSummary as jest.MockedFunction<
  typeof fetchTranscriptSummary
>;

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSocket(): Socket {
  return {
    connected: true,
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  } as unknown as Socket;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function makeSummary(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  return {
    sessionId: 'session-1',
    providerName: 'claude-code',
    metrics: {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
      totalTokens: 360,
      totalContextConsumption: 300,
      compactionCount: 0,
      phaseBreakdowns: [],
      visibleContextTokens: 10_000,
      totalContextTokens: 0,
      contextWindowTokens: 200_000,
      costUsd: 0.005,
      primaryModel: 'claude-sonnet-4-6',
      durationMs: 5000,
      messageCount: 2,
      isOngoing: true,
    },
    messageCount: 2,
    isOngoing: true,
    ...overrides,
  };
}

/** Extract the WS `message` handler passed to useAppSocket */
function captureWsHandler(): (envelope: WsEnvelope) => void {
  const handlers = useAppSocketMock.mock.calls[0]?.[0];
  if (!handlers?.message) throw new Error('useAppSocket not called or no message handler');
  return handlers.message as (envelope: WsEnvelope) => void;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeAdaptiveDebounceMs', () => {
  it.each([
    {
      label: 'returns base 250ms for small sessions (count < 200)',
      firstCount: 0,
      firstExpected: 250,
      secondCount: 50,
      secondExpected: 250,
      thirdCount: 199,
      thirdExpected: 250,
    },
    {
      label: 'caps at 5000ms for large sessions',
      firstCount: 2000,
      firstExpected: 5000,
      secondCount: 5000,
      secondExpected: 5000,
      thirdCount: 100000,
      thirdExpected: 5000,
    },
  ] as const)(
    '$label',
    ({ firstCount, firstExpected, secondCount, secondExpected, thirdCount, thirdExpected }) => {
      expect(computeAdaptiveDebounceMs(firstCount)).toBe(firstExpected);
      expect(computeAdaptiveDebounceMs(secondCount)).toBe(secondExpected);
      expect(computeAdaptiveDebounceMs(thirdCount)).toBe(thirdExpected);
    },
  );

  it.each([
    {
      label: 'medium sessions',
      cases: [
        [200, 750],
        [400, 1250],
        [600, 1750],
        [1000, 2750],
      ],
    },
    { label: 'missing count', cases: [[undefined, 250]] },
  ] as const)('uses adaptive debounce for $label', ({ cases }) => {
    for (const [count, expected] of cases) expect(computeAdaptiveDebounceMs(count)).toBe(expected);
  });
});

describe('useSessionTranscript', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = createQueryClient();
    useAppSocketMock.mockReturnValue(createMockSocket());
    global.fetch = fetchMock;
    fetchMock.mockClear();
  });

  afterEach(() => {
    queryClient.clear();
  });

  // -------------------------------------------------------------------------
  // Disabled (null sessionId)
  // -------------------------------------------------------------------------

  it('should return empty defaults when sessionId is null', () => {
    const { result } = renderHook(() => useSessionTranscript(null), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.metrics).toBeUndefined();
    expect(result.current.isLive).toBe(false);
    expect(fetchTranscriptSummaryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Data fetching — summary only; the full transcript route must never be called
  // -------------------------------------------------------------------------

  it('should fetch only the summary when sessionId is provided', async () => {
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.metrics).toEqual(summary.metrics);
    });

    expect(fetchTranscriptSummaryMock).toHaveBeenCalledWith('session-1', expect.any(Function));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isLive).toBe(true);
  });

  it('should never issue a full-transcript request across WS events', async () => {
    fetchTranscriptSummaryMock.mockResolvedValue(makeSummary());

    const { result } = renderHook(
      () => useSessionTranscript('session-1', { wsInvalidationDebounceMs: 10 }),
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(result.current.metrics).toBeDefined();
    });

    const handler = captureWsHandler();
    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        payload: { kind: 'delta', sessionId: 'session-1', newMessageCount: 3, metrics: {} },
        ts: new Date().toISOString(),
      });
      handler({
        topic: 'session/session-1/transcript',
        type: 'discovered',
        payload: { sessionId: 'session-1', providerName: 'claude-code' },
        ts: new Date().toISOString(),
      });
      handler({
        topic: 'session/session-1/transcript',
        type: 'ended',
        payload: { sessionId: 'session-1', finalMetrics: {}, endReason: 'session.stopped' },
        ts: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(fetchTranscriptSummaryMock.mock.calls.length).toBeGreaterThan(1);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // WebSocket subscription
  // -------------------------------------------------------------------------

  it('refreshes only the summary for an addressed runtime-context update', async () => {
    fetchTranscriptSummaryMock.mockResolvedValue(makeSummary());
    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.metrics).toBeDefined());
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    invalidateSpy.mockClear();

    act(() => {
      captureWsHandler()({
        topic: 'session/session-1/runtime-context',
        type: 'updated',
        payload: { sessionId: 'session-1' },
        ts: new Date().toISOString(),
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: transcriptQueryKeys.summary('session-1'),
      exact: true,
    });
  });

  it('should coalesce burst WS "updated" events into one invalidation cycle', async () => {
    fetchTranscriptSummaryMock.mockResolvedValue(makeSummary());

    const { result } = renderHook(
      () => useSessionTranscript('session-1', { wsInvalidationDebounceMs: 10 }),
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(result.current.metrics).toBeDefined();
    });

    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const handler = captureWsHandler();

    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        payload: { sessionId: 'session-1', newMessageCount: 3, metrics: {} },
        ts: new Date().toISOString(),
      });
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        payload: { sessionId: 'session-1', newMessageCount: 4, metrics: {} },
        ts: new Date().toISOString(),
      });
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        payload: { sessionId: 'session-1', newMessageCount: 5, metrics: {} },
        ts: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: transcriptQueryKeys.summary('session-1'),
      });
    });
  });

  it.each([
    { type: 'discovered', payload: { sessionId: 'session-1', providerName: 'claude-code' } },
    { type: 'ended', payload: { sessionId: 'session-1' } },
  ] as const)('invalidates summary on $type', async ({ type, payload }) => {
    fetchTranscriptSummaryMock.mockResolvedValue(makeSummary());
    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.metrics).toBeDefined());
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    const handler = captureWsHandler();
    act(() =>
      handler({
        topic: 'session/session-1/transcript',
        type,
        payload,
        ts: new Date().toISOString(),
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: transcriptQueryKeys.summary('session-1') });
  });

  it('should ignore WS events for different sessions', async () => {
    fetchTranscriptSummaryMock.mockResolvedValue(makeSummary());

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.metrics).toBeDefined();
    });

    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
    const handler = captureWsHandler();

    act(() => {
      handler({
        topic: 'session/session-OTHER/transcript',
        type: 'updated',
        payload: { sessionId: 'session-OTHER', newMessageCount: 5, metrics: {} },
        ts: new Date().toISOString(),
      });
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // isLive
  // -------------------------------------------------------------------------

  it('should set isLive=false when session is not ongoing', async () => {
    const summary = makeSummary({ isOngoing: false });

    fetchTranscriptSummaryMock.mockResolvedValue(summary);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.metrics).toBeDefined();
    });

    expect(result.current.isLive).toBe(false);
  });

  it.each([
    {
      label: 'keeps a running DevChain session live after a completed transcript turn',
      isOngoing: false,
      isSessionRunning: true,
      expectedLive: true,
      expectedInterval: 5_000,
    },
    {
      label: 'stops summary polling when DevChain lifecycle reports the session stopped',
      isOngoing: true,
      isSessionRunning: false,
      expectedLive: false,
      expectedInterval: false,
    },
  ] as const)('$label', async ({ isOngoing, isSessionRunning, expectedLive, expectedInterval }) => {
    const summary = makeSummary({ isOngoing: isOngoing });

    fetchTranscriptSummaryMock.mockResolvedValue(summary);

    const { result } = renderHook(
      () => useSessionTranscript('session-1', { isSessionRunning: isSessionRunning }),
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(result.current.metrics).toBeDefined();
    });

    expect(result.current.isLive).toBe(expectedLive);

    const summaryOptions: unknown = queryClient.getQueryCache().find({
      queryKey: transcriptQueryKeys.summary('session-1'),
      exact: true,
    })?.options;
    const refetchInterval =
      summaryOptions !== null &&
      typeof summaryOptions === 'object' &&
      'refetchInterval' in summaryOptions
        ? summaryOptions.refetchInterval
        : undefined;
    expect(typeof refetchInterval).toBe('function');
    expect(
      (
        refetchInterval as (query: {
          state: { data: ReturnType<typeof makeSummary> };
        }) => number | false
      )({ state: { data: summary } }),
    ).toBe(expectedInterval);
  });

  // -------------------------------------------------------------------------
  // Query keys
  // -------------------------------------------------------------------------

  it('should export correct query keys', () => {
    expect(transcriptQueryKeys.summary('abc')).toEqual(['transcript-summary', 'abc']);
    expect(transcriptQueryKeys.index('abc')).toEqual(['transcript-index', 'abc']);
    expect(transcriptQueryKeys.chunkPage('abc', null, 10)).toEqual([
      'transcript-chunk-page',
      'abc',
      null,
      10,
    ]);
    expect(transcriptQueryKeys.summary(null)).toEqual(['transcript-summary', null]);
  });

  // -------------------------------------------------------------------------
  // Refetch
  // -------------------------------------------------------------------------

  it('should provide a refetch function', async () => {
    fetchTranscriptSummaryMock.mockResolvedValue(makeSummary());

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.metrics).toBeDefined();
    });

    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => {
      result.current.refetch();
    });

    // Should invalidate summary query
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: transcriptQueryKeys.summary('session-1'),
    });
  });

  it('should not throw when refetch is called with null sessionId', () => {
    const { result } = renderHook(() => useSessionTranscript(null), {
      wrapper: createWrapper(queryClient),
    });

    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    expect(() => result.current.refetch()).not.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
