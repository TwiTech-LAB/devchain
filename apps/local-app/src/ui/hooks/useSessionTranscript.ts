import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppSocket } from './useAppSocket';
import { SessionApiError, fetchTranscriptSummary, fetchTranscriptTail } from '@/ui/lib/sessions';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type {
  UnifiedMetrics,
  UnifiedMessage,
} from '@/modules/session-reader/dtos/unified-session.types';
import type {
  UnifiedChunk,
  UnifiedSemanticStep,
} from '@/modules/session-reader/dtos/unified-chunk.types';

// ---------------------------------------------------------------------------
// Serialized REST types (Date fields → ISO string over HTTP)
// ---------------------------------------------------------------------------

/** Message shape from REST API (timestamp serialized as ISO string) */
export type SerializedMessage = Omit<UnifiedMessage, 'timestamp'> & {
  timestamp: string;
};

/** Semantic step with serialized dates */
export type SerializedSemanticStep = Omit<UnifiedSemanticStep, 'startTime'> & {
  startTime: string;
};

/** Chunk with serialized dates */
export type SerializedChunk = Omit<
  UnifiedChunk,
  'startTime' | 'endTime' | 'messages' | 'semanticSteps' | 'turns'
> & {
  startTime: string;
  endTime: string;
  messages: SerializedMessage[];
  semanticSteps?: SerializedSemanticStep[];
};

/** Full session response from GET /api/sessions/:id/transcript */
export interface SerializedSession {
  id: string;
  providerName: string;
  filePath: string;
  messages: SerializedMessage[];
  metrics: UnifiedMetrics;
  isOngoing: boolean;
  chunks?: SerializedChunk[];
  warnings?: string[];
  /** Opaque cursor for WS push-delta protocol */
  cursor?: string;
}

// Re-export TranscriptSummary from sessions.ts for backward compatibility
export type { TranscriptSummary } from '@/ui/lib/sessions';

// ---------------------------------------------------------------------------
// WS delta event payload shape
// ---------------------------------------------------------------------------

export interface WsTranscriptDeltaPayload {
  sessionId: string;
  cursor: string;
  prevCursor: string;
  replaceFromChunkIndex: number;
  newChunkIds: string[];
  totalChunkCount: number;
  deltaChunks: SerializedChunk[];
  deltaMessages: SerializedMessage[];
  metrics: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    messageCount: number;
  };
  newMessageCount: number;
}

// ---------------------------------------------------------------------------
// Query Keys
// ---------------------------------------------------------------------------

export const transcriptQueryKeys = {
  transcript: (sessionId: string | null) => ['transcript', sessionId] as const,
  summary: (sessionId: string | null) => ['transcript-summary', sessionId] as const,
  index: (sessionId: string | null) => ['transcript-index', sessionId] as const,
  chunkPage: (sessionId: string | null, cursor: string | null, limit: number) =>
    ['transcript-chunk-page', sessionId, cursor, limit] as const,
};

const EMPTY_MESSAGES: SerializedMessage[] = [];
const EMPTY_CHUNKS: SerializedChunk[] = [];

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

let transcriptFetchCount = 0;

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchTranscript(sessionId: string, fetchFn: FetchFn): Promise<SerializedSession> {
  transcriptFetchCount++;
  const t0 = performance.now();
  const response = await fetchFn(`/api/sessions/${sessionId}/transcript`);

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String(payload.message)
        : 'Failed to fetch transcript';
    throw new SessionApiError(message, response.status, payload ?? undefined);
  }

  const text = await response.text();
  const t1 = performance.now();
  const data = JSON.parse(text) as SerializedSession;
  const t2 = performance.now();

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      msg: 'transcript.client.timing',
      sessionId,
      bytes: text.length,
      fetchAndReadMs: Math.round((t1 - t0) * 100) / 100,
      jsonParseMs: Math.round((t2 - t1) * 100) / 100,
      totalMs: Math.round((t2 - t0) * 100) / 100,
    }),
  );

  return data;
}

// ---------------------------------------------------------------------------
// Adaptive debounce helper
// ---------------------------------------------------------------------------

/** Scales WS invalidation debounce by session message count to prevent feedback loops on large sessions. */
export function computeAdaptiveDebounceMs(messageCount: number | undefined): number {
  const baseMs = 250;
  const stepMs = 500;
  const stepSize = 200;
  const maxMs = 5000;
  const count = messageCount ?? 0;
  return Math.min(baseMs + Math.floor(count / stepSize) * stepMs, maxMs);
}

// ---------------------------------------------------------------------------
// Hook Return Type
// ---------------------------------------------------------------------------

export interface UseSessionTranscriptResult {
  /** Full session data */
  session: SerializedSession | undefined;
  /** Session messages (empty array when not loaded) */
  messages: SerializedMessage[];
  /** Session chunks from full transcript (empty array when not available) */
  chunks: SerializedChunk[];
  /** Session metrics (prefers summary endpoint for fresher data) */
  metrics: UnifiedMetrics | undefined;
  /** Whether the initial transcript is loading */
  isLoading: boolean;
  /** Fetch error (transcript only — summary failures are non-fatal) */
  error: Error | null;
  /** Whether the session is live (ongoing and not ended) */
  isLive: boolean;
  /** Force re-fetch all session data */
  refetch: () => void;
}

