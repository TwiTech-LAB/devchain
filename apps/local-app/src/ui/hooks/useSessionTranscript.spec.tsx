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
  it('returns base 250ms for small sessions (count < 200)', () => {
    expect(computeAdaptiveDebounceMs(0)).toBe(250);
    expect(computeAdaptiveDebounceMs(50)).toBe(250);
    expect(computeAdaptiveDebounceMs(199)).toBe(250);
  });

  it('scales debounce with message count for medium sessions', () => {
    expect(computeAdaptiveDebounceMs(200)).toBe(750);
    expect(computeAdaptiveDebounceMs(400)).toBe(1250);
    expect(computeAdaptiveDebounceMs(600)).toBe(1750);
    expect(computeAdaptiveDebounceMs(1000)).toBe(2750);
  });

  it('caps at 5000ms for large sessions', () => {
    expect(computeAdaptiveDebounceMs(2000)).toBe(5000);
    expect(computeAdaptiveDebounceMs(5000)).toBe(5000);
    expect(computeAdaptiveDebounceMs(100000)).toBe(5000);
  });

  it('returns base 250ms when messageCount is undefined', () => {
    expect(computeAdaptiveDebounceMs(undefined)).toBe(250);
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

  it('should not fetch when sessionId is null', () => {
    renderHook(() => useSessionTranscript(null), {
      wrapper: createWrapper(queryClient),
    });

    expect(fetchTranscriptSummaryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return empty defaults when sessionId is null', () => {
    const { result } = renderHook(() => useSessionTranscript(null), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.metrics).toBeUndefined();
    expect(result.current.isLive).toBe(false);
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

  it('should register a WS message handler via useAppSocket', () => {
    fetchTranscriptSummaryMock.mockResolvedValue(makeSummary());

    renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    expect(useAppSocketMock).toHaveBeenCalled();
    const handlers = useAppSocketMock.mock.calls[0][0];
    expect(handlers).toHaveProperty('message');
    expect(typeof handlers.message).toBe('function');
  });

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

  it('should invalidate the summary on WS "updated" event after debounce', async () => {
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
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: transcriptQueryKeys.summary('session-1'),
      });
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
    });
  });

  it('should invalidate the summary on WS "discovered" event', async () => {
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
        topic: 'session/session-1/transcript',
        type: 'discovered',
        payload: { sessionId: 'session-1', providerName: 'claude-code' },
        ts: new Date().toISOString(),
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: transcriptQueryKeys.summary('session-1'),
    });
  });

  it('should invalidate the summary on WS "ended" event', async () => {
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
        topic: 'session/session-1/transcript',
        type: 'ended',
        payload: { sessionId: 'session-1', finalMetrics: {}, endReason: 'session.stopped' },
        ts: new Date().toISOString(),
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: transcriptQueryKeys.summary('session-1'),
    });
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

  it('should set isLive=true when session is ongoing', async () => {
    const summary = makeSummary({ isOngoing: true });

    fetchTranscriptSummaryMock.mockResolvedValue(summary);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isLive).toBe(true);
    });
  });

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

  it('keeps a running DevChain session live after a completed transcript turn', async () => {
    const summary = makeSummary({ isOngoing: false });

    fetchTranscriptSummaryMock.mockResolvedValue(summary);

    const { result } = renderHook(
      () => useSessionTranscript('session-1', { isSessionRunning: true }),
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(result.current.metrics).toBeDefined();
    });

    expect(result.current.isLive).toBe(true);

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
    ).toBe(5_000);
  });

  it('stops summary polling when DevChain lifecycle reports the session stopped', async () => {
    const summary = makeSummary({ isOngoing: true });

    fetchTranscriptSummaryMock.mockResolvedValue(summary);

    const { result } = renderHook(
      () => useSessionTranscript('session-1', { isSessionRunning: false }),
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(result.current.metrics).toBeDefined();
    });

    expect(result.current.isLive).toBe(false);

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
    ).toBe(false);
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

    expect(() => result.current.refetch()).not.toThrow();
  });
});
