import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryObserverResult,
} from '@tanstack/react-query';
import { useToast } from '@/ui/hooks/use-toast';
import {
  fetchAgentPresence,
  fetchActiveSessions,
  type ActiveSession,
  type AgentPresenceMap,
} from '@/ui/lib/sessions';
import { fetchPreflightChecks, type PreflightResult } from '@/ui/lib/preflight';
import {
  fetchThreads,
  createGroupThread,
  fetchMessages,
  createMessage,
  inviteMembers,
  clearHistory,
  purgeHistory,
  type Message,
  type Thread,
} from '@/ui/lib/chat';

// ============================================
// Types
// ============================================

export type AgentOrGuest = {
  id: string;
  name: string;
  profileId?: string | null;
  description?: string | null;
  type?: 'agent' | 'guest';
  tmuxSessionId?: string;
};

export interface PendingLaunchAgent {
  agentId: string;
  providerId: string;
  providerName: string;
  options: { attach?: boolean; silent?: boolean };
}

export interface UseChatQueriesOptions {
  projectId: string | null;
  selectedThreadId: string | null;
  projectRootPath?: string;
}

export interface UseChatQueriesResult {
  // Agent presence
  agentPresence: AgentPresenceMap;
  agentPresenceLoading: boolean;
  presenceReady: boolean;

  // Active sessions
  activeSessions: ActiveSession[];

  // Agents and guests
  agents: AgentOrGuest[];
  guests: AgentOrGuest[];
  allAgentsAndGuests: AgentOrGuest[];
  agentsLoading: boolean;
  agentsError: boolean;

  // Profiles and providers
  profiles: Array<{ id: string; providerId: string }>;
  providers: Array<{ id: string; name: string }>;

  // Provider lookups
  agentToProviderMap: Map<string, string>;
  agentToProviderIdMap: Map<string, string>;
  getProviderForAgent: (agentId: string | null | undefined) => string | null;
  getProviderIdForAgent: (agentId: string) => string | null;

  // Preflight
  preflightResult: PreflightResult | undefined;
  refetchPreflight: () => Promise<QueryObserverResult<PreflightResult | undefined, Error>>;

  // Threads
  userThreads: Thread[];
  agentThreads: Thread[];
  allThreads: Thread[];
  userThreadsLoading: boolean;
  agentThreadsLoading: boolean;

  // Messages
  messages: Message[];
  refetchMessages: () => Promise<unknown>;

  // Mutations
  createGroupMutation: ReturnType<
    typeof useMutation<Thread, Error, { agentIds: string[]; title?: string }>
  >;
  inviteMembersMutation: ReturnType<
    typeof useMutation<
      Thread,
      Error,
      { threadId: string; agentIds: string[]; inviterName?: string }
    >
  >;
  clearHistoryMutation: ReturnType<typeof useMutation<Thread, Error, string>>;
  purgeHistoryMutation: ReturnType<typeof useMutation<Thread, Error, string>>;
  sendMessageMutation: ReturnType<
    typeof useMutation<Message, Error, { threadId: string; content: string; targets?: string[] }>
  >;
}

// ============================================
// Query Keys
// ============================================

export const chatQueryKeys = {
  agentPresence: (projectId: string | null) => ['agent-presence', projectId] as const,
  activeSessions: (projectId: string | null) => ['active-sessions', projectId] as const,
  agents: (projectId: string | null) => ['agents', projectId] as const,
  profiles: (projectId: string | null) => ['profiles', projectId] as const,
  providers: () => ['providers'] as const,
  preflight: (rootPath?: string) => ['preflight', 'chat-page', rootPath ?? 'global'] as const,
  userThreads: (projectId: string | null) => ['threads', projectId, 'user'] as const,
  agentThreads: (projectId: string | null) => ['threads', projectId, 'agent'] as const,
  messages: (threadId: string | null, projectId: string | null) =>
    ['messages', threadId, projectId] as const,
};

// ============================================
// Hook
// ============================================

