import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createDirectThread, createGroupThread, fetchThreads } from '@/ui/lib/chat';
import { useToast } from '@/ui/hooks/use-toast';

interface ChatLauncherOptions {
  projectId: string;
}

/**
 * Hook to launch or focus a chat thread with specified agents
 * Finds existing thread or creates new one, then navigates to chat page
 */
export function useChatLauncher({ projectId }: ChatLauncherOptions) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const launchChatMutation = useMutation({
    mutationFn: async (agentIds: string[]) => {
      if (agentIds.length === 0) {
        throw new Error('At least one agent is required');
      }

      // Fetch existing user threads
      const threadsData = await fetchThreads(projectId, 'user');

      // For single agent, look for existing direct thread
      if (agentIds.length === 1) {
        const agentId = agentIds[0];
        const existingDirectThread = threadsData.items.find(
          (thread) =>
            !thread.isGroup && thread.members?.length === 1 && thread.members[0] === agentId,
        );

        if (existingDirectThread) {
          return existingDirectThread;
        }

        // Create new direct thread
        return createDirectThread({ projectId, agentId });
      }

      // For multiple agents, look for existing group with exact same members
      const sortedAgentIds = [...agentIds].sort();
      const existingGroupThread = threadsData.items.find((thread) => {
        if (!thread.isGroup || !thread.members) return false;
        const sortedMembers = [...thread.members].sort();
        return (
          sortedMembers.length === sortedAgentIds.length &&
          sortedMembers.every((id, index) => id === sortedAgentIds[index])
        );
      });

      if (existingGroupThread) {
        return existingGroupThread;
      }

      // Create new group thread
      return createGroupThread({ projectId, agentIds });
    },
    onSuccess: (thread) => {
      // Invalidate threads cache to ensure fresh data
      queryClient.invalidateQueries({ queryKey: ['threads', projectId] });

      // Navigate to chat page with thread ID in URL
      navigate(`/chat?thread=${thread.id}`);
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to open chat',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const launchChat = useCallback(
    (agentIds: string[]) => {
      launchChatMutation.mutate(agentIds);
    },
    [launchChatMutation],
  );

  return {
    launchChat,
    isLaunching: launchChatMutation.isPending,
  };
}

/**
 * Component wrapper for chat launcher functionality
 * Use this when you need a button/link to launch a chat
 */
interface ChatLauncherProps {
  projectId: string;
  agentIds: string[];
  children: (props: { onClick: () => void; isLaunching: boolean }) => React.ReactNode;
}

export function ChatLauncher({ projectId, agentIds, children }: ChatLauncherProps) {
  const { launchChat, isLaunching } = useChatLauncher({ projectId });

  const handleClick = () => {
    launchChat(agentIds);
  };

  return <>{children({ onClick: handleClick, isLaunching })}</>;
}
