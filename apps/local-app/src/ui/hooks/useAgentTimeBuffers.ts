import { useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';
import {
  epicTimeQueryKeys,
  MIN_VISIBLE_AGENT_TIME_BUFFER_MINUTES,
  type AgentTimeBufferItemWire,
  type AgentTimeBufferSnapshotWire,
} from '@/ui/lib/epic-time';

/** Whole minutes; sub-minute and degraded values contribute nothing visible. */
export function toWholeAgentTimeMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Lenient item parse: degraded payloads render no marker instead of crashing Chat. */
export function toAgentTimeBufferItems(value: unknown): AgentTimeBufferItemWire[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: AgentTimeBufferItemWire[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.agentId !== 'string' ||
      typeof record.snapshotToken !== 'string' ||
      typeof record.durationMs !== 'number' ||
      typeof record.segmentCount !== 'number' ||
      typeof record.oldestActivityAt !== 'string' ||
      typeof record.newestActivityAt !== 'string'
    ) {
      continue;
    }
    items.push({
      agentId: record.agentId,
      snapshotToken: record.snapshotToken,
      minutes: toWholeAgentTimeMinutes(record.minutes),
      durationMs: record.durationMs,
      segmentCount: record.segmentCount,
      oldestActivityAt: record.oldestActivityAt,
      newestActivityAt: record.newestActivityAt,
    });
  }
  return items;
}

function recordsEqual(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}

/**
 * One project-wide read of claimable agent time, admitted only in the main
 * runtime (resolved runtime, empty apiBase, selected project) and polled on a
 * five-second cadence there. The raw JSON snapshot stays in the query cache
 * so the assignment dialog can freeze exact tokens; the derived minute map
 * retains its previous reference across unchanged polls so the memoized
 * ChatSidebar bundles — and the AgentRow subtrees under them — stay idle.
 */
export function useAgentTimeBuffers(projectId: string | null): {
  admitted: boolean;
  snapshot: AgentTimeBufferSnapshotWire | undefined;
  minutesByAgentId: Record<string, number>;
} {
  const apiFetch = useFetchFactory();
  const { runtimeResolved, apiBase } = useOptionalWorktreeTab();
  const admitted = projectId !== null && runtimeResolved && apiBase === '';
  const scope = admitted ? 'main' : 'isolated';
  const cacheProjectId = projectId ?? '';

  const query = useQuery({
    queryKey: epicTimeQueryKeys.buffers(cacheProjectId, scope),
    queryFn: async ({ signal }): Promise<AgentTimeBufferSnapshotWire> => {
      const response = await apiFetch(
        `/api/agent-time-buffers?projectId=${encodeURIComponent(cacheProjectId)}`,
        { signal },
      );
      if (!response.ok) throw new Error('Agent time buffers could not be loaded.');
      const payload = (await response.json()) as Record<string, unknown>;
      return {
        capturedAt: typeof payload.capturedAt === 'string' ? payload.capturedAt : null,
        items: toAgentTimeBufferItems(payload.items),
      };
    },
    enabled: admitted,
    refetchInterval: admitted ? 5_000 : false,
  });

  // Fail-closed exposure: a failed read — including a failed background
  // refetch after earlier successful data — suppresses the snapshot and the
  // minute map, so no marker or action renders from retained stale data.
  // TanStack keeps the last successful payload in query.data; gating on the
  // error state keeps that retention inside the cache only.
  const exposed = admitted && !query.isError ? query.data : undefined;
  const items = exposed?.items ?? [];
  const minutesRef = useRef<Record<string, number>>({});
  const minutesByAgentId = useMemo(() => {
    const next: Record<string, number> = {};
    for (const item of items) {
      if (item.minutes >= MIN_VISIBLE_AGENT_TIME_BUFFER_MINUTES) {
        next[item.agentId] = item.minutes;
      }
    }
    if (recordsEqual(minutesRef.current, next)) {
      return minutesRef.current;
    }
    minutesRef.current = next;
    return next;
  }, [items]);

  return {
    admitted,
    snapshot: exposed,
    minutesByAgentId,
  };
}