export interface UseSessionTranscriptOptions {
  /** Whether full transcript fetching/polling is enabled (summary can still remain active). */
  enableTranscript?: boolean;
  /** Poll interval for full transcript fallback refresh when enabled. */
  transcriptRefetchIntervalMs?: number;
  /** Debounce window for WS transcript invalidation bursts. Overrides adaptive debounce when set. */
  wsInvalidationDebounceMs?: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Primary hook for connecting UI components to session transcript data.
 *
 * - Fetches initial session via `GET /api/sessions/:id/transcript` (full data)
 * - Polls `GET /api/sessions/:id/transcript/summary` for lightweight metric updates
 * - Subscribes to WebSocket topic `session/{id}/transcript` for real-time events
 * - WS `updated` events use push-delta protocol: cursor match → inline merge (no HTTP);
 *   cursor mismatch → tail fetch; tail failure → full-transcript fallback
 * - `discovered` and `ended` events trigger immediate full invalidation
 * - Stops polling once session ends (via WS `ended` event or API `isOngoing: false`)
 * - Cleans up WS subscription on unmount
 */
export function useSessionTranscript(
  sessionId: string | null,
  options?: UseSessionTranscriptOptions,
): UseSessionTranscriptResult {
  const {
    enableTranscript = true,
    transcriptRefetchIntervalMs = 30_000,
    wsInvalidationDebounceMs: explicitDebounceMs,
  } = options ?? {};
  const queryClient = useQueryClient();
  const apiFetch = useFetchFactory();
  const enabled = !!sessionId;
  const transcriptEnabled = enabled && enableTranscript;
  const summaryEnabled = enabled;
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clientCursorRef = useRef<string | null>(null);

  // Summary query — lighter endpoint for real-time chip/metric updates (non-fatal).
  // Placed before transcript query so adaptive staleTime can read messageCount.
  const { data: summary } = useQuery({
    queryKey: transcriptQueryKeys.summary(sessionId),
    queryFn: () => fetchTranscriptSummary(sessionId!, '', apiFetch),
    enabled: summaryEnabled,
    staleTime: 3_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && !data.isOngoing) return false;
      return 5_000;
    },
  });

  // Adaptive debounce: scales with session size to prevent feedback loop on large sessions.
  const adaptiveDebounceMs =
    explicitDebounceMs ?? computeAdaptiveDebounceMs(summary?.metrics.messageCount);
  const adaptiveStaleTime = Math.max(5_000, adaptiveDebounceMs);

  const invalidateTranscriptAndSummary = useCallback(() => {
    if (!sessionId) return;
    clientCursorRef.current = null;
    queryClient.invalidateQueries({
      queryKey: transcriptQueryKeys.transcript(sessionId),
    });
    queryClient.invalidateQueries({
      queryKey: transcriptQueryKeys.summary(sessionId),
    });
  }, [queryClient, sessionId]);

  const scheduleTranscriptAndSummaryInvalidation = useCallback(() => {
    if (invalidateTimerRef.current) return;
    invalidateTimerRef.current = setTimeout(() => {
      invalidateTimerRef.current = null;
      invalidateTranscriptAndSummary();
    }, adaptiveDebounceMs);
  }, [invalidateTranscriptAndSummary, adaptiveDebounceMs]);

  useEffect(() => {
    return () => {
      if (invalidateTimerRef.current) {
        clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = null;
      }
    };
  }, []);

  // Delta merge: apply inline delta from WS event without HTTP roundtrip.
  const applyDeltaMerge = useCallback(
    (delta: WsTranscriptDeltaPayload) => {
      if (!sessionId) return;

      queryClient.setQueryData<SerializedSession>(
        transcriptQueryKeys.transcript(sessionId),
        (old) => {
          if (!old) return old;

          const existingChunks = old.chunks ?? [];
          const stableChunks = existingChunks.slice(0, delta.replaceFromChunkIndex);
          const mergedChunks = [...stableChunks, ...delta.deltaChunks];
          const mergedMessages = [...old.messages, ...delta.deltaMessages];

          return {
            ...old,
            messages: mergedMessages,
            chunks: mergedChunks,
            metrics: {
              ...old.metrics,
              totalTokens: delta.metrics.totalTokens,
              inputTokens: delta.metrics.inputTokens,
              outputTokens: delta.metrics.outputTokens,
              costUsd: delta.metrics.costUsd,
              messageCount: delta.metrics.messageCount,
            },
            isOngoing: true,
            cursor: delta.cursor,
          };
        },
      );

      clientCursorRef.current = delta.cursor;

      queryClient.invalidateQueries({
        queryKey: transcriptQueryKeys.summary(sessionId),
      });
    },
    [queryClient, sessionId],
  );

  // Tail fetch: recover from cursor mismatch by fetching delta from server.
  const fetchTailAndMerge = useCallback(
    async (sid: string, cursor: string) => {
      try {
        const tail = await fetchTranscriptTail(sid, cursor, apiFetch);

        queryClient.setQueryData<SerializedSession>(transcriptQueryKeys.transcript(sid), (old) => {
          if (!old) return old;

          const existingChunks = old.chunks ?? [];
          const stableChunks = existingChunks.slice(0, tail.replaceFromChunkIndex);
          const mergedChunks = [...stableChunks, ...(tail.deltaChunks as SerializedChunk[])];
          const mergedMessages = [...old.messages, ...(tail.deltaMessages as SerializedMessage[])];

          return {
            ...old,
            messages: mergedMessages,
            chunks: mergedChunks,
            metrics: tail.metrics,
            isOngoing: true,
            cursor: tail.cursor,
          };
        });

        clientCursorRef.current = tail.cursor;

        queryClient.invalidateQueries({
          queryKey: transcriptQueryKeys.summary(sid),
        });
      } catch {
        invalidateTranscriptAndSummary();
      }
    },
    [queryClient, invalidateTranscriptAndSummary],
  );

  // Full transcript query
  const {
    data: session,
    isLoading: transcriptLoading,
    error: transcriptError,
    refetch: refetchTranscript,
  } = useQuery({
    queryKey: transcriptQueryKeys.transcript(sessionId),
    queryFn: () => fetchTranscript(sessionId!, apiFetch),
    enabled: transcriptEnabled,
    staleTime: adaptiveStaleTime,
    refetchInterval: (query) => {
      if (!transcriptEnabled) return false;
      const data = query.state.data;
      if (data && !data.isOngoing) return false;
      return transcriptRefetchIntervalMs;
    },
  });

  // Update client cursor when session data changes from full fetch.
  useEffect(() => {
    if (session?.cursor) {
      clientCursorRef.current = session.cursor;
    }
  }, [session]);

  // WebSocket subscription for real-time transcript events
  const handleMessage = useCallback(
    (envelope: WsEnvelope) => {
      if (!sessionId) return;
      if (envelope.topic !== `session/${sessionId}/transcript`) return;

      switch (envelope.type) {
        case 'discovered':
          // New transcript discovered — refresh immediately.
          if (invalidateTimerRef.current) {
            clearTimeout(invalidateTimerRef.current);
            invalidateTimerRef.current = null;
          }
          invalidateTranscriptAndSummary();
          break;

        case 'updated': {
          const payload = envelope.payload as WsTranscriptDeltaPayload | undefined;
          const clientCursor = clientCursorRef.current;

          if (payload?.cursor && payload?.prevCursor && clientCursor) {
            if (payload.prevCursor === clientCursor) {
              // Cursor match → inline delta merge (no HTTP roundtrip)
              applyDeltaMerge(payload);
            } else {
              // Cursor mismatch → tail fetch recovery
              fetchTailAndMerge(sessionId, clientCursor).catch(() => {
                invalidateTranscriptAndSummary();
              });
            }
          } else {
            // No cursor support (first load or old server) → fallback to debounced invalidation
            scheduleTranscriptAndSummaryInvalidation();
          }
          break;
        }

        case 'ended':
          // Session ended — final immediate refresh (polling will stop).
          if (invalidateTimerRef.current) {
            clearTimeout(invalidateTimerRef.current);
            invalidateTimerRef.current = null;
          }
          invalidateTranscriptAndSummary();
          break;
      }
    },
    [
      applyDeltaMerge,
      fetchTailAndMerge,
      invalidateTranscriptAndSummary,
      scheduleTranscriptAndSummaryInvalidation,
      sessionId,
    ],
  );

  const handlers = useMemo(() => ({ message: handleMessage }), [handleMessage]);

  useAppSocket(handlers, [sessionId]);

  // Derived values
  const messages = session?.messages ?? EMPTY_MESSAGES;
  const chunks = session?.chunks ?? EMPTY_CHUNKS;
  const metrics = summary?.metrics ?? session?.metrics;
  const isLive = enabled && (summary?.isOngoing ?? session?.isOngoing ?? false);

  useEffect(() => {
    if (!isLive || !sessionId) return;
    transcriptFetchCount = 0;
    const intervalId = setInterval(() => {
      if (transcriptFetchCount > 0) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            msg: 'transcript.client.refetchRate',
            sessionId,
            refetchesLastMinute: transcriptFetchCount,
          }),
        );
        transcriptFetchCount = 0;
      }
    }, 60_000);
    return () => clearInterval(intervalId);
  }, [isLive, sessionId]);

  const refetch = useCallback(() => {
    if (!sessionId) return;
    if (transcriptEnabled) {
      refetchTranscript();
    }
    if (summaryEnabled) {
      queryClient.invalidateQueries({
        queryKey: transcriptQueryKeys.summary(sessionId),
      });
    }
  }, [refetchTranscript, queryClient, sessionId, summaryEnabled, transcriptEnabled]);

  return {
    session,
    messages,
    chunks,
    metrics,
    isLoading: transcriptLoading,
    error: transcriptError as Error | null,
    isLive,
    refetch,
  };
}
