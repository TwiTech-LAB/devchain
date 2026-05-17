import { useEffect, useRef, useMemo, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { type WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { useRealtimeDispatch } from '@/ui/hooks/useRealtimeDispatch';
import type { RealtimeInvalidationRegistry } from '@/ui/lib/realtime-invalidation-registry';
import { useToast } from '@/ui/hooks/use-toast';
import type { Message } from '@/ui/lib/chat';
import { chatQueryKeys, type AgentOrGuest } from './useChatQueries';
import { teamsQueryKeys } from '@/ui/lib/teams';

export interface UseChatSocketOptions {
  projectId: string | null;
  selectedThreadId: string | null;
  agents: AgentOrGuest[];
  onInlineUnread?: () => void;
  getLatestSelectedThreadId: () => string | null;
  isInlineActive: () => boolean;
}

export interface UseChatSocketResult {
  socketRef: React.RefObject<Socket | null>;
  subscribedThreadRef: React.RefObject<string | null>;
}

export function useChatSocket({
  projectId,
  selectedThreadId,
  agents,
  onInlineUnread,
  getLatestSelectedThreadId,
  isInlineActive,
}: UseChatSocketOptions): UseChatSocketResult {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const hasSelectedProject = Boolean(projectId);

  const socketRef = useRef<Socket | null>(null);
  const subscribedThreadRef = useRef<string | null>(null);
  const latestSelectedThreadRef = useRef<string | null>(null);

  useEffect(() => {
    latestSelectedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  const invalidationRegistry: RealtimeInvalidationRegistry = useMemo(() => {
    if (!projectId) return [];
    const stateTopic = `project/${projectId}/state`;
    return [
      {
        match: (t: string) => t === stateTopic,
        type: 'agent.created',
        entries: [
          { kind: 'invalidate', queryKey: ['agents', projectId] },
          { kind: 'invalidate', queryKey: ['active-sessions', projectId] },
        ],
      },
      {
        match: (t: string) => t === stateTopic,
        type: 'team.member.added',
        entries: [
          { kind: 'invalidate', queryKey: ['agents', projectId] },
          { kind: 'invalidate', queryKey: ['teams', projectId] },
        ],
      },
      {
        match: (t: string) => t === stateTopic,
        type: 'team.member.removed',
        entries: [
          { kind: 'invalidate', queryKey: ['agents', projectId] },
          { kind: 'invalidate', queryKey: ['teams', projectId] },
        ],
      },
      {
        match: (t: string) => t === stateTopic,
        type: 'agent.deleted',
        entries: [
          { kind: 'invalidate', queryKey: ['agents', projectId] },
          { kind: 'invalidate', queryKey: ['agent-presence', projectId] },
          { kind: 'invalidate', queryKey: ['active-sessions', projectId] },
          { kind: 'invalidate', queryKey: ['teams', projectId] },
          { kind: 'invalidate', queryKey: ['teams', 'detail'] },
          { kind: 'invalidate', queryKey: ['user-threads', projectId] },
          { kind: 'invalidate', queryKey: ['agent-threads', projectId] },
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
      connect: () => {
        const threadToSubscribe = subscribedThreadRef.current ?? getLatestSelectedThreadId();
        if (threadToSubscribe) {
          socketRef.current?.emit('chat:subscribe', { threadId: threadToSubscribe });
          subscribedThreadRef.current = threadToSubscribe;
        }
      },
      disconnect: () => {
        subscribedThreadRef.current = null;
      },
      message: (envelope: WsEnvelope) => {
        const { topic, type, payload } = envelope;

        if (projectId && topic === `project/${projectId}/state`) {
          if (type === 'team.member.added' || type === 'team.member.removed') {
            handleTeamDetailInvalidation(payload as Record<string, unknown>);
          }
          if (type === 'team.config.updated') {
            handleTeamDetailInvalidation(payload as Record<string, unknown>);
          }
          return;
        }

        if (topic.startsWith('chat/') && type === 'message.created') {
          const threadId = topic.split('/')[1];
          const message = payload as Message;
          queryClient.invalidateQueries({ queryKey: ['messages', threadId] });

          const activeThreadId = getLatestSelectedThreadId();
          if (threadId === activeThreadId && message.authorType === 'agent') {
            const agentName = agents.find((a) => a.id === message.authorAgentId)?.name || 'Agent';
            toast({
              title: `New message from ${agentName}`,
              description:
                message.content.substring(0, 50) + (message.content.length > 50 ? '...' : ''),
            });
          }

          if (threadId === activeThreadId && isInlineActive()) {
            onInlineUnread?.();
          }
        }

        if (topic === 'system' && type === 'ping') {
          socketRef.current?.emit('pong');
        }
      },
    },
    [
      projectId,
      agents,
      queryClient,
      toast,
      getLatestSelectedThreadId,
      isInlineActive,
      onInlineUnread,
      handleTeamDetailInvalidation,
    ],
  );

  socketRef.current = selectedSocket;

  useEffect(() => {
    if (!hasSelectedProject) {
      if (selectedSocket.connected && subscribedThreadRef.current) {
        selectedSocket.emit('chat:unsubscribe', { threadId: subscribedThreadRef.current });
      }
      subscribedThreadRef.current = null;
      return;
    }
  }, [hasSelectedProject, selectedSocket]);

  useEffect(() => {
    if (!selectedSocket.connected) {
      subscribedThreadRef.current = selectedThreadId ?? null;
      return;
    }

    if (!selectedThreadId) {
      if (subscribedThreadRef.current) {
        selectedSocket.emit('chat:unsubscribe', { threadId: subscribedThreadRef.current });
        subscribedThreadRef.current = null;
      }
      return;
    }

    if (subscribedThreadRef.current === selectedThreadId) {
      return;
    }

    if (subscribedThreadRef.current) {
      selectedSocket.emit('chat:unsubscribe', { threadId: subscribedThreadRef.current });
    }
    selectedSocket.emit('chat:subscribe', { threadId: selectedThreadId });
    subscribedThreadRef.current = selectedThreadId;
  }, [selectedThreadId, selectedSocket]);

  return {
    socketRef,
    subscribedThreadRef,
  };
}