export function useChatQueries({
  projectId,
  selectedThreadId,
  projectRootPath,
}: UseChatQueriesOptions): UseChatQueriesResult {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const hasSelectedProject = Boolean(projectId);

  // Agent presence query
  const { data: agentPresence = {}, isLoading: agentPresenceLoading } = useQuery({
    queryKey: chatQueryKeys.agentPresence(projectId),
    queryFn: () => fetchAgentPresence(projectId!),
    enabled: hasSelectedProject,
    refetchInterval: 10000,
  });

  // Active sessions query
  const { data: activeSessions = [] } = useQuery({
    queryKey: chatQueryKeys.activeSessions(projectId),
    queryFn: () => fetchActiveSessions(projectId!),
    enabled: hasSelectedProject,
    refetchInterval: 10000,
  });

  // Agents query
  const {
    data: agentsResponse = [],
    isLoading: agentsLoading,
    isError: agentsError,
  } = useQuery({
    queryKey: chatQueryKeys.agents(projectId),
    queryFn: async () => {
      const response = await fetch(`/api/agents?projectId=${projectId}&includeGuests=true`);
      if (!response.ok) {
        throw new Error('Failed to fetch agents');
      }
      return response.json();
    },
    enabled: hasSelectedProject,
  });

  // Profiles query
  const { data: profilesResponse = [] } = useQuery({
    queryKey: chatQueryKeys.profiles(projectId),
    queryFn: async () => {
      const response = await fetch(`/api/profiles?projectId=${encodeURIComponent(projectId!)}`);
      if (!response.ok) {
        throw new Error('Failed to fetch profiles');
      }
      return response.json();
    },
    enabled: hasSelectedProject,
  });

  // Providers query
  const { data: providersResponse = [] } = useQuery({
    queryKey: chatQueryKeys.providers(),
    queryFn: async () => {
      const response = await fetch('/api/providers');
      if (!response.ok) {
        throw new Error('Failed to fetch providers');
      }
      return response.json();
    },
  });

  // Preflight query
  const { data: preflightResult, refetch: refetchPreflight } = useQuery({
    queryKey: chatQueryKeys.preflight(projectRootPath),
    queryFn: () => fetchPreflightChecks(projectRootPath),
    staleTime: 30000,
    refetchInterval: 60000,
  });

  // User threads query
  const { data: userThreadsData, isLoading: userThreadsLoading } = useQuery({
    queryKey: chatQueryKeys.userThreads(projectId),
    queryFn: () => fetchThreads(projectId!, 'user'),
    enabled: hasSelectedProject,
  });

  // Agent threads query
  const { data: agentThreadsData, isLoading: agentThreadsLoading } = useQuery({
    queryKey: chatQueryKeys.agentThreads(projectId),
    queryFn: () => fetchThreads(projectId!, 'agent'),
    enabled: hasSelectedProject,
  });

  // Messages query
  const { data: messagesData, refetch: refetchMessages } = useQuery({
    queryKey: chatQueryKeys.messages(selectedThreadId, projectId),
    queryFn: () => fetchMessages(selectedThreadId!, projectId!),
    enabled: Boolean(selectedThreadId && projectId),
  });

  // ============================================
  // Mutations
  // ============================================

  const createGroupMutation = useMutation({
    mutationFn: ({ agentIds, title }: { agentIds: string[]; title?: string }) => {
      if (!projectId) {
        throw new Error('Select a project before creating a group.');
      }
      return createGroupThread({ projectId, agentIds, title });
    },
    onSuccess: () => {
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.userThreads(projectId) });
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentThreads(projectId) });
      }
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to create group',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const inviteMembersMutation = useMutation({
    mutationFn: ({
      threadId,
      agentIds,
      inviterName,
    }: {
      threadId: string;
      agentIds: string[];
      inviterName?: string;
    }) => inviteMembers(threadId, { agentIds, inviterName, projectId: projectId! }),
    onSuccess: () => {
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.userThreads(projectId) });
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentThreads(projectId) });
      }
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to invite agents',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const clearHistoryMutation = useMutation({
    mutationFn: (threadId: string) => clearHistory(threadId, { announce: true }),
    onSuccess: () => {
      if (projectId && selectedThreadId) {
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.messages(selectedThreadId, projectId),
        });
      }
      toast({
        title: 'History cleared',
        description: 'Messages before this point have been hidden.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to clear history',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const purgeHistoryMutation = useMutation({
    mutationFn: (threadId: string) => purgeHistory(threadId, { announce: true }),
    onSuccess: () => {
      if (projectId && selectedThreadId) {
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.messages(selectedThreadId, projectId),
        });
      }
      toast({
        title: 'History purged',
        description: 'Older messages have been permanently removed.',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to purge history',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: ({
      threadId,
      content,
      targets,
    }: {
      threadId: string;
      content: string;
      targets?: string[];
    }) =>
      createMessage(threadId, {
        content,
        authorType: 'user',
        projectId: projectId!,
        targets,
      }),
    onSuccess: () => {
      if (projectId) {
        queryClient.invalidateQueries({
          queryKey: chatQueryKeys.messages(selectedThreadId, projectId),
        });
      }
    },
    onError: (error: Error) => {
      toast({
        title: 'Failed to send message',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  // ============================================
  // Derived Data
  // ============================================

  // Normalize agents response
  const allAgentsAndGuests: AgentOrGuest[] = (() => {
    if (Array.isArray(agentsResponse)) {
      return agentsResponse;
    }
    if (agentsResponse && Array.isArray((agentsResponse as { items?: unknown[] }).items)) {
      return (agentsResponse as { items: AgentOrGuest[] }).items;
    }
    return [];
  })();

  const agents = allAgentsAndGuests.filter((item) => item.type !== 'guest');
  const guests = allAgentsAndGuests.filter((item) => item.type === 'guest');

  // Normalize profiles response
  const profiles: Array<{ id: string; providerId: string }> = (() => {
    if (Array.isArray(profilesResponse)) {
      return profilesResponse as Array<{ id: string; providerId: string }>;
    }
    if (profilesResponse && Array.isArray((profilesResponse as { items?: unknown[] }).items)) {
      return (profilesResponse as { items: Array<{ id: string; providerId: string }> }).items;
    }
    return [];
  })();

  // Normalize providers response
  const providers: Array<{ id: string; name: string }> = (() => {
    if (Array.isArray(providersResponse)) {
      return providersResponse as Array<{ id: string; name: string }>;
    }
    if (providersResponse && Array.isArray((providersResponse as { items?: unknown[] }).items)) {
      return (providersResponse as { items: Array<{ id: string; name: string }> }).items;
    }
    return [];
  })();

  // Build agent → provider lookup maps
  const agentToProviderMap = new Map<string, string>();
  const agentToProviderIdMap = new Map<string, string>();
  const profileMap = new Map(profiles.map((p) => [p.id, p.providerId]));
  const providerMap = new Map(providers.map((p) => [p.id, p.name]));

  for (const agent of agents as Array<{ id: string; profileId?: string }>) {
    if (agent.profileId) {
      const providerId = profileMap.get(agent.profileId);
      if (providerId) {
        agentToProviderIdMap.set(agent.id, providerId);
        const providerName = providerMap.get(providerId);
        if (providerName) {
          agentToProviderMap.set(agent.id, providerName);
        }
      }
    }
  }

  const getProviderForAgent = (agentId: string | null | undefined): string | null => {
    if (!agentId) return null;
    return agentToProviderMap.get(agentId) ?? null;
  };

  const getProviderIdForAgent = (agentId: string): string | null => {
    return agentToProviderIdMap.get(agentId) ?? null;
  };

  // Normalize threads
  const userThreads: Thread[] = userThreadsData?.items ?? [];
  const agentThreads: Thread[] = agentThreadsData?.items ?? [];
  const allThreads = [...userThreads, ...agentThreads];

  // Normalize messages
  const messages: Message[] = messagesData?.items ?? [];

  return {
    // Agent presence
    agentPresence,
    agentPresenceLoading,
    presenceReady: !agentPresenceLoading,

    // Active sessions
    activeSessions,

    // Agents and guests
    agents,
    guests,
    allAgentsAndGuests,
    agentsLoading,
    agentsError,

    // Profiles and providers
    profiles,
    providers,

    // Provider lookups
    agentToProviderMap,
    agentToProviderIdMap,
    getProviderForAgent,
    getProviderIdForAgent,

    // Preflight
    preflightResult,
    refetchPreflight,

    // Threads
    userThreads,
    agentThreads,
    allThreads,
    userThreadsLoading,
    agentThreadsLoading,

    // Messages
    messages,
    refetchMessages,

    // Mutations
    createGroupMutation,
    inviteMembersMutation,
    clearHistoryMutation,
    purgeHistoryMutation,
    sendMessageMutation,
  };
}
