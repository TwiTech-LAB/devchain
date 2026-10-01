import { useQuery } from '@tanstack/react-query';
import type { HostStats } from '@/modules/core/models/host-stats.model';
import type { RemoteStatsHistoryDto } from '@/modules/remotes/dtos/remote.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import { remoteStatsHistoryQueryKey } from '@/ui/lib/backend-provider';

/** One sample from `GET /api/remotes/:id/stats/history`. */
export type RemoteStatsSample = HostStats;
export type RemoteStatsHistory = RemoteStatsHistoryDto;

// Fallback when the remotes socket event is missed; refreshes normally arrive by
// invalidation from BackendProvider's remotes listener.
const REMOTE_STATS_HISTORY_POLL_MS = 30_000;

async function fetchRemoteStatsHistory(
  remoteId: string,
  signal: AbortSignal,
): Promise<RemoteStatsHistory> {
  const res = await apiFetch(
    `/api/remotes/${remoteId}/stats/history`,
    { signal },
    { backend: HOME_BACKEND },
  );
  if (!res.ok) {
    throw new Error(`Failed to load remote stats history (${res.status})`);
  }
  const body = (await res.json()) as Partial<RemoteStatsHistory>;
  return {
    intervalMs: typeof body.intervalMs === 'number' ? body.intervalMs : 0,
    samples: Array.isArray(body.samples) ? body.samples : [],
  };
}

/**
 * Stats history for one remote, always on the home client: the dock renders inside
 * `BackendBoundary`, whose ambient client is the remote's while a remote project is
 * active. BackendProvider invalidates this VM's history on its own `remotes`
 * events, or all histories on an event without a remoteId; polling is a fallback.
 */
export function useRemoteStatsHistory(remoteId: string) {
  const queryClient = useHomeQueryClient();
  return useQuery(
    {
      queryKey: remoteStatsHistoryQueryKey(remoteId),
      queryFn: ({ signal }) => fetchRemoteStatsHistory(remoteId, signal),
      refetchInterval: REMOTE_STATS_HISTORY_POLL_MS,
    },
    queryClient,
  );
}
