import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Thread, ThreadsListResponse } from '@/ui/lib/chat';
import { useToast } from '@/ui/hooks/use-toast';

interface ChatLauncherOptions {
  projectId: string | null;
}

interface LaunchChatOptions {
  projectId?: string;
  apiBase?: string;
}

interface LaunchChatRequest extends LaunchChatOptions {
  agentIds: string[];
}

function normalizeApiBase(apiBase?: string): string {
  if (!apiBase) {
    return '';
  }
  const trimmed = apiBase.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function buildApiUrl(path: string, apiBase?: string): string {
  return `${normalizeApiBase(apiBase)}${path}`;
}

async function fetchThreadsForContext(
  projectId: string,
  apiBase?: string,
): Promise<ThreadsListResponse> {
  const params = new URLSearchParams({
    projectId,
    createdByType: 'user',
    limit: '50',
    offset: '0',
  });
  const response = await fetch(buildApiUrl(`/api/chat/threads?${params.toString()}`, apiBase));
  if (!response.ok) {
    throw new Error('Failed to fetch threads');
  }
  return response.json();
}

async function createDirectThreadForContext(
  projectId: string,
  agentId: string,
  apiBase?: string,
): Promise<Thread> {
  const response = await fetch(buildApiUrl('/api/chat/threads/direct', apiBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, agentId }),
  });
  if (!response.ok) {
    throw new Error('Failed to create direct thread');
  }
  return response.json();
}

async function createGroupThreadForContext(
  projectId: string,
  agentIds: string[],
  apiBase?: string,
): Promise<Thread> {
  const response = await fetch(buildApiUrl('/api/chat/threads/group', apiBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, agentIds }),
  });
  if (!response.ok) {
    throw new Error('Failed to create group thread');
  }
  return response.json();
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
    mutationFn: async ({ agentIds, projectId: overrideProjectId, apiBase }: LaunchChatRequest) => {
      if (agentIds.length === 0) {
        throw new Error('At least one agent is required');
      }
      const projectIdToUse = overrideProjectId ?? projectId;
      if (!projectIdToUse) {
        throw new Error('A project is required to launch chat');
      }

      // Fetch existing user threads
      const threadsData = await fetchThreadsForContext(projectIdToUse, apiBase);

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
        return createDirectThreadForContext(projectIdToUse, agentId, apiBase);
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
      return createGroupThreadForContext(projectIdToUse, agentIds, apiBase);
    },
    onSuccess: (thread, variables) => {
      // Invalidate threads cache to ensure fresh data
      const projectIdToUse = variables.projectId ?? projectId;
      queryClient.invalidateQueries({ queryKey: ['threads', projectIdToUse] });

      // Navigate to chat page with thread ID in URL
      const currentParams =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search)
          : new URLSearchParams();
      currentParams.set('thread', thread.id);
      navigate(`/chat?${currentParams.toString()}`);
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
    (agentIds: string[], options?: LaunchChatOptions) => {
      launchChatMutation.mutate({
        agentIds,
        projectId: options?.projectId,
        apiBase: options?.apiBase,
      });
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
