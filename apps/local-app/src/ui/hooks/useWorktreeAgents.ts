import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { listWorktrees, type WorktreeSummary } from '@/modules/orchestrator/ui/app/lib/worktrees';
import { fetchRuntimeInfo } from '@/ui/lib/runtime';
import type { AgentPresenceMap } from '@/ui/lib/sessions';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';
import { getWorktreeSocket, releaseWorktreeSocket, type WsEnvelope } from '@/ui/lib/socket';

export interface WorktreeAgentGroup {
  id: string;
  name: string;
  status: string;
  runtimeType: string;
  devchainProjectId: string | null;
  apiBase: string;
  agents: AgentOrGuest[];
  agentPresence: AgentPresenceMap;
  disabled: boolean;
  error: string | null;
}

interface AgentsApiResponse {
  items?: unknown;
}

function normalizeWorktreeStatus(status: string): string {
  return status.trim().toLowerCase();
}

function normalizeWorktreeRuntimeType(runtimeType: WorktreeSummary['runtimeType']): string {
  return String(runtimeType).trim().toLowerCase() === 'process' ? 'process' : 'container';
}

function getApiBaseForWorktree(worktreeName: string): string {
  return `/wt/${encodeURIComponent(worktreeName)}`;
}

function parseAgentsPayload(payload: unknown): AgentOrGuest[] {
  const rawItems = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as AgentsApiResponse).items)
      ? ((payload as AgentsApiResponse).items as unknown[])
      : [];

  const agents: AgentOrGuest[] = [];

  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      continue;
    }

    const item = rawItem as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    const name = typeof item.name === 'string' ? item.name : '';
    if (!id || !name) {
      continue;
    }

    const type: AgentOrGuest['type'] = item.type === 'guest' ? 'guest' : 'agent';
    if (type === 'guest') {
      continue;
    }

    const rawProviderConfig = item.providerConfig;
    let providerConfig: AgentOrGuest['providerConfig'] = null;
    if (
      rawProviderConfig &&
      typeof rawProviderConfig === 'object' &&
      !Array.isArray(rawProviderConfig)
    ) {
      const value = rawProviderConfig as Record<string, unknown>;
      const providerConfigId = typeof value.id === 'string' ? value.id : '';
      const providerConfigName = typeof value.name === 'string' ? value.name : '';
      const providerId = typeof value.providerId === 'string' ? value.providerId : '';
      if (providerConfigId && providerConfigName && providerId) {
        providerConfig = {
          id: providerConfigId,
          name: providerConfigName,
          providerId,
          providerName: typeof value.providerName === 'string' ? value.providerName : undefined,
          options:
            typeof value.options === 'string' || value.options === null ? value.options : undefined,
        };
      }
    }

    agents.push({
      id,
      name,
      profileId: typeof item.profileId === 'string' ? item.profileId : null,
      description: typeof item.description === 'string' ? item.description : null,
      type,
      tmuxSessionId: typeof item.tmuxSessionId === 'string' ? item.tmuxSessionId : undefined,
      providerConfigId: typeof item.providerConfigId === 'string' ? item.providerConfigId : null,
      providerConfig,
    });
  }

  return agents;
}

function parsePresencePayload(payload: unknown): AgentPresenceMap {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }

  return payload as AgentPresenceMap;
}

function isWorktreeGroupEnabled(worktree: WorktreeSummary): boolean {
  const status = normalizeWorktreeStatus(String(worktree.status));
  return (
    status === 'running' &&
    typeof worktree.devchainProjectId === 'string' &&
    worktree.devchainProjectId.trim().length > 0 &&
    typeof worktree.containerPort === 'number' &&
    worktree.containerPort > 0
  );
}

async function fetchWorktreeAgentGroup(worktree: WorktreeSummary): Promise<WorktreeAgentGroup> {
  const apiBase = getApiBaseForWorktree(worktree.name);
  const status = normalizeWorktreeStatus(String(worktree.status));
  const runtimeType = normalizeWorktreeRuntimeType(worktree.runtimeType);
  const projectId =
    typeof worktree.devchainProjectId === 'string' && worktree.devchainProjectId.trim().length > 0
      ? worktree.devchainProjectId
      : null;

  if (!isWorktreeGroupEnabled(worktree) || !projectId) {
    return {
      id: worktree.id,
      name: worktree.name,
      status,
      runtimeType,
      devchainProjectId: projectId,
      apiBase,
      agents: [],
      agentPresence: {},
      disabled: true,
      error: null,
    };
  }

  const [agentsResult, presenceResult] = await Promise.allSettled([
    fetch(`${apiBase}/api/agents?projectId=${encodeURIComponent(projectId)}&includeGuests=true`, {
      headers: { accept: 'application/json' },
    }),
    fetch(`${apiBase}/api/sessions/agents/presence?projectId=${encodeURIComponent(projectId)}`, {
      headers: { accept: 'application/json' },
    }),
  ]);

  if (agentsResult.status === 'rejected') {
    return {
      id: worktree.id,
      name: worktree.name,
      status,
      runtimeType,
      devchainProjectId: projectId,
      apiBase,
      agents: [],
      agentPresence: {},
      disabled: true,
      error: 'Failed to load agents',
    };
  }

  if (!agentsResult.value.ok) {
    return {
      id: worktree.id,
      name: worktree.name,
      status,
      runtimeType,
      devchainProjectId: projectId,
      apiBase,
      agents: [],
      agentPresence: {},
      disabled: true,
      error: `Failed to load agents: HTTP ${agentsResult.value.status}`,
    };
  }

  const agentsPayload = await agentsResult.value.json().catch(() => null);
  const agents = parseAgentsPayload(agentsPayload);

  let agentPresence: AgentPresenceMap = {};
  if (presenceResult.status === 'fulfilled' && presenceResult.value.ok) {
    const presencePayload = await presenceResult.value.json().catch(() => null);
    agentPresence = parsePresencePayload(presencePayload);
  }

  return {
    id: worktree.id,
    name: worktree.name,
    status,
    runtimeType,
    devchainProjectId: projectId,
    apiBase,
    agents,
    agentPresence,
    disabled: false,
    error: null,
  };
}

