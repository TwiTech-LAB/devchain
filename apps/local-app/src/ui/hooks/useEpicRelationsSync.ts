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
  const match = exactTopic(`workspace/${workspaceId}/epic-relations`);
  const entries: RealtimeInvalidationRegistry[number]['entries'] = [
    { kind: 'invalidate', queryKey: epicRelationQueryKeys.detailRoot() },
    { kind: 'invalidate', queryKey: epicRelationQueryKeys.candidateRoot() },
    { kind: 'invalidate', queryKey: epicRelationQueryKeys.batchRoot() },
    // A route change reshapes related-time rollups, so the Epic-time
    // families ride the same invalidation.
    { kind: 'invalidate', queryKey: epicTimeQueryKeys.detailRoot() },
    { kind: 'invalidate', queryKey: epicTimeQueryKeys.batchRoot() },
  ];
  // `remote-synced`: a replica apply from a remote may have changed any relation.
  return [
    { match, type: 'invalidated', entries },
    { match, type: 'remote-synced', entries },
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
