import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppSocket } from './useAppSocket';
import { fetchTranscriptSummary } from '@/ui/lib/sessions';
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
import type { SourceChangeKind } from '@/modules/session-reader/services/session-cache.service';

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

// Re-export TranscriptSummary from sessions.ts for backward compatibility
export type { TranscriptSummary } from '@/ui/lib/sessions';

// ---------------------------------------------------------------------------
// WS delta event payload shape
// ---------------------------------------------------------------------------

export interface WsTranscriptDeltaPayload {
  kind: 'delta';
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

export interface WsTranscriptFullRefetchRequiredPayload {
  kind: 'full-refetch-required';
  sessionId: string;
  sourceChangeKind: SourceChangeKind;
}

export type WsTranscriptUpdatedPayload =
  | WsTranscriptDeltaPayload
  | WsTranscriptFullRefetchRequiredPayload;

// ---------------------------------------------------------------------------
// Query Keys
// ---------------------------------------------------------------------------

export const transcriptQueryKeys = {
  summary: (sessionId: string | null) => ['transcript-summary', sessionId] as const,
  index: (sessionId: string | null) => ['transcript-index', sessionId] as const,
  chunkPage: (sessionId: string | null, cursor: string | null, limit: number) =>
    ['transcript-chunk-page', sessionId, cursor, limit] as const,
};

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
  /** Session metrics from the lightweight summary endpoint */
  metrics: UnifiedMetrics | undefined;
  /** Whether the session is live (ongoing and not ended) */
  isLive: boolean;
  /** Force a summary re-fetch */
  refetch: () => void;
}

export interface UseSessionTranscriptOptions {
  /**
   * Whether the owning DevChain session is still running.
   *
   * Transcript `isOngoing` is turn-level state: it becomes false after a normal
   * assistant `end_turn`, even while the tmux/provider session remains live.
   * When lifecycle state is available, it is therefore the polling authority;
   * transcript parsing remains the authority for model and metric values.
   */
  isSessionRunning?: boolean;
  /** Debounce window for WS transcript invalidation bursts. Overrides adaptive debounce when set. */
  wsInvalidationDebounceMs?: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Supplies live session metrics for chips and headers.
 *
 * Transcript bodies are served exclusively by the paged pipeline
 * (`PagedSessionMessageList` via `GET /transcript/index` + `/transcript/chunks`);
 * this hook never fetches the full transcript response.
 *
 * - Polls `GET /api/sessions/:id/transcript/summary` for lightweight metric updates
 * - Subscribes to WebSocket topic `session/{id}/runtime-context` (immediate summary refresh)
 * - WS `session/{id}/transcript` events trigger a debounced summary invalidation
 * - Uses DevChain lifecycle state to keep polling across completed assistant turns
 * - Falls back to transcript `isOngoing` only when lifecycle state is unavailable
 * - Cleans up WS subscription and pending debounce timer on unmount
 */
export function useSessionTranscript(
  sessionId: string | null,
  options?: UseSessionTranscriptOptions,
): UseSessionTranscriptResult {
  const { isSessionRunning, wsInvalidationDebounceMs: explicitDebounceMs } = options ?? {};
  const queryClient = useQueryClient();
  const apiFetch = useFetchFactory();
  const enabled = !!sessionId;
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Summary query — lighter endpoint for real-time chip/metric updates.
  const { data: summary } = useQuery({
    queryKey: transcriptQueryKeys.summary(sessionId),
    queryFn: () => fetchTranscriptSummary(sessionId!, apiFetch),
    enabled,
    staleTime: 3_000,
    refetchInterval: (query) => {
      if (isSessionRunning !== undefined) {
        return isSessionRunning ? 5_000 : false;
      }
      const data = query.state.data;
      if (data && !data.isOngoing) return false;
      return 5_000;
    },
  });

  // Adaptive debounce: scales with session size to prevent feedback loop on large sessions.
  const adaptiveDebounceMs =
    explicitDebounceMs ?? computeAdaptiveDebounceMs(summary?.metrics.messageCount);

  const invalidateSummary = useCallback(() => {
    if (!sessionId) return;
    queryClient.invalidateQueries({
      queryKey: transcriptQueryKeys.summary(sessionId),
    });
  }, [queryClient, sessionId]);

  const scheduleSummaryInvalidation = useCallback(() => {
    if (invalidateTimerRef.current) return;
    invalidateTimerRef.current = setTimeout(() => {
      invalidateTimerRef.current = null;
      invalidateSummary();
    }, adaptiveDebounceMs);
  }, [invalidateSummary, adaptiveDebounceMs]);

  useEffect(() => {
    return () => {
      if (invalidateTimerRef.current) {
        clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = null;
      }
    };
  }, []);

  // WebSocket subscription for real-time transcript events
  const handleMessage = useCallback(
    (envelope: WsEnvelope) => {
      if (!sessionId) return;
      if (
        envelope.topic === `session/${sessionId}/runtime-context` &&
        envelope.type === 'updated'
      ) {
        queryClient.invalidateQueries({
          queryKey: transcriptQueryKeys.summary(sessionId),
          exact: true,
        });
        return;
      }
      if (envelope.topic !== `session/${sessionId}/transcript`) return;

      switch (envelope.type) {
        case 'discovered':
        case 'ended':
          // Boundaries refresh the summary immediately; body refetching belongs to the paged pipeline.
          if (invalidateTimerRef.current) {
            clearTimeout(invalidateTimerRef.current);
            invalidateTimerRef.current = null;
          }
          invalidateSummary();
          break;

        case 'updated':
          scheduleSummaryInvalidation();
          break;
      }
    },
    [invalidateSummary, queryClient, scheduleSummaryInvalidation, sessionId],
  );

  const handlers = useMemo(() => ({ message: handleMessage }), [handleMessage]);

  useAppSocket(handlers, [sessionId]);

  // Derived values
  const metrics = summary?.metrics;
  const isLive = enabled && (isSessionRunning ?? summary?.isOngoing ?? false);

  const refetch = useCallback(() => {
    invalidateSummary();
  }, [invalidateSummary]);

  return {
    metrics,
    isLive,
    refetch,
  };
}
