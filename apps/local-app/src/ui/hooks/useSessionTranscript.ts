import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppSocket } from './useAppSocket';
import { fetchJsonOrThrow, fetchTranscriptSummary } from '@/ui/lib/sessions';
import type { WsEnvelope } from '@/ui/lib/socket';
import type {
  UnifiedMetrics,
  UnifiedMessage,
} from '@/modules/session-reader/dtos/unified-session.types';
import type {
  UnifiedChunk,
  UnifiedSemanticStep,
  UnifiedTurn,
} from '@/modules/session-reader/dtos/unified-chunk.types';

// ---------------------------------------------------------------------------
// Serialized REST types (Date fields → ISO strings over HTTP)
// ---------------------------------------------------------------------------

/** Message shape from REST API (timestamp serialized as ISO string) */
export type SerializedMessage = Omit<UnifiedMessage, 'timestamp'> & {
  timestamp: string;
};

/** Semantic step with serialized dates */
export type SerializedSemanticStep = Omit<UnifiedSemanticStep, 'startTime'> & {
  startTime: string;
};

/** Turn with serialized dates */
export type SerializedTurn = Omit<UnifiedTurn, 'timestamp' | 'steps'> & {
  timestamp: string;
  steps: SerializedSemanticStep[];
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
  turns?: SerializedTurn[];
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
}

// Re-export TranscriptSummary from sessions.ts for backward compatibility
export type { TranscriptSummary } from '@/ui/lib/sessions';

// ---------------------------------------------------------------------------
// Query Keys
// ---------------------------------------------------------------------------

export const transcriptQueryKeys = {
  transcript: (sessionId: string | null) => ['transcript', sessionId] as const,
  summary: (sessionId: string | null) => ['transcript-summary', sessionId] as const,
};

const EMPTY_MESSAGES: SerializedMessage[] = [];
const EMPTY_CHUNKS: SerializedChunk[] = [];

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchTranscript(sessionId: string): Promise<SerializedSession> {
  return fetchJsonOrThrow<SerializedSession>(
    `/api/sessions/${sessionId}/transcript`,
    {},
    'Failed to fetch transcript',
  );
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
  /** Debounce window for WS transcript invalidation bursts. */
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
    wsInvalidationDebounceMs = 250,
  } = options ?? {};
  const queryClient = useQueryClient();
  const enabled = !!sessionId;
  const transcriptEnabled = enabled && enableTranscript;
  const summaryEnabled = enabled;
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidateTranscriptAndSummary = useCallback(() => {
    if (!sessionId) return;
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
    }, wsInvalidationDebounceMs);
  }, [invalidateTranscriptAndSummary, wsInvalidationDebounceMs]);

  useEffect(() => {
    return () => {
      if (invalidateTimerRef.current) {
        clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = null;
      }
    };
  }, []);

  // Full transcript query
  const {
    data: session,
    isLoading: transcriptLoading,
    error: transcriptError,
    refetch: refetchTranscript,
  } = useQuery({
    queryKey: transcriptQueryKeys.transcript(sessionId),
    queryFn: () => fetchTranscript(sessionId!),
    enabled: transcriptEnabled,
    staleTime: 5_000,
    refetchInterval: (query) => {
      if (!transcriptEnabled) return false;
      const data = query.state.data;
      // Stop polling once session is no longer ongoing
      if (data && !data.isOngoing) return false;
      return transcriptRefetchIntervalMs;
    },
  });

  // Summary query — lighter endpoint for real-time chip/metric updates (non-fatal)
  const { data: summary } = useQuery({
    queryKey: transcriptQueryKeys.summary(sessionId),
    queryFn: () => fetchTranscriptSummary(sessionId!),
    enabled: summaryEnabled,
    staleTime: 3_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && !data.isOngoing) return false;
      return 5_000;
    },
  });

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

        case 'updated':
          // Transcript grew — coalesce burst updates.
          scheduleTranscriptAndSummaryInvalidation();
          break;

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
    [invalidateTranscriptAndSummary, scheduleTranscriptAndSummaryInvalidation, sessionId],
  );

  const handlers = useMemo(() => ({ message: handleMessage }), [handleMessage]);

  useAppSocket(handlers, [sessionId]);

  // Derived values
  const messages = session?.messages ?? EMPTY_MESSAGES;
  const chunks = session?.chunks ?? EMPTY_CHUNKS;
  const metrics = summary?.metrics ?? session?.metrics;
  const isLive = enabled && (summary?.isOngoing ?? session?.isOngoing ?? false);

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
