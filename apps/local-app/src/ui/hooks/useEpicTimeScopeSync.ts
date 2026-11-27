import { useCallback, useMemo } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { epicTimeQueryKeys } from '@/ui/lib/epic-time';
import {
  epicExternalSourceQueryKeys,
  isProviderLinkStateQueryKey,
} from '@/ui/lib/external-my-work';
import {
  dispatchRealtimeEnvelope,
  exactTopic,
  type RealtimeInvalidationRegistry,
} from '@/ui/lib/realtime-invalidation-registry';
import { EPIC_DETAIL_QUERY_ROOT } from './useEpicDetailSync';
import { useHomeSocket } from './useHomeSocket';

/** Refreshes the Epic-time rollups: every scope hint changes them. */
function invalidateEpicTimeViews(queryClient: QueryClient): void {
  for (const queryKey of [
    epicTimeQueryKeys.detailRoot(),
    epicTimeQueryKeys.batchRoot(),
    epicTimeQueryKeys.bufferRoot(),
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

/**
 * Refreshes every view a committed external-link change can make stale: the
 * Epic-time rollups, the epic's own reads (their version moves with the link),
 * the native source notes, and the provider-side link lookups and task detail.
 */
export function invalidateEpicLinkViews(queryClient: QueryClient): void {
  invalidateEpicTimeViews(queryClient);
  for (const queryKey of [EPIC_DETAIL_QUERY_ROOT, epicExternalSourceQueryKeys.all]) {
    void queryClient.invalidateQueries({ queryKey });
  }
  void queryClient.invalidateQueries({
    predicate: (query) => isProviderLinkStateQueryKey(query.queryKey),
  });
}

/**
 * Reacts to workspace-scoped Epic-time scope hints: committed parent or
 * external-link-boundary changes that reshape related-time rollups without
 * touching any relation row, so the relation invalidation topic never fires.
 * A hint that an external link changed (`externalLinks`) also refreshes the
 * link views; a reconnect refreshes everything, since hints may have been
 * missed. The hint is broadcast on the home socket — epic-time reads are
 * home-always regardless of the active project's backend — so this subscribes
 * there too.
 */
export function createEpicTimeScopeInvalidationRegistry(
  workspaceId: string,
): RealtimeInvalidationRegistry {
  return [
    {
      match: exactTopic(`workspace/${workspaceId}/epic-time-scope`),
      type: 'invalidated',
      entries: [
        {
          kind: 'custom-handler',
          handler: (payload, queryClient) => {
            if (payload.externalLinks === true) invalidateEpicLinkViews(queryClient);
            else invalidateEpicTimeViews(queryClient);
          },
        },
      ],
    },
  ];
}

export function useEpicTimeScopeSync(workspaceId: string | null | undefined): void {
  const queryClient = useQueryClient();
  const registry: RealtimeInvalidationRegistry = useMemo(() => {
    if (!workspaceId) return [];
    return createEpicTimeScopeInvalidationRegistry(workspaceId);
  }, [workspaceId]);

  const invalidateAll = useCallback(() => {
    if (!workspaceId) return;
    invalidateEpicLinkViews(queryClient);
  }, [queryClient, workspaceId]);

  const handleEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      if (!workspaceId || !envelope) return;
      dispatchRealtimeEnvelope(envelope, registry, queryClient);
    },
    [queryClient, registry, workspaceId],
  );

  useHomeSocket({ message: handleEnvelope, connect: invalidateAll }, [
    handleEnvelope,
    invalidateAll,
  ]);
}
