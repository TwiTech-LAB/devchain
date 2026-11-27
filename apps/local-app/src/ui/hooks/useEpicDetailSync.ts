import { useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { WsEnvelope } from '@/ui/lib/socket';
import {
  dispatchRealtimeEnvelope,
  exactTopic,
  type RealtimeInvalidationRegistry,
} from '@/ui/lib/realtime-invalidation-registry';
import { useAppSocket } from './useAppSocket';

/** Prefix of every single-epic read (`['epic', id]`). */
export const EPIC_DETAIL_QUERY_ROOT = ['epic'] as const;

export function epicDetailQueryKey(epicId: string): ['epic', string] {
  return [...EPIC_DETAIL_QUERY_ROOT, epicId];
}

/**
 * Refetches one open epic when the server commits a change to it, so the next
 * versioned save sends the current version. The Board's sync owns only the
 * `['epics', …]` list families and is not mounted on the epic route.
 */
export function createEpicDetailInvalidationRegistry(
  projectId: string,
  epicId: string,
): RealtimeInvalidationRegistry {
  const match = exactTopic(`project/${projectId}/epics`);
  return [
    {
      match,
      type: 'updated',
      entries: [
        {
          kind: 'custom-handler',
          handler: (payload, queryClient) => {
            if (payload.epicId !== epicId) return;
            void queryClient.invalidateQueries({ queryKey: epicDetailQueryKey(epicId) });
          },
        },
      ],
    },
    {
      // A replica apply may change any epic of the project.
      match,
      type: 'remote-synced',
      entries: [{ kind: 'invalidate', queryKey: epicDetailQueryKey(epicId) }],
    },
  ];
}

export function useEpicDetailSync(
  projectId: string | null | undefined,
  epicId: string | null | undefined,
): void {
  const queryClient = useQueryClient();
  const registry: RealtimeInvalidationRegistry = useMemo(
    () => (projectId && epicId ? createEpicDetailInvalidationRegistry(projectId, epicId) : []),
    [projectId, epicId],
  );

  const handleEnvelope = useCallback(
    (envelope: WsEnvelope) => {
      if (!envelope) return;
      dispatchRealtimeEnvelope(envelope, registry, queryClient);
    },
    [queryClient, registry],
  );

  const handleConnect = useCallback(() => {
    if (!epicId) return;
    void queryClient.invalidateQueries({ queryKey: epicDetailQueryKey(epicId) });
  }, [queryClient, epicId]);

  useAppSocket({ message: handleEnvelope, connect: handleConnect }, [
    handleEnvelope,
    handleConnect,
  ]);
}
