import { useQuery, type QueryObserverResult } from '@tanstack/react-query';
import { profileQueries, type ProfileListItem } from '@/ui/lib/profiles';
import { agentQueries, type AgentOrGuestItem as AgentOrGuest } from '@/ui/lib/agents';
import {
  fetchAgentPresence,
  fetchActiveSessions,
  type ActiveSession,
  type AgentPresenceMap,
} from '@/ui/lib/sessions';
import { fetchPreflightChecks, type PreflightResult } from '@/ui/lib/preflight';
import { providersQueryKeys } from '@/ui/lib/providers-query-keys';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { compareCanonicalAgents } from '@/ui/lib/agent-ordering';

// ============================================
// Types
// ============================================

export type { AgentOrGuestItem as AgentOrGuest } from '@/ui/lib/agents';

export interface PendingLaunchAgent {
  agentId: string;
  providerId: string;
  providerName: string;
  options: { attach?: boolean; silent?: boolean };
}

export interface UseChatQueriesOptions {
  projectId: string | null;
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
  agentsQuerySuccess: boolean;

  // Profiles and providers
  profiles: ProfileListItem[];
  providers: Array<{ id: string; name: string }>;

  // Provider lookups
  agentToProviderMap: Map<string, string>;
  agentToProviderIdMap: Map<string, string>;
  getProviderForAgent: (agentId: string | null | undefined) => string | null;
  getProviderIdForAgent: (agentId: string) => string | null;

  // Preflight
  preflightResult: PreflightResult | undefined;
  refetchPreflight: () => Promise<QueryObserverResult<PreflightResult | undefined, Error>>;
}

// ============================================
// Query Keys
// ============================================

export const chatQueryKeys = {
  agentPresence: (projectId: string | null) => ['agent-presence', projectId] as const,
  activeSessions: (projectId: string | null) => ['active-sessions', projectId] as const,
  providers: () => providersQueryKeys.list(),
  preflight: (rootPath?: string) => ['preflight', 'chat-page', rootPath ?? 'global'] as const,
};

// ============================================
// Hook
// ============================================

export function useChatQueries({
  projectId,
  projectRootPath,
}: UseChatQueriesOptions): UseChatQueriesResult {
  const apiFetch = useFetchFactory();
  const hasSelectedProject = Boolean(projectId);

  // Agent presence query
  const { data: agentPresence = {}, isLoading: agentPresenceLoading } = useQuery({
    queryKey: chatQueryKeys.agentPresence(projectId),
    queryFn: () => fetchAgentPresence(projectId!, apiFetch),
    enabled: hasSelectedProject,
    refetchInterval: 10000,
  });

  // Active sessions query
  const { data: activeSessions = [] } = useQuery({
    queryKey: chatQueryKeys.activeSessions(projectId),
    queryFn: () => fetchActiveSessions(projectId!, apiFetch),
    enabled: hasSelectedProject,
    refetchInterval: 10000,
  });

  // Agents query
  const {
    data: agentsResponse,
    isLoading: agentsLoading,
    isError: agentsError,
    isSuccess: agentsQuerySuccess,
  } = useQuery({
    ...agentQueries.withGuests(apiFetch, projectId),
    enabled: hasSelectedProject,
  });

  // Profiles query
  const { data: profilesResponse = [] } = useQuery({
    ...profileQueries.list(apiFetch, projectId),
    enabled: hasSelectedProject,
  });

  // Providers query
  const { data: providersResponse = [] } = useQuery({
    queryKey: chatQueryKeys.providers(),
    queryFn: async () => {
      const response = await apiFetch('/api/providers');
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

  // ============================================
  // Derived Data
  // ============================================

  const allAgentsAndGuests = agentsResponse?.items ?? [];

  const agents = allAgentsAndGuests
    .filter((item) => item.type !== 'guest')
    .sort(compareCanonicalAgents);
  const guests = allAgentsAndGuests
    .filter((item) => item.type === 'guest')
    .sort(compareCanonicalAgents);

  const profiles: ProfileListItem[] = Array.isArray(profilesResponse)
    ? profilesResponse
    : (profilesResponse?.items ?? []);

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
  // Uses agent.providerConfig.providerId first (from providerConfigId), falls back to profile.providerId
  const agentToProviderMap = new Map<string, string>();
  const agentToProviderIdMap = new Map<string, string>();
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile.provider?.id]));
  const providerMap = new Map(providers.map((p) => [p.id, p.name]));

  for (const agent of agents) {
    // Try providerConfig.providerId first (new model)
    let providerId = agent.providerConfig?.providerId;

    // Fall back to profile.providerId (legacy)
    if (!providerId && agent.profileId) {
      providerId = profileMap.get(agent.profileId);
    }

    if (providerId) {
      agentToProviderIdMap.set(agent.id, providerId);
      const providerName = providerMap.get(providerId);
      if (providerName) {
        agentToProviderMap.set(agent.id, providerName);
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
    agentsQuerySuccess,

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
  };
}
