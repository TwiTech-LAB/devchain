import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { epicExternalSourceQueryKeys } from '@/ui/lib/external-my-work';

export interface EpicExternalSourceBatchItem extends ExternalTaskSourceSummary {
  epicId: string;
}

export type EpicExternalSourceMap = ReadonlyMap<string, ExternalTaskSourceSummary>;

/**
 * One guarded batch read of stored Epic source snapshots. The caller owns the
 * Epic-ID set (sorted and deduplicated here for a stable query key); items are
 * ordered so the first source per Epic is the earliest-created link. A failed
 * read leaves the map empty — it must never hide or block native Board
 * content.
 */
export function useEpicExternalSourcesBatch(
  epicIds: readonly string[],
  { enabled = true }: { enabled?: boolean } = {},
): { sources: EpicExternalSourceMap | undefined; query: ReturnType<typeof useQuery> } {
  const apiFetch = useFetchFactory();
  // Sort before keying: any arrival order of the same Board context must
  // resolve to one cache entry.
  const sortedIds = useMemo(() => [...new Set(epicIds)].sort(), [epicIds]);

  const query = useQuery({
    queryKey: epicExternalSourceQueryKeys.batch(sortedIds),
    queryFn: async ({ signal }): Promise<{ items: EpicExternalSourceBatchItem[] }> => {
      const response = await apiFetch('/api/epics/external-sources/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epicIds: sortedIds }),
        signal,
      });
      if (!response.ok) throw new Error('External task sources could not be loaded.');
      return response.json();
    },
    enabled: enabled && sortedIds.length > 0,
  });

  const sources = useMemo<EpicExternalSourceMap>(() => {
    const map = new Map<string, ExternalTaskSourceSummary>();
    for (const item of query.data?.items ?? []) {
      if (!map.has(item.epicId)) {
        const { epicId: _epicId, ...summary } = item;
        map.set(item.epicId, summary);
      }
    }
    return map;
  }, [query.data]);

  // Disabled contexts (worktree, unresolved runtime, admission off) never see
  // a main-tab cache entry's data.
  return { sources: enabled ? sources : undefined, query };
}
