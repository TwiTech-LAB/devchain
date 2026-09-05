import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { epicRelationQueryKeys } from '@/ui/lib/epic-relations';
import { epicTimeQueryKeys } from '@/ui/lib/epic-time';
import {
  dispatchRealtimeEnvelope,
  exactTopic,
  type RealtimeInvalidationRegistry,
} from '@/ui/lib/realtime-invalidation-registry';
import { useAppSocket } from './useAppSocket';

export function createEpicRelationsInvalidationRegistry(
  workspaceId: string,
): RealtimeInvalidationRegistry {
  return [
    {
      match: exactTopic(`workspace/${workspaceId}/epic-relations`),
      type: 'invalidated',
      entries: [
        { kind: 'invalidate', queryKey: epicRelationQueryKeys.detailRoot() },
        { kind: 'invalidate', queryKey: epicRelationQueryKeys.candidateRoot() },
        { kind: 'invalidate', queryKey: epicRelationQueryKeys.batchRoot() },
        // A route change reshapes related-time rollups, so the Epic-time
        // families ride the same invalidation.
        { kind: 'invalidate', queryKey: epicTimeQueryKeys.detailRoot() },
        { kind: 'invalidate', queryKey: epicTimeQueryKeys.batchRoot() },
      ],
    },
  ];
}

export function useEpicRelationsSync(workspaceId: string | null | undefined): void {
  const queryClient = useQueryClient();
  const registry: RealtimeInvalidationRegistry = useMemo(() => {
    if (!workspaceId) return [];
    return createEpicRelationsInvalidationRegistry(workspaceId);
  }, [workspaceId]);

  const invalidateAll = useCallback(() => {
    if (!workspaceId) return;
    void queryClient.invalidateQueries({ queryKey: epicRelationQueryKeys.detailRoot() });
    void queryClient.invalidateQueries({ queryKey: epicRelationQueryKeys.candidateRoot() });
    void queryClient.invalidateQueries({ queryKey: epicRelationQueryKeys.batchRoot() });
    void queryClient.invalidateQueries({ queryKey: epicTimeQueryKeys.detailRoot() });
    void queryClient.invalidateQueries({ queryKey: epicTimeQueryKeys.batchRoot() });
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
