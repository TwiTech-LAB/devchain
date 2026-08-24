import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';
import { epicTimeQueryKeys, resolveEpicTimeZone } from '@/ui/lib/epic-time';

export type EpicTimeTotalsMap = ReadonlyMap<string, number>;

interface BatchTimeSummaryPayload {
  items?: Array<{ epicId?: unknown; totalMinutes?: unknown }>;
}

/**
 * One guarded batch read of root-Epic estimated-time totals for Board
 * badges. Only root Epic IDs may reach the request — the API rejects
 * sub-Epics — so the caller owns a root-only ID set. Worktree and
 * unresolved runtimes issue no request, key under an isolated cache scope,
 * and never see main-scope cached data through any returned field. A
 * failed read leaves the map empty: time badges are decoration, never a
 * Board blocker.
 */
export function useEpicTimeSummariesBatch(
  epicIds: readonly string[],
  { enabled = true }: { enabled?: boolean } = {},
): { totals: EpicTimeTotalsMap | undefined; query: ReturnType<typeof useQuery> } {
  const apiFetch = useFetchFactory();
  const { runtimeResolved, apiBase } = useOptionalWorktreeTab();
  const admitted = enabled && runtimeResolved && apiBase === '';
  const scope = admitted ? 'main' : 'isolated';
  const timeZone = useMemo(() => resolveEpicTimeZone(), []);
  // Sort before keying: any arrival order of the same Board context must
  // resolve to one cache entry.
  const sortedIds = useMemo(() => [...new Set(epicIds)].sort(), [epicIds]);

  const query = useQuery({
    queryKey: epicTimeQueryKeys.batch(sortedIds, timeZone, scope),
    queryFn: async ({ signal }): Promise<EpicTimeTotalsMap> => {
      const response = await apiFetch('/api/epics/time-summary/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epicIds: sortedIds, timeZone }),
        signal,
      });
      if (!response.ok) throw new Error('Epic time summaries could not be loaded.');
      const payload = (await response.json()) as BatchTimeSummaryPayload;
      const totals = new Map<string, number>();
      for (const item of payload.items ?? []) {
        if (typeof item?.epicId === 'string' && typeof item.totalMinutes === 'number') {
          totals.set(item.epicId, item.totalMinutes);
        }
      }
      return totals;
    },
    enabled: admitted && sortedIds.length > 0,
    refetchInterval: 60_000,
  });

  const totals = useMemo<EpicTimeTotalsMap>(
    () => query.data ?? new Map<string, number>(),
    [query.data],
  );

  // Disabled contexts (worktree, unresolved runtime) never see a main-tab
  // cache entry's data.
  return { totals: admitted ? totals : undefined, query };
}
