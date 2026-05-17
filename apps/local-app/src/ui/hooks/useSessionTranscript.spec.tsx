import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import {
  useSessionTranscript,
  transcriptQueryKeys,
  computeAdaptiveDebounceMs,
  type SerializedSession,
  type TranscriptSummary,
} from './useSessionTranscript';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { fetchTranscriptSummary, fetchTranscriptTail } from '@/ui/lib/sessions';
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
  fetchTranscriptTail: jest.fn(),
}));

const useAppSocketMock = useAppSocket as jest.MockedFunction<typeof useAppSocket>;
const fetchTranscriptSummaryMock = fetchTranscriptSummary as jest.MockedFunction<
  typeof fetchTranscriptSummary
>;
const fetchTranscriptTailMock = fetchTranscriptTail as jest.MockedFunction<
  typeof fetchTranscriptTail
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

function mockTranscriptResponse(session: SerializedSession): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(session)),
    json: () => Promise.resolve(session),
  } as Response);
}

function mockTranscriptError(status: number, message: string): void {
  fetchMock.mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ message }),
  } as Response);
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

    expect(fetchMock).not.toHaveBeenCalled();
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
    mockTranscriptResponse(session);

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

    expect(fetchTranscriptSummaryMock).toHaveBeenCalledWith('session-1', '', expect.any(Function));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.session).toBeUndefined();
    expect(result.current.messages).toEqual([]);
    expect(result.current.chunks).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it('should fetch transcript when transcript mode is enabled after being disabled', async () => {
    const session = makeSession();
    const summary = makeSummary();

    fetchTranscriptSummaryMock.mockResolvedValue(summary);
    mockTranscriptResponse(session);

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

    const urlsBeforeActivation = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urlsBeforeActivation.some((url) => url.endsWith('/transcript'))).toBe(false);

    rerender({ enableTranscript: true });

    await waitFor(() => {
      expect(result.current.session).toEqual(session);
    });

    const urlsAfterActivation = fetchMock.mock.calls.map(([url]) => String(url));
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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(session);

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
    mockTranscriptError(500, 'Network error');

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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(makeSession());

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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(session);

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
    mockTranscriptResponse(session);

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

  // -------------------------------------------------------------------------
  // WS push-delta: cursor-match → inline merge (zero HTTP refetch)
  // -------------------------------------------------------------------------

  describe('WS push-delta cursor paths', () => {
    const INITIAL_CURSOR = 'aW5pdGlhbC1jdXJzb3I';
    const NEXT_CURSOR = 'bmV4dC1jdXJzb3I';

    function makeSessionWithCursor(): SerializedSession {
      return makeSession({
        cursor: INITIAL_CURSOR,
        chunks: [
          {
            id: 'chunk-0',
            type: 'user',
            startTime: '2026-02-24T10:00:00.000Z',
            endTime: '2026-02-24T10:00:00.000Z',
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
            ],
            metrics: {
              inputTokens: 50,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: 50,
              messageCount: 1,
              durationMs: 0,
              costUsd: 0,
            },
          },
          {
            id: 'chunk-1',
            type: 'ai',
            startTime: '2026-02-24T10:00:05.000Z',
            endTime: '2026-02-24T10:00:05.000Z',
            messages: [
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
            semanticSteps: [],
            metrics: {
              inputTokens: 50,
              outputTokens: 200,
              cacheReadTokens: 50,
              cacheCreationTokens: 10,
              totalTokens: 310,
              messageCount: 1,
              durationMs: 5000,
              costUsd: 0.004,
            },
          },
        ],
      });
    }

    function makeDeltaPayload(prevCursor: string) {
      return {
        sessionId: 'session-1',
        cursor: NEXT_CURSOR,
        prevCursor,
        replaceFromChunkIndex: 1,
        deltaChunks: [
          {
            id: 'chunk-1',
            type: 'ai',
            startTime: '2026-02-24T10:00:05.000Z',
            endTime: '2026-02-24T10:00:10.000Z',
            messages: [
              {
                id: 'msg-2',
                parentId: 'msg-1',
                role: 'assistant',
                timestamp: '2026-02-24T10:00:05.000Z',
                content: [{ type: 'text', text: 'Hi there!' }],
                toolCalls: [],
                toolResults: [],
                isMeta: false,
                isSidechain: false,
              },
              {
                id: 'msg-3',
                parentId: 'msg-2',
                role: 'assistant',
                timestamp: '2026-02-24T10:00:10.000Z',
                content: [{ type: 'text', text: 'How can I help?' }],
                toolCalls: [],
                toolResults: [],
                isMeta: false,
                isSidechain: false,
              },
            ],
            semanticSteps: [],
            metrics: {
              inputTokens: 50,
              outputTokens: 300,
              cacheReadTokens: 50,
              cacheCreationTokens: 10,
              totalTokens: 410,
              messageCount: 2,
              durationMs: 5000,
              costUsd: 0.005,
            },
          },
        ],
        deltaMessages: [
          {
            id: 'msg-3',
            parentId: 'msg-2',
            role: 'assistant',
            timestamp: '2026-02-24T10:00:10.000Z',
            content: [{ type: 'text', text: 'How can I help?' }],
            toolCalls: [],
            toolResults: [],
            isMeta: false,
            isSidechain: false,
          },
        ],
        newMessageCount: 1,
        metrics: {
          totalTokens: 500,
          inputTokens: 150,
          outputTokens: 300,
          costUsd: 0.01,
          messageCount: 3,
        },
      };
    }

    async function renderWithInitialSession() {
      const session = makeSessionWithCursor();
      const summary = makeSummary();
      fetchTranscriptSummaryMock.mockResolvedValue(summary);
      mockTranscriptResponse(session);

      const hook = renderHook(() => useSessionTranscript('session-1'), {
        wrapper: createWrapper(queryClient),
      });

      await waitFor(() => {
        expect(hook.result.current.session).toBeDefined();
        expect(hook.result.current.session?.cursor).toBe(INITIAL_CURSOR);
      });

      fetchMock.mockClear();
      return hook;
    }

    it('cursor match → applies delta merge via setQueryData (zero full-refetch)', async () => {
      const { result } = await renderWithInitialSession();

      const setQueryDataSpy = jest.spyOn(queryClient, 'setQueryData');
      const handler = captureWsHandler();

      act(() => {
        handler({
          topic: 'session/session-1/transcript',
          type: 'updated',
          payload: makeDeltaPayload(INITIAL_CURSOR),
          ts: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(setQueryDataSpy).toHaveBeenCalled();
      });

      expect(result.current.messages).toHaveLength(3);
      expect(result.current.chunks).toHaveLength(2);
      expect(result.current.chunks[0].id).toBe('chunk-0');
      expect(result.current.chunks[1].id).toBe('chunk-1');
      expect(result.current.session?.cursor).toBe(NEXT_CURSOR);

      const transcriptFetches = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/transcript'),
      );
      expect(transcriptFetches).toHaveLength(0);
    });

    it('cursor match preserves identity for unchanged chunks', async () => {
      const { result } = await renderWithInitialSession();

      const chunk0Before = result.current.chunks[0];
      const handler = captureWsHandler();

      act(() => {
        handler({
          topic: 'session/session-1/transcript',
          type: 'updated',
          payload: makeDeltaPayload(INITIAL_CURSOR),
          ts: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(result.current.messages).toHaveLength(3);
      });

      expect(result.current.chunks[0]).toBe(chunk0Before);
    });

    it('consecutive cursor-match events produce zero full-transcript refetches', async () => {
      await renderWithInitialSession();

      const handler = captureWsHandler();
      let currentCursor = INITIAL_CURSOR;

      for (let i = 0; i < 10; i++) {
        const nextCursor = `cursor-${i + 1}`;
        const delta = makeDeltaPayload(currentCursor);
        delta.cursor = nextCursor;
        delta.prevCursor = currentCursor;

        act(() => {
          handler({
            topic: 'session/session-1/transcript',
            type: 'updated',
            payload: delta,
            ts: new Date().toISOString(),
          });
        });

        currentCursor = nextCursor;
      }

      const transcriptFetches = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/transcript'),
      );
      expect(transcriptFetches).toHaveLength(0);
    });

    it('cursor mismatch → fetches tail endpoint', async () => {
      await renderWithInitialSession();

      fetchTranscriptTailMock.mockResolvedValue({
        cursor: NEXT_CURSOR,
        replaceFromChunkIndex: 1,
        deltaChunks: [],
        deltaMessages: [],
        metrics: makeSession().metrics,
        totalChunkCount: 2,
        totalMessageCount: 3,
      });

      const handler = captureWsHandler();

      act(() => {
        handler({
          topic: 'session/session-1/transcript',
          type: 'updated',
          payload: makeDeltaPayload('wrong-cursor'),
          ts: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(fetchTranscriptTailMock).toHaveBeenCalledWith(
          'session-1',
          INITIAL_CURSOR,
          expect.any(Function),
        );
      });

      const transcriptFetches = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/transcript'),
      );
      expect(transcriptFetches).toHaveLength(0);
    });

    it('tail failure → falls back to full-transcript invalidation', async () => {
      await renderWithInitialSession();

      fetchTranscriptTailMock.mockRejectedValue(new Error('Cursor expired'));

      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
      const handler = captureWsHandler();

      act(() => {
        handler({
          topic: 'session/session-1/transcript',
          type: 'updated',
          payload: makeDeltaPayload('wrong-cursor'),
          ts: new Date().toISOString(),
        });
      });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({
          queryKey: transcriptQueryKeys.transcript('session-1'),
        });
      });
    });
  });
});
