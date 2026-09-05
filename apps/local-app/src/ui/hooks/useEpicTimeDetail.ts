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
  const items: EpicTimeSummaryItem[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.activityDate !== 'string' ||
      typeof record.agentId !== 'string' ||
      typeof record.agentName !== 'string' ||
      typeof record.minutes !== 'number'
    ) {
      continue;
    }
    const item: EpicTimeSummaryItem = {
      activityDate: record.activityDate,
      agentId: record.agentId,
      agentName: record.agentName,
      minutes: record.minutes,
    };
    // A team row without a complete id-and-name snapshot renders as direct
    // agent time, so a degraded payload can never surface "undefined".
    if (
      record.attributionSource === 'team' &&
      typeof record.teamId === 'string' &&
      record.teamId.length > 0 &&
      typeof record.teamName === 'string' &&
      record.teamName.length > 0
    ) {
      item.attributionSource = 'team';
      item.teamId = record.teamId;
      item.teamName = record.teamName;
    }
    items.push(item);
  }
  return items;
}

function toTaskItems(value: unknown): EpicTimeTaskItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: EpicTimeTaskItem[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.epicId !== 'string' ||
      typeof record.epicTitle !== 'string' ||
      typeof record.isDirect !== 'boolean' ||
      typeof record.minutes !== 'number'
    ) {
      continue;
    }
    const item: EpicTimeTaskItem = {
      epicId: record.epicId,
      epicTitle: record.epicTitle,
      isDirect: record.isDirect,
      minutes: record.minutes,
    };
    // Group metadata survives only as a complete valid pair; a row without
    // it still renders, and the contributor list falls back to flat.
    if (
      typeof record.groupEpicId === 'string' &&
      record.groupEpicId.length > 0 &&
      typeof record.groupEpicTitle === 'string'
    ) {
      item.groupEpicId = record.groupEpicId;
      item.groupEpicTitle = record.groupEpicTitle;
    }
    items.push(item);
  }
  return items;
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
    // Scope flag, not minutes: a degraded payload without it simply labels
    // the total without the related clause.
    includesRelatedTime: record.includesRelatedTime === true,
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
  /**
   * The mounted canonical IANA zone behind the detail dates. Stable for the
   * mount; a remount adopts a new browser zone. Export surfaces must reuse
   * this value instead of re-reading the browser, so the dates they show and
   * send always belong to the detail query's zone.
   */
  timeZone: string;
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

  return { admitted, summary: admitted ? query.data : undefined, timeZone, query };
}
