import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  EpicTimeDetailSummary,
  EpicTimeSummaryItem,
  EpicTimeTaskItem,
} from '@/modules/epic-time/models/epic-time.models';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';
import { epicTimeQueryKeys, resolveEpicTimeZone } from '@/ui/lib/epic-time';

function toWholeMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function toSummaryItems(value: unknown): EpicTimeSummaryItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (
      item: unknown,
    ): item is {
      activityDate: string;
      agentId: string;
      agentName: string;
      minutes: number;
    } => {
      if (item === null || typeof item !== 'object') return false;
      const record = item as Record<string, unknown>;
      return (
        typeof record.activityDate === 'string' &&
        typeof record.agentId === 'string' &&
        typeof record.agentName === 'string' &&
        typeof record.minutes === 'number'
      );
    },
  );
}

function toTaskItems(value: unknown): EpicTimeTaskItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (
      item: unknown,
    ): item is {
      epicId: string;
      epicTitle: string;
      isDirect: boolean;
      minutes: number;
    } => {
      if (item === null || typeof item !== 'object') return false;
      const record = item as Record<string, unknown>;
      return (
        typeof record.epicId === 'string' &&
        typeof record.epicTitle === 'string' &&
        typeof record.isDirect === 'boolean' &&
        typeof record.minutes === 'number'
      );
    },
  );
}

// The wire shape is trusted, but degraded payloads (proxies, catch-all test
// fetch doubles) must still render as an empty estimate instead of crashing
// the detail page.
function normalizeDetailSummary(payload: unknown): EpicTimeDetailSummary {
  const record = (payload ?? {}) as Record<string, unknown>;
  return {
    isRoot: record.isRoot === true,
    directMinutes: toWholeMinutes(record.directMinutes),
    totalMinutes: toWholeMinutes(record.totalMinutes),
    items: toSummaryItems(record.items),
    taskItems: toTaskItems(record.taskItems),
  };
}

/**
 * Estimated-time summary for one Epic detail page. Worktree and unresolved
 * runtimes issue no request, key under an isolated cache scope, and never
 * see main-scope cached data through any returned field; the summary
 * refreshes on a 60-second cadence.
 */
export function useEpicTimeDetail(
  epicId: string | null,
  { enabled = true }: { enabled?: boolean } = {},
): {
  admitted: boolean;
  summary: EpicTimeDetailSummary | undefined;
  query: ReturnType<typeof useQuery>;
} {
  const apiFetch = useFetchFactory();
  const { runtimeResolved, apiBase } = useOptionalWorktreeTab();
  const admitted = enabled && runtimeResolved && apiBase === '' && epicId !== null;
  const scope = admitted ? 'main' : 'isolated';
  const timeZone = useMemo(() => resolveEpicTimeZone(), []);

  const query = useQuery({
    queryKey: epicTimeQueryKeys.detail(epicId ?? '', timeZone, scope),
    queryFn: async ({ signal }): Promise<EpicTimeDetailSummary> => {
      const response = await apiFetch(
        `/api/epics/${encodeURIComponent(epicId as string)}/time-logs?timeZone=${encodeURIComponent(timeZone)}`,
        { signal },
      );
      if (!response.ok) throw new Error('Epic time summary could not be loaded.');
      return normalizeDetailSummary(await response.json());
    },
    enabled: admitted,
    refetchInterval: 60_000,
  });

  return { admitted, summary: admitted ? query.data : undefined, query };
}
