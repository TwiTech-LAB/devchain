import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';
import { epicRelationQueryKeys } from '@/ui/lib/epic-relations';

export interface EpicRelationCounts {
  related: number;
  blocks: number;
  blockedBy: number;
  total: number;
  /**
   * Directional split of `related`, present only when the payload carried a
   * complete consistent group. Absent means plain `Related N` rendering.
   */
  relatedSources?: number;
  relatedTargets?: number;
  relatedNeutral?: number;
}

export type EpicRelationCountsMap = ReadonlyMap<string, EpicRelationCounts>;

interface BatchRelationCountsItem {
  epicId?: unknown;
  related?: unknown;
  blocks?: unknown;
  blockedBy?: unknown;
  total?: unknown;
  relatedSources?: unknown;
  relatedTargets?: unknown;
  relatedNeutral?: unknown;
}

interface BatchRelationCountsPayload {
  items?: BatchRelationCountsItem[];
}

type DirectionalRelationCounts = Required<
  Pick<EpicRelationCounts, 'relatedSources' | 'relatedTargets' | 'relatedNeutral'>
>;

/**
 * The directional group is all-or-none: a payload that omits it keeps its
 * aggregate counts (legacy `Related N` fallback), and a group that is
 * partial, negative, non-finite, or inconsistent with `related` is dropped
 * the same way rather than partially trusted.
 */
function parseDirectionalCounts(item: BatchRelationCountsItem): DirectionalRelationCounts | null {
  const { relatedSources, relatedTargets, relatedNeutral } = item;
  if (
    typeof relatedSources !== 'number' ||
    typeof relatedTargets !== 'number' ||
    typeof relatedNeutral !== 'number'
  ) {
    return null;
  }
  if (
    !Number.isFinite(relatedSources) ||
    !Number.isFinite(relatedTargets) ||
    !Number.isFinite(relatedNeutral) ||
    relatedSources < 0 ||
    relatedTargets < 0 ||
    relatedNeutral < 0 ||
    relatedSources + relatedTargets + relatedNeutral !== item.related
  ) {
    return null;
  }
  return { relatedSources, relatedTargets, relatedNeutral };
}

/**
 * One guarded batch read of relation counts for the loaded Kanban context.
 * The caller owns the Epic-ID set (sorted and deduplicated here for a stable
 * query key); worktree and unresolved runtimes issue no request, key under
 * an isolated cache scope, and never see main-scope cached data through any
 * returned field. Disabled or empty contexts return a stable empty map, and
 * a failed read leaves the map empty: relation badges are decoration, never
 * a Board blocker.
 */
const EMPTY_COUNTS: EpicRelationCountsMap = new Map<string, EpicRelationCounts>();

export function useEpicRelationCountsBatch(
  epicIds: readonly string[],
  { enabled = true }: { enabled?: boolean } = {},
): { counts: EpicRelationCountsMap; query: ReturnType<typeof useQuery> } {
  const apiFetch = useFetchFactory();
  const { runtimeResolved, apiBase } = useOptionalWorktreeTab();
  const admitted = enabled && runtimeResolved && apiBase === '';
  const scope = admitted ? 'main' : 'isolated';
  // Sort before keying: any arrival order of the same Board context must
  // resolve to one cache entry.
  const sortedIds = useMemo(() => [...new Set(epicIds)].sort(), [epicIds]);

  const query = useQuery({
    queryKey: epicRelationQueryKeys.batch(sortedIds, scope),
    queryFn: async ({ signal }): Promise<EpicRelationCountsMap> => {
      const response = await apiFetch('/api/epics/relations/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epicIds: sortedIds }),
        signal,
      });
      if (!response.ok) throw new Error('Epic relation counts could not be loaded.');
      const payload = (await response.json()) as BatchRelationCountsPayload;
      const counts = new Map<string, EpicRelationCounts>();
      for (const item of payload.items ?? []) {
        if (
          typeof item?.epicId === 'string' &&
          typeof item?.related === 'number' &&
          typeof item?.blocks === 'number' &&
          typeof item?.blockedBy === 'number' &&
          typeof item?.total === 'number'
        ) {
          const directional = parseDirectionalCounts(item);
          counts.set(item.epicId, {
            related: item.related,
            blocks: item.blocks,
            blockedBy: item.blockedBy,
            total: item.total,
            ...(directional ?? {}),
          });
        }
      }
      return counts;
    },
    enabled: admitted && sortedIds.length > 0,
  });

  const counts = useMemo<EpicRelationCountsMap>(() => query.data ?? EMPTY_COUNTS, [query.data]);

  // Disabled contexts (worktree, unresolved runtime, empty set) get a
  // stable empty map; the isolated key keeps them off the main-scope cache
  // entry, which survives for re-admission.
  return { counts: admitted ? counts : EMPTY_COUNTS, query };
}
