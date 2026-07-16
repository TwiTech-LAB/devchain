import { useMemo } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { fetchTranscriptSummary } from '@/ui/lib/sessions';
import { transcriptQueryKeys } from '@/ui/hooks/useSessionTranscript';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useRealtimeDispatch } from '@/ui/hooks/useRealtimeDispatch';
import type { RealtimeInvalidationRegistry } from '@/ui/lib/realtime-invalidation-registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSessionEntry {
  agentId: string;
  sessionId: string;
  /** undefined = local, string = worktree base URL */
  apiBase?: string;
}

export interface AgentContextMetrics {
  contextPercent: number;
  totalContextTokens: number;
  contextWindowTokens: number;
}

export const METRICS_WATCHDOG_MIN_MS = 60_000;
const METRICS_WATCHDOG_STAGGER_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a lookup key for agent metrics.
 * Local agents use agentId; worktree agents use `${apiBase}:${agentId}`.
 */
export function getMetricsKey(agentId: string, apiBase?: string): string {
  return apiBase ? `${apiBase}:${agentId}` : agentId;
}

function buildQueryKey(sessionId: string, apiBase?: string) {
  if (apiBase) {
    return ['transcript-summary', apiBase, sessionId] as const;
  }
  return transcriptQueryKeys.summary(sessionId);
}

export function getMetricsWatchdogInterval(entry: AgentSessionEntry): number {
  const key = getMetricsKey(entry.agentId, entry.apiBase);
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return METRICS_WATCHDOG_MIN_MS + (hash % METRICS_WATCHDOG_STAGGER_MS);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentSessionMetrics(
  entries: AgentSessionEntry[],
): Map<string, AgentContextMetrics> {
  const apiFetch = useFetchFactory();
  const queryClient = useQueryClient();
  const localSessionIds = useMemo(
    () => new Set(entries.filter((entry) => !entry.apiBase).map((entry) => entry.sessionId)),
    [entries],
  );
  const realtimeRegistry = useMemo<RealtimeInvalidationRegistry>(() => {
    const invalidateVisibleSummary = (payload: Record<string, unknown>) => {
      const sessionId = payload.sessionId;
      if (typeof sessionId !== 'string' || !localSessionIds.has(sessionId)) return;
      queryClient.invalidateQueries({
        queryKey: transcriptQueryKeys.summary(sessionId),
        exact: true,
      });
    };
    const entriesForEvent: RealtimeInvalidationRegistry[number]['entries'] = [
      { kind: 'custom-handler', handler: invalidateVisibleSummary },
    ];
    return ['discovered', 'updated', 'ended'].map((type) => ({
      match: (topic: string) => topic.startsWith('session/') && topic.endsWith('/transcript'),
      type,
      entries: entriesForEvent,
    }));
  }, [localSessionIds, queryClient]);
  useRealtimeDispatch(realtimeRegistry);

  const queries = useQueries({
    queries: entries.map((entry) => {
      const watchdogInterval = getMetricsWatchdogInterval(entry);
      return {
        queryKey: buildQueryKey(entry.sessionId, entry.apiBase),
        queryFn: () => fetchTranscriptSummary(entry.sessionId, entry.apiBase, apiFetch),
        staleTime: 10_000,
        retry: false,
        refetchInterval: (query: { state: { data?: { isOngoing: boolean } } }) => {
          const data = query.state.data;
          if (data && !data.isOngoing) return false as const;
          return watchdogInterval;
        },
      };
    }),
  });

  return useMemo(() => {
    const map = new Map<string, AgentContextMetrics>();

    entries.forEach((entry, index) => {
      const result = queries[index];
      if (!result?.data?.metrics) return;

      const { totalContextTokens, contextWindowTokens } = result.data.metrics;
      if (!contextWindowTokens) return;

      const contextPercent = Math.max(
        0,
        Math.min((totalContextTokens / contextWindowTokens) * 100, 100),
      );

      if (contextPercent > 0) {
        map.set(getMetricsKey(entry.agentId, entry.apiBase), {
          contextPercent,
          totalContextTokens,
          contextWindowTokens,
        });
      }
    });

    return map;
  }, [entries, queries]);
}
