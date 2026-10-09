import { useRef, useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { agentQueryKeys } from '@/ui/lib/agents';
import { type WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { useRealtimeDispatch } from '@/ui/hooks/useRealtimeDispatch';
import type { RealtimeInvalidationRegistry } from '@/ui/lib/realtime-invalidation-registry';
import { teamsQueryKeys } from '@/ui/lib/teams';

export interface UseChatSocketOptions {
  projectId: string | null;
}

export interface UseChatSocketResult {
  socketRef: React.RefObject<Socket | null>;
}

export function useChatSocket({ projectId }: UseChatSocketOptions): UseChatSocketResult {
  const queryClient = useQueryClient();

  const socketRef = useRef<Socket | null>(null);

  const invalidationRegistry: RealtimeInvalidationRegistry = useMemo(() => {
    if (!projectId) return [];
    const stateTopic = `project/${projectId}/state`;
    return [
      {
        match: (t: string) => t === stateTopic,
        type: 'agent.created',
        entries: [
          { kind: 'invalidate', queryKey: [...agentQueryKeys.project(projectId)] },
          { kind: 'invalidate', queryKey: ['active-sessions', projectId] },
        ],
      },
      {
        match: (t: string) => t === stateTopic,
        type: 'team.member.added',
        entries: [
          { kind: 'invalidate', queryKey: [...agentQueryKeys.project(projectId)] },
          { kind: 'invalidate', queryKey: ['teams', projectId] },
        ],
      },
      {
        match: (t: string) => t === stateTopic,
        type: 'team.member.removed',
        entries: [
          { kind: 'invalidate', queryKey: [...agentQueryKeys.project(projectId)] },
          { kind: 'invalidate', queryKey: ['teams', projectId] },
        ],
      },
      {
        match: (t: string) => t === stateTopic,
        type: 'agent.deleted',
        entries: [
          { kind: 'invalidate', queryKey: [...agentQueryKeys.project(projectId)] },
          { kind: 'invalidate', queryKey: ['agent-presence', projectId] },
          { kind: 'invalidate', queryKey: ['active-sessions', projectId] },
          { kind: 'invalidate', queryKey: ['teams', projectId] },
          { kind: 'invalidate', queryKey: ['teams', 'detail'] },
        ],
      },
      {
        match: (t: string) => t === stateTopic,
        type: 'team.config.updated',
        entries: [{ kind: 'invalidate', queryKey: ['teams', projectId] }],
      },
      {
        match: (t: string) => t.startsWith('agent/'),
        type: 'presence',
        entries: [{ kind: 'invalidate', queryKey: ['agent-presence'] }],
      },
      {
        match: (t: string) => t.startsWith('session/'),
        type: 'activity',
        entries: [{ kind: 'invalidate', queryKey: ['agent-presence'] }],
      },
    ];
  }, [projectId]);

  useRealtimeDispatch(invalidationRegistry);

  const handleTeamDetailInvalidation = useCallback(
    (payload: Record<string, unknown>) => {
      const teamId = payload?.teamId as string | undefined;
      if (teamId) {
        queryClient.invalidateQueries({ queryKey: teamsQueryKeys.detail(teamId) });
      }
    },
    [queryClient],
  );

  const selectedSocket = useAppSocket(
    {
      message: (envelope: WsEnvelope) => {
        const { topic, type, payload } = envelope;

        if (projectId && topic === `project/${projectId}/state`) {
          if (type === 'team.member.added' || type === 'team.member.removed') {
            handleTeamDetailInvalidation(payload as Record<string, unknown>);
          }
          if (type === 'team.config.updated') {
            handleTeamDetailInvalidation(payload as Record<string, unknown>);
          }
        }
      },
    },
    [projectId, handleTeamDetailInvalidation],
  );

  socketRef.current = selectedSocket;

  return { socketRef };
}
