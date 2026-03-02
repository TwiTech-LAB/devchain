import { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from './useAppSocket';

type EpicEventPayload = {
  epic?: { parentId?: string | null } | null;
  parentId?: string | null;
};

export interface UseBoardSyncArgs {
  selectedProjectId: string | null | undefined;
  parentFilter: string | undefined;
}

export function useBoardSync({ selectedProjectId, parentFilter }: UseBoardSyncArgs): void {
  const queryClient = useQueryClient();

  const handleBoardEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      if (!selectedProjectId || !envelope) return;
      const topic = `project/${selectedProjectId}/epics` as const;
      if (envelope.topic !== topic) return;
      const lifecycle =
        envelope.type === 'created' || envelope.type === 'updated' || envelope.type === 'deleted';
      if (!lifecycle) return;

      // Always refresh project epics list for all filter variants
      queryClient.invalidateQueries({ queryKey: ['epics', selectedProjectId] });

      const payload = (envelope.payload ?? {}) as EpicEventPayload;
      const parentId = payload.epic?.parentId ?? payload.parentId ?? null;

      // If a sub-epic changed, refresh its parent's sub-epic counts and list (when filtered)
      if (parentId) {
        queryClient.invalidateQueries({ queryKey: ['epics', parentId, 'sub-counts'] });
        if (parentFilter === parentId) {
          queryClient.invalidateQueries({ queryKey: ['epics', 'parent', parentFilter] });
        }
      } else if (parentFilter) {
        // Fallback: if parent filter is active, ensure its list stays fresh
        queryClient.invalidateQueries({ queryKey: ['epics', 'parent', parentFilter] });
      }
    },
    [queryClient, selectedProjectId, parentFilter],
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

  // Safety net: periodic refresh to recover from missed envelopes during reconnects
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