export function useWorktreeAgents(ownerProjectId?: string | null) {
  const queryClient = useQueryClient();

  const { data: runtimeInfo } = useQuery({
    queryKey: ['runtime-info'],
    queryFn: fetchRuntimeInfo,
    staleTime: Infinity,
  });
  const isMainMode = runtimeInfo?.mode === 'main';
  const scopedOwnerProjectId = ownerProjectId?.trim() || null;

  const { data: worktreeGroups = [], isLoading: worktreeAgentGroupsLoading } = useQuery({
    queryKey: ['chat-worktree-agent-groups', scopedOwnerProjectId],
    enabled: isMainMode,
    queryFn: async (): Promise<WorktreeAgentGroup[]> => {
      const worktrees = scopedOwnerProjectId
        ? await listWorktrees({ ownerProjectId: scopedOwnerProjectId })
        : await listWorktrees();
      const groups = await Promise.allSettled(
        worktrees.map((worktree) => fetchWorktreeAgentGroup(worktree)),
      );

      return groups
        .map((result) => (result.status === 'fulfilled' ? result.value : null))
        .filter((group): group is WorktreeAgentGroup => Boolean(group))
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    staleTime: 60_000,
    refetchInterval: 30_000,
  });

  // Per-worktree presence socket tracking
  const socketTracker = useRef<
    Map<string, { socket: Socket; handler: (envelope: WsEnvelope) => void }>
  >(new Map());

  const debouncedInvalidate = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const invoke = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['chat-worktree-agent-groups'] });
      }, 500);
    };
    invoke.cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    return invoke;
  }, [queryClient]);

  // Incremental connect/disconnect — no cleanup return so sockets survive
  // across worktreeGroups refetches triggered by presence events.
  useEffect(() => {
    if (!isMainMode) {
      // Leaving main mode: release all tracked sockets and cancel pending debounce
      debouncedInvalidate.cancel();
      for (const [name, entry] of socketTracker.current) {
        entry.socket.off('message', entry.handler);
        releaseWorktreeSocket(name);
      }
      socketTracker.current.clear();
      return;
    }

    const activeNames = new Set(
      worktreeGroups
        .filter((group) => !group.disabled && group.status === 'running')
        .map((group) => group.name),
    );

    // Connect to new running worktrees
    for (const name of activeNames) {
      if (!socketTracker.current.has(name)) {
        const socket = getWorktreeSocket(name);
        const handler = (envelope: WsEnvelope) => {
          if (
            (envelope.topic.startsWith('agent/') && envelope.type === 'presence') ||
            (envelope.topic.startsWith('session/') && envelope.type === 'activity')
          ) {
            debouncedInvalidate();
          }
        };
        socket.on('message', handler);
        socketTracker.current.set(name, { socket, handler });
      }
    }

    // Disconnect from stopped/removed worktrees only
    for (const [name, entry] of socketTracker.current) {
      if (!activeNames.has(name)) {
        entry.socket.off('message', entry.handler);
        releaseWorktreeSocket(name);
        socketTracker.current.delete(name);
      }
    }
  }, [isMainMode, worktreeGroups, debouncedInvalidate]);

  // Unmount-only cleanup: release all tracked sockets and cancel pending debounce
  useEffect(() => {
    return () => {
      debouncedInvalidate.cancel();
      for (const [name, entry] of socketTracker.current) {
        entry.socket.off('message', entry.handler);
        releaseWorktreeSocket(name);
      }
      socketTracker.current.clear();
    };
  }, [debouncedInvalidate]);

  return useMemo(
    () => ({
      worktreeAgentGroups: worktreeGroups,
      worktreeAgentGroupsLoading,
    }),
    [worktreeGroups, worktreeAgentGroupsLoading],
  );
}
