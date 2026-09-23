import { useCallback, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from './useAppSocket';
import { createBoardInvalidationRegistry, refreshBoardCache } from '@/ui/lib/board-cache';
import {
  type RealtimeInvalidationRegistry,
  dispatchRealtimeEnvelope,
} from '@/ui/lib/realtime-invalidation-registry';

export interface UseBoardSyncArgs {
  selectedProjectId: string | null | undefined;
  parentFilter: string | undefined;
}

export function useBoardSync({ selectedProjectId, parentFilter }: UseBoardSyncArgs): void {
  const queryClient = useQueryClient();

  const registry: RealtimeInvalidationRegistry = useMemo(
    () => createBoardInvalidationRegistry({ projectId: selectedProjectId, parentFilter }),
    [selectedProjectId, parentFilter],
  );

  const handleBoardEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      if (!selectedProjectId || !envelope) return;
      dispatchRealtimeEnvelope(envelope, registry, queryClient);
    },
    [queryClient, selectedProjectId, registry],
  );

  const handleSocketConnect = useCallback(() => {
    refreshBoardCache(queryClient, { projectId: selectedProjectId, parentFilter });
  }, [queryClient, selectedProjectId, parentFilter]);

  useAppSocket({ message: handleBoardEnvelope, connect: handleSocketConnect }, [
    handleBoardEnvelope,
    handleSocketConnect,
  ]);

  useEffect(() => {
    if (!selectedProjectId) return;
    const interval = setInterval(() => {
      refreshBoardCache(queryClient, { projectId: selectedProjectId, parentFilter });
    }, 60000);
    return () => clearInterval(interval);
  }, [queryClient, selectedProjectId, parentFilter]);
}
