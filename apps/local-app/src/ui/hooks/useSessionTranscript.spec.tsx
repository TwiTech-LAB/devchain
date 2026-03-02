import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import {
  useSessionTranscript,
  transcriptQueryKeys,
  type SerializedSession,
  type TranscriptSummary,
} from './useSessionTranscript';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { fetchJsonOrThrow, fetchTranscriptSummary } from '@/ui/lib/sessions';
import type { WsEnvelope } from '@/ui/lib/socket';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchJsonOrThrow: jest.fn(),
  fetchTranscriptSummary: jest.fn(),
}));

const useAppSocketMock = useAppSocket as jest.MockedFunction<typeof useAppSocket>;
const fetchJsonOrThrowMock = fetchJsonOrThrow as jest.MockedFunction<typeof fetchJsonOrThrow>;
const fetchTranscriptSummaryMock = fetchTranscriptSummary as jest.MockedFunction<
  typeof fetchTranscriptSummary
>;

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

function makeSession(overrides: Partial<SerializedSession> = {}): SerializedSession {
  return {
    id: 'session-1',
    providerName: 'claude-code',
    filePath: '/tmp/session.jsonl',
    messages: [
      {
        id: 'msg-1',
        parentId: null,
        role: 'user',
        timestamp: '2026-02-24T10:00:00.000Z',
        content: [{ type: 'text', text: 'Hello' }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
      },
      {
        id: 'msg-2',
        parentId: 'msg-1',
        role: 'assistant',
        timestamp: '2026-02-24T10:00:05.000Z',
        content: [{ type: 'text', text: 'Hi there!' }],
        model: 'claude-sonnet-4-6',
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
      },
    ],
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
    isOngoing: true,
    ...overrides,
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

describe('useSessionTranscript', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = createQueryClient();
    useAppSocketMock.mockReturnValue(createMockSocket());
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

    expect(fetchJsonOrThrowMock).not.toHaveBeenCalled();
  });

  it('should return empty defaults when sessionId is null', () => {
    const { result } = renderHook(() => useSessionTranscript(null), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.session).toBeUndefined();
    expect(result.current.messages).toEqual([]);
    expect(result.current.chunks).toEqual([]);
    expect(result.current.metrics).toBeUndefined();
    expect(result.current.isLive).toBe(false);
    expect(result.current.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  it('should fetch transcript and summary when sessionId is provided', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
    });

    expect(result.current.session).toEqual(session);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.metrics).toEqual(summary.metrics);
    expect(result.current.isLive).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('should fetch summary only when transcript is disabled', async () => {
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);

    const { result } = renderHook(
      () => useSessionTranscript('session-1', { enableTranscript: false }),
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(result.current.metrics).toEqual(summary.metrics);
    });

    expect(fetchTranscriptSummaryMock).toHaveBeenCalledWith('session-1');
    expect(fetchJsonOrThrowMock).not.toHaveBeenCalled();
    expect(result.current.session).toBeUndefined();
    expect(result.current.messages).toEqual([]);
    expect(result.current.chunks).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('should fetch transcript when transcript mode is enabled after being disabled', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result, rerender } = renderHook(
      ({ enableTranscript }: { enableTranscript: boolean }) =>
        useSessionTranscript('session-1', { enableTranscript }),
      {
        wrapper: createWrapper(queryClient),
        initialProps: { enableTranscript: false },
      },
    );

    await waitFor(() => {
      expect(result.current.metrics).toEqual(summary.metrics);
    });

    const urlsBeforeActivation = fetchJsonOrThrowMock.mock.calls.map(([url]) => String(url));
    expect(urlsBeforeActivation.some((url) => url.endsWith('/transcript'))).toBe(false);

    rerender({ enableTranscript: true });

    await waitFor(() => {
      expect(result.current.session).toEqual(session);
    });

    const urlsAfterActivation = fetchJsonOrThrowMock.mock.calls.map(([url]) => String(url));
    expect(urlsAfterActivation.some((url) => url.endsWith('/transcript'))).toBe(true);
    expect(result.current.messages).toHaveLength(session.messages.length);
  });

  it('should prefer summary metrics over session metrics', async () => {
    const session = makeSession({
      metrics: {
        ...makeSession().metrics,
        totalTokens: 100,
      },
    });
    const summary = makeSummary({
      metrics: {
        ...makeSummary().metrics,
        totalTokens: 999,
      },
    });

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.metrics).toBeDefined();
    });

    expect(result.current.metrics?.totalTokens).toBe(999);
  });

  it('should fall back to session metrics when summary is not available', async () => {
    const session = makeSession();

    fetchTranscriptSummaryMock.mockRejectedValue(new Error('Not found'));
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
    });

    expect(result.current.metrics).toEqual(session.metrics);
  });

  it('should expose chunks from session data', async () => {
    const session = makeSession({
      chunks: [
        {
          id: 'chunk-0',
          type: 'user',
          startTime: '2026-02-24T10:00:00.000Z',
          endTime: '2026-02-24T10:00:01.000Z',
          messages: [],
          metrics: {
            inputTokens: 50,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 50,
            messageCount: 1,
            durationMs: 1000,
            costUsd: 0.001,
          },
        },
      ],
    });
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.chunks).toHaveLength(1);
    });

    expect(result.current.chunks[0].id).toBe('chunk-0');
  });

  it('should keep messages/chunks references stable on summary-only updates', async () => {
    const session = makeSession({ chunks: undefined });
    const summary = makeSummary({
      metrics: {
        ...makeSummary().metrics,
        totalTokens: 360,
      },
    });

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
    });

    const initialMessagesRef = result.current.messages;
    const initialChunksRef = result.current.chunks;

    act(() => {
      queryClient.setQueryData(
        transcriptQueryKeys.summary('session-1'),
        makeSummary({
          metrics: {
            ...makeSummary().metrics,
            totalTokens: 999,
          },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.metrics?.totalTokens).toBe(999);
    });
    expect(result.current.messages).toBe(initialMessagesRef);
    expect(result.current.chunks).toBe(initialChunksRef);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('should expose error when transcript fetch fails', async () => {
    fetchJsonOrThrowMock.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.error).toBeTruthy();
    });

    expect(result.current.error?.message).toBe('Network error');
  });

  it('should not expose error when only summary fetch fails (non-fatal)', async () => {
    const session = makeSession();

    fetchTranscriptSummaryMock.mockRejectedValue(new Error('500 Internal Server Error'));
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
    });

    // Summary error should NOT cause panel error
    expect(result.current.error).toBeNull();
    // Metrics should degrade to session.metrics
    expect(result.current.metrics).toEqual(session.metrics);
    // isLoading should be false (transcript loaded)
    expect(result.current.isLoading).toBe(false);
  });

  // -------------------------------------------------------------------------
  // WebSocket subscription
  // -------------------------------------------------------------------------

  it('should register a WS message handler via useAppSocket', () => {
    fetchJsonOrThrowMock.mockResolvedValue(makeSession());

    renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    expect(useAppSocketMock).toHaveBeenCalled();
    const handlers = useAppSocketMock.mock.calls[0][0];
    expect(handlers).toHaveProperty('message');
    expect(typeof handlers.message).toBe('function');
  });

  it('should invalidate queries on WS "updated" event after debounce', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(
      () => useSessionTranscript('session-1', { wsInvalidationDebounceMs: 10 }),
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
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
        queryKey: transcriptQueryKeys.transcript('session-1'),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: transcriptQueryKeys.summary('session-1'),
      });
    });
  });

  it('should coalesce burst WS "updated" events into one invalidation cycle', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(
      () => useSessionTranscript('session-1', { wsInvalidationDebounceMs: 10 }),
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
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
      expect(invalidateSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('should invalidate queries on WS "discovered" event', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
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
      queryKey: transcriptQueryKeys.transcript('session-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: transcriptQueryKeys.summary('session-1'),
    });
  });

  it('should invalidate queries on WS "ended" event', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
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
      queryKey: transcriptQueryKeys.transcript('session-1'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: transcriptQueryKeys.summary('session-1'),
    });
  });

  it('should ignore WS events for different sessions', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
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
    const session = makeSession({ isOngoing: true });
    const summary = makeSummary({ isOngoing: true });

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isLive).toBe(true);
    });
  });

  it('should set isLive=false when session is not ongoing', async () => {
    const session = makeSession({ isOngoing: false });
    const summary = makeSummary({ isOngoing: false });

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
    });

    expect(result.current.isLive).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Query keys
  // -------------------------------------------------------------------------

  it('should export correct query keys', () => {
    expect(transcriptQueryKeys.transcript('abc')).toEqual(['transcript', 'abc']);
    expect(transcriptQueryKeys.summary('abc')).toEqual(['transcript-summary', 'abc']);
    expect(transcriptQueryKeys.transcript(null)).toEqual(['transcript', null]);
  });

  // -------------------------------------------------------------------------
  // Refetch
  // -------------------------------------------------------------------------

  it('should provide a refetch function', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    fetchJsonOrThrowMock.mockResolvedValue(session);

    const { result } = renderHook(() => useSessionTranscript('session-1'), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.session).toBeDefined();
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
