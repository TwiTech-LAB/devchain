import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { fetchTranscriptSummary } from '@/ui/lib/sessions';
import { transcriptQueryKeys } from '@/ui/hooks/useSessionTranscript';

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

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentSessionMetrics(
  entries: AgentSessionEntry[],
): Map<string, AgentContextMetrics> {
  const queries = useQueries({
    queries: entries.map((entry) => ({
      queryKey: buildQueryKey(entry.sessionId, entry.apiBase),
      queryFn: () => fetchTranscriptSummary(entry.sessionId, entry.apiBase),
      staleTime: 10_000,
      retry: false,
      refetchInterval: (query: { state: { data?: { isOngoing: boolean } } }) => {
        const data = query.state.data;
        if (data && !data.isOngoing) return false as const;
        return 15_000;
      },
    })),
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
