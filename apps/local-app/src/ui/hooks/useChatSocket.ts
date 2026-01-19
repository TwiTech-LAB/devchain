import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { getAppSocket, releaseAppSocket, type WsEnvelope } from '@/ui/lib/socket';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { useToast } from '@/ui/hooks/use-toast';
import type { Message } from '@/ui/lib/chat';
import type { AgentOrGuest } from './useChatQueries';

// ============================================
// Types
// ============================================

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

// ============================================
// Hook
// ============================================

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

  // Keep latestSelectedThreadRef in sync
  useEffect(() => {
    latestSelectedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  // Initialize shared socket reference
  useEffect(() => {
    socketRef.current = getAppSocket();
    return () => {
      releaseAppSocket();
      socketRef.current = null;
    };
  }, []);

  // Subscribe to socket events via shared hook
  useAppSocket(
    {
      connect: () => {
        const socket = getAppSocket();
        const threadToSubscribe = subscribedThreadRef.current ?? getLatestSelectedThreadId();
        if (threadToSubscribe) {
          socket.emit('chat:subscribe', { threadId: threadToSubscribe });
          subscribedThreadRef.current = threadToSubscribe;
        }
      },
      disconnect: () => {
        subscribedThreadRef.current = null;
      },
      message: (envelope: WsEnvelope) => {
        const { topic, type, payload } = envelope;

        // Handle message.created events for chat threads
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

        // Presence updates
        if (topic.startsWith('agent/') && type === 'presence') {
          queryClient.invalidateQueries({ queryKey: ['agent-presence'] });
        }

        // Session activity updates
        if (topic.startsWith('session/') && type === 'activity') {
          queryClient.invalidateQueries({ queryKey: ['agent-presence'] });
        }

        // System ping
        if (topic === 'system' && type === 'ping') {
          getAppSocket().emit('pong');
        }
      },
    },
    [agents, queryClient, toast, getLatestSelectedThreadId, isInlineActive, onInlineUnread],
  );

  // If project context is removed, unsubscribe from current thread
  useEffect(() => {
    const socket = getAppSocket();
    if (!hasSelectedProject) {
      if (socket.connected && subscribedThreadRef.current) {
        socket.emit('chat:unsubscribe', { threadId: subscribedThreadRef.current });
      }
      subscribedThreadRef.current = null;
      return;
    }
  }, [hasSelectedProject]);

  // Subscribe to chat thread when selected
  useEffect(() => {
    const socket = getAppSocket();
    if (!socket.connected) {
      subscribedThreadRef.current = selectedThreadId ?? null;
      return;
    }

    if (!selectedThreadId) {
      if (subscribedThreadRef.current) {
        socket.emit('chat:unsubscribe', { threadId: subscribedThreadRef.current });
        subscribedThreadRef.current = null;
      }
      return;
    }

    if (subscribedThreadRef.current === selectedThreadId) {
      return;
    }

    if (subscribedThreadRef.current) {
      socket.emit('chat:unsubscribe', { threadId: subscribedThreadRef.current });
    }
    socket.emit('chat:subscribe', { threadId: selectedThreadId });
    subscribedThreadRef.current = selectedThreadId;
  }, [selectedThreadId]);

  return {
    socketRef,
    subscribedThreadRef,
  };
}
