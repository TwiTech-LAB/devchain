import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { epicTimeQueryKeys } from '@/ui/lib/epic-time';
import {
  dispatchRealtimeEnvelope,
  exactTopic,
  type RealtimeInvalidationRegistry,
} from '@/ui/lib/realtime-invalidation-registry';
import { useAppSocket } from './useAppSocket';

/**
 * Reacts to workspace-scoped Epic-time scope hints: committed parent or
 * external-link-boundary changes that reshape related-time rollups without
 * touching any relation row, so the relation invalidation topic never fires.
 */
export function createEpicTimeScopeInvalidationRegistry(
  workspaceId: string,
): RealtimeInvalidationRegistry {
  return [
    {
      match: exactTopic(`workspace/${workspaceId}/epic-time-scope`),
      type: 'invalidated',
      entries: [
        { kind: 'invalidate', queryKey: epicTimeQueryKeys.detailRoot() },
        { kind: 'invalidate', queryKey: epicTimeQueryKeys.batchRoot() },
        { kind: 'invalidate', queryKey: epicTimeQueryKeys.bufferRoot() },
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
    void queryClient.invalidateQueries({ queryKey: epicTimeQueryKeys.detailRoot() });
    void queryClient.invalidateQueries({ queryKey: epicTimeQueryKeys.batchRoot() });
    void queryClient.invalidateQueries({ queryKey: epicTimeQueryKeys.bufferRoot() });
  }, [queryClient, workspaceId]);

  const handleEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      if (!workspaceId || !envelope) return;
      dispatchRealtimeEnvelope(envelope, registry, queryClient);
    },
    [queryClient, registry, workspaceId],
  );

  useAppSocket({ message: handleEnvelope, connect: invalidateAll }, [
    handleEnvelope,
    invalidateAll,
  ]);
}
