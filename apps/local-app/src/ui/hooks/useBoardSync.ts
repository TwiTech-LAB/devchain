import { useCallback, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from './useAppSocket';
import {
  type RealtimeInvalidationRegistry,
  dispatchRealtimeEnvelope,
} from '@/ui/lib/realtime-invalidation-registry';

type EpicEventPayload = {
  epic?: { parentId?: string | null } | null;
  parentId?: string | null;
};

export interface UseBoardSyncArgs {
  selectedProjectId: string | null | undefined;
  parentFilter: string | undefined;
}

function extractParentId(payload: Record<string, unknown>): string | null {
  const typed = payload as unknown as EpicEventPayload;
  return typed.epic?.parentId ?? typed.parentId ?? null;
}

export function useBoardSync({ selectedProjectId, parentFilter }: UseBoardSyncArgs): void {
  const queryClient = useQueryClient();

  const registry: RealtimeInvalidationRegistry = useMemo(() => {
    if (!selectedProjectId) return [];
    const topic = `project/${selectedProjectId}/epics`;
    const entries = [
      { kind: 'invalidate' as const, queryKey: ['epics', selectedProjectId] },
      {
        kind: 'custom-handler' as const,
        handler: (
          payload: Record<string, unknown>,
          qc: import('@tanstack/react-query').QueryClient,
        ) => {
          const pid = extractParentId(payload);
          if (pid) {
            qc.invalidateQueries({ queryKey: ['epics', pid, 'sub-counts'] });
            if (parentFilter === pid) {
              qc.invalidateQueries({ queryKey: ['epics', 'parent', parentFilter] });
            }
          } else if (parentFilter) {
            qc.invalidateQueries({ queryKey: ['epics', 'parent', parentFilter] });
          }
        },
      },
    ];
    return ['created', 'updated', 'deleted'].map((type) => ({
      match: (t: string) => t === topic,
      type,
      entries,
    }));
  }, [selectedProjectId, parentFilter]);

  const handleBoardEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      if (!selectedProjectId || !envelope) return;
      dispatchRealtimeEnvelope(envelope, registry, queryClient);
    },
    [queryClient, selectedProjectId, registry],
  );

  const handleSocketConnect = useCallback(() => {
    if (!selectedProjectId) return;
    queryClient.invalidateQueries({ queryKey: ['epics', selectedProjectId] });
    if (parentFilter) {
      queryClient.invalidateQueries({ queryKey: ['epics', 'parent', parentFilter] });
    }
  }, [queryClient, selectedProjectId, parentFilter]);

  useAppSocket({ message: handleBoardEnvelope, connect: handleSocketConnect }, [
    handleBoardEnvelope,
    handleSocketConnect,
  ]);

  useEffect(() => {
    if (!selectedProjectId) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['epics', selectedProjectId] });
      if (parentFilter) {
        queryClient.invalidateQueries({ queryKey: ['epics', 'parent', parentFilter] });
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [queryClient, selectedProjectId, parentFilter]);
}
