import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle, MessageSquare } from 'lucide-react';
import { validatePresetAvailability, type PresetAvailability } from '@/ui/lib/preset-validation';
import type { Preset } from '@/ui/lib/preset-types';
import { restartKeyForMain, restartKeyForWorktree } from '@/ui/lib/restart-keys';
import {
  useTerminalWindowManager,
  useTerminalWindows,
  useWorktreeTerminalWindowManager,
} from '@/ui/terminal-windows';
import { parseMentions } from '@/ui/lib/chat';
import { useChatLauncher } from '@/ui/components/chat/ChatLauncher';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { usePointerCoarse } from '@/ui/hooks/usePointerCoarse';
import { useWorktreeAgents, type WorktreeAgentGroup } from '@/ui/hooks/useWorktreeAgents';
import { useWorktreeSocket } from '@/ui/hooks/useWorktreeSocket';
import {
  launchSession,
  restartSession,
  terminateSession,
  SessionApiError,
} from '@/ui/lib/sessions';

// Inline terminal components
import { InlineTerminalPanel } from '@/ui/components/chat/InlineTerminalPanel';
import {
  InlineTerminalHeader,
  type InlineTerminalTab,
} from '@/ui/components/chat/InlineTerminalHeader';
import { Button } from '@/ui/components/ui/button';

// Session reader
import { useSessionTranscript } from '@/ui/hooks/useSessionTranscript';
import { SessionViewerPanel } from '@/ui/components/session-reader/SessionViewerPanel';

// Extracted hooks
import { useChatQueries, chatQueryKeys } from '@/ui/hooks/useChatQueries';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';
import { teamsQueryKeys, updateTeam } from '@/ui/lib/teams';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { Slider } from '@/ui/components/ui/slider';
import { Label } from '@/ui/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { useChatSocket } from '@/ui/hooks/useChatSocket';
import { useChatSessionControls } from '@/ui/hooks/useChatSessionControls';
import { useChatThreadUiState } from '@/ui/hooks/useChatThreadUiState';

// Extracted components
import { ChatSidebar } from '@/ui/components/chat/ChatSidebar';
import { ChatThreadHeader } from '@/ui/components/chat/ChatThreadHeader';
import { ChatMessageList } from '@/ui/components/chat/ChatMessageList';
import { ChatComposer } from '@/ui/components/chat/ChatComposer';
import { ChatModals } from '@/ui/components/chat/ChatModals';

// Feature flags
const CHAT_INLINE_TERMINAL_ENABLED = true;

/** Create a worktree-aware fetch function for provider configs. */
export function createWorktreeProviderConfigFetcher(
  apiBase: string,
): (profileId: string) => Promise<Array<{ id: string; name: string; providerId: string }>> {
  return async (profileId) => {
    const res = await fetch(`${apiBase}/api/profiles/${profileId}/provider-configs`);
    if (!res.ok) throw new Error('Failed to fetch provider configs');
    return res.json();
  };
}

interface ProviderConfig {
  id: string;
  name: string;
  profileId: string;
  providerId: string;
}

interface ApplyPresetResult {
  applied: number;
  warnings: string[];
  agents: Array<{
    id: string;
    name: string;
    providerConfigId?: string | null;
  }>;
}

interface SelectedWorktreeAgent {
  worktreeName: string;
  agentId: string;
  group: WorktreeAgentGroup;
}

interface WorktreeInlineTerminalProps {
  worktreeName: string;
  sessionId: string;
  agentName: string | null;
  isWindowOpen: boolean;
  windowId?: string | null;
}

type WorktreeSessionAction = 'launching' | 'restarting' | 'terminating';

function WorktreeInlineTerminal({
  worktreeName,
  sessionId,
  agentName,
  isWindowOpen,
  windowId,
}: WorktreeInlineTerminalProps) {
  const { socket } = useWorktreeSocket(worktreeName);

  return (
    <InlineTerminalPanel
      sessionId={sessionId}
      socket={socket}
      agentName={agentName}
      isWindowOpen={isWindowOpen}
      windowId={windowId}
    />
  );
}

async function fetchPresets(
  projectId: string,
): Promise<{ presets: Preset[]; activePreset: string | null }> {
  const res = await fetch(`/api/projects/${projectId}/presets`);
  if (!res.ok) throw new Error('Failed to fetch presets');
  return res.json();
}

async function applyPreset(projectId: string, presetName: string): Promise<ApplyPresetResult> {
  const res = await fetch(`/api/projects/${projectId}/presets/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetName }),
  });
  if (!res.ok) throw new Error('Failed to apply preset');
  return res.json();
}

export function ChatPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { selectedProjectId, selectedProject, projectsLoading } = useSelectedProject();
  const projectId = selectedProjectId ?? null;
  const hasSelectedProject = Boolean(projectId);
  const isCoarsePointer = usePointerCoarse();
  const openTerminalWindow = useTerminalWindowManager();
  const openWorktreeTerminalWindow = useWorktreeTerminalWindowManager();
  const { windows: terminalWindows, closeWindow, focusedWindowId } = useTerminalWindows();

  // Derive selectedThreadId from URL params FIRST (before hooks that depend on it)
  const [searchParams] = useSearchParams();
  const selectedThreadIdFromUrl = searchParams.get('thread');

  // Tick for relative durations (busy badge)
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => (n + 1) % 1000000), 1000);
    return () => clearInterval(id);
  }, []);

  // Chat launcher for direct thread creation
  const { launchChat, isLaunching: isLaunchingChat } = useChatLauncher({
    projectId,
  });
  const { worktreeAgentGroups, worktreeAgentGroupsLoading } = useWorktreeAgents(projectId);
  const [selectedWorktreeAgent, setSelectedWorktreeAgent] = useState<SelectedWorktreeAgent | null>(
    null,
  );
  const [worktreeSessionActionsByAgentKey, setWorktreeSessionActionsByAgentKey] = useState<
    Record<string, WorktreeSessionAction | undefined>
  >({});

  // ============================================
  // Initialize Hooks
  // ============================================

  // Queries and mutations (use URL-derived selectedThreadId)
  const queries = useChatQueries({
    projectId,
    selectedThreadId: selectedThreadIdFromUrl,
    projectRootPath: selectedProject?.rootPath,
  });

  // Thread UI state - called ONCE with real data
  const threadUiState = useChatThreadUiState({
    projectId,
    agentPresence: queries.agentPresence,
    allThreads: queries.allThreads,
    agents: queries.agents,
  });

  // Inline terminal attach handler
  const handleInlineTerminalAttach = useCallback(
    (agentId: string, sessionId: string | null) => {
      threadUiState.attachInlineTerminalForSelectedThread(agentId, sessionId);
    },
    [threadUiState],
  );

  // Caller-side predicate for useChatSessionControls
  const canAttachInlineTerminal = useCallback(
    (agentId: string): boolean => {
      const threadId = threadUiState.selectedThreadId;
      if (!threadId) return false;
      const thread = queries.allThreads.find((t) => t.id === threadId);
      return Boolean(thread && !thread.isGroup && thread.members?.[0] === agentId);
    },
    [threadUiState.selectedThreadId, queries.allThreads],
  );

  // Session controls
  const sessionControls = useChatSessionControls({
    projectId,
    selectedThreadId: threadUiState.selectedThreadId,
    agentPresence: queries.agentPresence,
    agents: queries.agents,
    presenceReady: queries.presenceReady,
    canAttachInlineTerminal,
    onInlineTerminalAttach: handleInlineTerminalAttach,
    onTerminalMenuClose: () => threadUiState.setTerminalMenuOpen(false),
  });

  // ============================================
  // Pending Restart State Management
  // ============================================

  const [pendingRestartAgentIds, setPendingRestartAgentIds] = useState<Set<string>>(new Set());

  // Helper to add composite restart keys to pending set
  const markAgentsForRestart = useCallback((keys: string[]) => {
    setPendingRestartAgentIds((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
  }, []);

  // Helper to clear a single composite restart key from pending set
  const clearPendingRestart = useCallback((key: string) => {
    setPendingRestartAgentIds((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  // Helper to clear all pending restart state
  const clearAllPendingRestarts = useCallback(() => {
    setPendingRestartAgentIds(new Set());
  }, []);

  // Wrapped session handlers that clear pending restart state
  const handleRestartSessionWithClear = useCallback(
    async (agentId: string) => {
      await sessionControls.handleRestartSession(agentId);
      clearPendingRestart(restartKeyForMain(agentId));
    },
    [sessionControls.handleRestartSession, clearPendingRestart],
  );

  const handleTerminateSessionWithClear = useCallback(
    async (agentId: string, sessionId: string) => {
      await sessionControls.handleTerminateSession(agentId, sessionId);
      clearPendingRestart(restartKeyForMain(agentId));
    },
    [sessionControls.handleTerminateSession, clearPendingRestart],
  );

  const handleTerminateAllAgentsWithClear = useCallback(async () => {
    await sessionControls.handleTerminateAllAgents();
    clearAllPendingRestarts();
  }, [sessionControls.handleTerminateAllAgents, clearAllPendingRestarts]);

  // ============================================
  // Preset Query & Mutation
  // ============================================

  // Fetch presets for this project
  const { data: presetsData } = useQuery<{ presets: Preset[]; activePreset: string | null }>({
    queryKey: ['project-presets', projectId],
    queryFn: () => fetchPresets(projectId!),
    enabled: hasSelectedProject,
  });
  const presets = presetsData?.presets ?? [];
  const activePreset = presetsData?.activePreset ?? null;

  // Filter agents with valid profileIds for preset validation
  const agentsWithProfiles = useMemo(
    () =>
      queries.agents.filter(
        (a): a is typeof a & { profileId: string } => typeof a.profileId === 'string',
      ),
    [queries.agents],
  );

  // Fetch provider configs for all agent profiles (for preset validation)
  const { data: configsMap } = useQuery<Map<string, ProviderConfig[]>>({
    queryKey: [
      'provider-configs-by-profile',
      projectId,
      agentsWithProfiles.map((a) => a.profileId),
    ],
    queryFn: async () => {
      const profileIds = new Set(agentsWithProfiles.map((a) => a.profileId));
      if (profileIds.size === 0) return new Map();

      const results = await Promise.all(
        Array.from(profileIds).map(async (profileId) => {
          try {
            const res = await fetch(`/api/profiles/${profileId}/provider-configs`);
            if (!res.ok) return { profileId, configs: [] };
            const configs = await res.json();
            return { profileId, configs };
          } catch {
            return { profileId, configs: [] };
          }
        }),
      );

      const map = new Map<string, ProviderConfig[]>();
      results.forEach(({ profileId, configs }) => {
        map.set(profileId, configs);
      });
      return map;
    },
    enabled: hasSelectedProject && agentsWithProfiles.length > 0,
  });

  // Validate presets and sort (available first, then by update time within each group)
  const validatedPresets = useMemo((): PresetAvailability[] => {
    if (!configsMap || presets.length === 0) return [];
    // Track original index to preserve storage order (which represents update time)
    const validated = presets.map((p, index) => ({
      ...validatePresetAvailability(p, agentsWithProfiles, configsMap),
      originalIndex: index,
    }));
    return validated.sort((a, b) => {
      if (a.available && !b.available) return -1;
      if (!a.available && b.available) return 1;
      // Within same availability, most recently updated first
      return b.originalIndex - a.originalIndex;
    });
  }, [presets, agentsWithProfiles, configsMap]);

  // Apply preset mutation with affected agent detection
  const applyPresetMutation = useMutation({
    mutationFn: ({ presetName }: { presetName: string }) => applyPreset(projectId!, presetName),
    onSuccess: (result) => {
      // Build map of agentId -> providerConfigId (using stable IDs, not names)
      const currentConfigMap = new Map(queries.agents.map((a) => [a.id, a.providerConfigId]));

      // Find agents whose providerConfigId changed (compare by agent.id)
      const affectedAgentIds: string[] = [];
      for (const updatedAgent of result.agents) {
        const oldConfigId = currentConfigMap.get(updatedAgent.id);
        if (oldConfigId !== updatedAgent.providerConfigId) {
          affectedAgentIds.push(updatedAgent.id);
        }
      }

      // Only mark online agents for restart (offline agents will use new config on next launch)
      const onlineAgentIds = affectedAgentIds.filter(
        (id) => queries.agentPresence[id]?.online === true,
      );
      if (onlineAgentIds.length > 0) {
        markAgentsForRestart(onlineAgentIds.map(restartKeyForMain));
      }

      queryClient.invalidateQueries({ queryKey: ['agents', projectId] });

      toast({
        title: 'Preset applied',
        description: `${result.applied} agent(s) updated. Restart sessions to apply.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to apply preset',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  // Handle preset apply with active sessions confirmation
  const handleApplyPreset = useCallback(
    async (presetName: string) => {
      // Check if preset is available (all configs exist)
      const validated = validatedPresets.find((v) => v.preset.name === presetName);
      if (!validated?.available) {
        toast({
          title: 'Cannot apply preset',
          description: 'Some required provider configurations are missing.',
          variant: 'destructive',
        });
        return;
      }

      // Find agents that would be affected by this preset
      const preset = presets.find((p) => p.name === presetName);
      if (!preset) return;

      // Build set of agent names in preset (lowercase for matching)
      const agentNamesInPreset = new Set(
        preset.agentConfigs.map((ac) => ac.agentName.trim().toLowerCase()),
      );

      // Check for active sessions among affected agents
      const agentsWithActiveSessions = queries.agents.filter(
        (a) =>
          agentNamesInPreset.has(a.name.trim().toLowerCase()) &&
          queries.agentPresence[a.id]?.online,
      );

      if (agentsWithActiveSessions.length > 0) {
        const agentNames = agentsWithActiveSessions.map((a) => a.name).join(', ');
        const confirmed = window.confirm(
          `The following agents have active sessions: ${agentNames}. ` +
            'Changing their provider configuration may affect running sessions. Continue?',
        );
        if (!confirmed) return;
      }

      applyPresetMutation.mutate({ presetName });
    },
    [presets, validatedPresets, queries.agents, queries.agentPresence, applyPresetMutation, toast],
  );

  // ============================================
  // Provider Config Switching
  // ============================================

  // Track which agent is being updated
  const [updatingConfigAgentId, setUpdatingConfigAgentId] = useState<string | null>(null);

  // Track which worktree agent is being updated (composite key: `${apiBase}:${agentId}`)
  const [updatingWorktreeConfigKey, setUpdatingWorktreeConfigKey] = useState<string | null>(null);

  // Update agent provider config mutation
  const updateAgentConfigMutation = useMutation({
    mutationFn: async ({
      agentId,
      providerConfigId,
      modelOverride,
    }: {
      agentId: string;
      providerConfigId: string;
      modelOverride?: string | null;
    }) => {
      const body: { providerConfigId: string; modelOverride?: string | null } = {
        providerConfigId,
      };
      if (modelOverride !== undefined) {
        body.modelOverride = modelOverride;
      }

      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to update agent config');
      return res.json();
    },
    onMutate: ({ agentId }) => {
      setUpdatingConfigAgentId(agentId);
    },
    onSuccess: (_, { agentId, modelOverride }) => {
      const isOnline = queries.agentPresence[agentId]?.online === true;
      const isModelOverrideUpdate = modelOverride !== undefined;

      // Mark for restart if agent has active session
      if (isOnline) {
        markAgentsForRestart([restartKeyForMain(agentId)]);
      }

      queryClient.invalidateQueries({ queryKey: ['agents', projectId] });
      toast({
        title: isModelOverrideUpdate ? 'Model override updated' : 'Config updated',
        description: isOnline ? 'Restart to apply changes.' : 'Will apply on next launch.',
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to update config',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setUpdatingConfigAgentId(null);
    },
  });

  // Handle switching provider config for an agent
  const handleSwitchConfig = useCallback(
    (agentId: string, providerConfigId: string, modelOverride?: string | null) => {
      updateAgentConfigMutation.mutate({ agentId, providerConfigId, modelOverride });
    },
    [updateAgentConfigMutation],
  );

  // Worktree agent provider config mutation
  const updateWorktreeAgentConfigMutation = useMutation({
    mutationFn: async ({
      apiBase,
      agentId,
      providerConfigId,
      modelOverride,
    }: {
      apiBase: string;
      agentId: string;
      providerConfigId: string;
      modelOverride?: string | null;
    }) => {
      const body: { providerConfigId: string; modelOverride?: string | null } = {
        providerConfigId,
      };
      if (modelOverride !== undefined) {
        body.modelOverride = modelOverride;
      }

      const res = await fetch(`${apiBase}/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to update agent config');
      return res.json();
    },
    onMutate: ({ apiBase, agentId }) => {
      setUpdatingWorktreeConfigKey(`${apiBase}:${agentId}`);
    },
    onSuccess: (_, { apiBase, agentId, modelOverride }) => {
      const group = worktreeAgentGroups.find((g) => g.apiBase === apiBase);
      const isOnline = group?.agentPresence[agentId]?.online === true;
      const isModelOverrideUpdate = modelOverride !== undefined;

      // Mark for restart if agent has active session
      if (isOnline) {
        markAgentsForRestart([restartKeyForWorktree(apiBase, agentId)]);
      }

      queryClient.invalidateQueries({ queryKey: ['chat-worktree-agent-groups'] });
      toast({
        title: isModelOverrideUpdate ? 'Model override updated' : 'Config updated',
        description: isOnline ? 'Restart to apply changes.' : 'Will apply on next launch.',
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to update config',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setUpdatingWorktreeConfigKey(null);
    },
  });

  // ── Clone agent ──
  const [pendingCloneAgent, setPendingCloneAgent] = useState<{
    agent: AgentOrGuest;
    teamId?: string;
    teamName?: string;
    isTeamLead?: boolean;
  } | null>(null);

  function computeCloneName(baseName: string): string {
    const existingNames = new Set(queries.agents.map((a) => a.name.toLowerCase()));
    for (let n = 1; ; n++) {
      const candidate = `${baseName} (${n})`;
      if (!existingNames.has(candidate.toLowerCase())) return candidate;
    }
  }

  const cloneAgentMutation = useMutation({
    mutationFn: async (payload: {
      projectId: string;
      profileId: string;
      name: string;
      description?: string | null;
      providerConfigId: string;
      modelOverride?: string | null;
      targetTeamId?: string | null;
    }) => {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: payload.projectId,
          profileId: payload.profileId,
          name: payload.name,
          description: payload.description,
          providerConfigId: payload.providerConfigId,
          modelOverride: payload.modelOverride,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? 'Failed to clone agent');
      }
      const created = await res.json();

      if (payload.targetTeamId) {
        try {
          const teamDetailRes = await fetch(`/api/teams/${payload.targetTeamId}`);
          if (!teamDetailRes.ok) {
            return { ...created, teamAddFailed: true };
          }
          const teamDetail = await teamDetailRes.json();
          const currentMemberIds = (teamDetail.members ?? []).map(
            (m: { agentId: string }) => m.agentId,
          );
          const putRes = await fetch(`/api/teams/${payload.targetTeamId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              memberAgentIds: [...currentMemberIds, created.id],
            }),
          });
          if (!putRes.ok) {
            return { ...created, teamAddFailed: true };
          }
        } catch {
          return { ...created, teamAddFailed: true };
        }
      }

      return created;
    },
    onSuccess: (result) => {
      const targetTeamName = cloneTargetTeam?.teamName;
      const sourceAgentName = pendingCloneAgent?.agent.name ?? '';
      setPendingCloneAgent(null);
      if (result?.teamAddFailed && targetTeamName) {
        toast({
          title: `Cloned ${pendingCloneName}`,
          description: `Couldn't add it to ${targetTeamName}. Add it manually via Teams page.`,
          variant: 'destructive',
        });
      } else if (targetTeamName) {
        toast({ title: `Cloned ${sourceAgentName} into ${targetTeamName}` });
      } else {
        toast({ title: 'Cloned agent' });
      }
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.agents(projectId) });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: teamsQueryKeys.teams(projectId) });
      }
      queryClient.invalidateQueries({ queryKey: ['teams', 'detail'] });
    },
    onError: (error) => {
      toast({
        title: 'Failed to clone agent',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const pendingCloneName = pendingCloneAgent ? computeCloneName(pendingCloneAgent.agent.name) : '';
  const cloneTargetTeam =
    pendingCloneAgent?.teamId && !pendingCloneAgent?.isTeamLead
      ? { teamId: pendingCloneAgent.teamId, teamName: pendingCloneAgent.teamName ?? '' }
      : null;

  function handleConfirmClone() {
    if (!pendingCloneAgent || !projectId) return;
    const src = pendingCloneAgent.agent;
    cloneAgentMutation.mutate({
      projectId,
      profileId: src.profileId ?? '',
      name: pendingCloneName,
      description: src.description ?? null,
      providerConfigId: src.providerConfigId ?? '',
      modelOverride: src.modelOverride ?? null,
      targetTeamId: cloneTargetTeam?.teamId ?? null,
    });
  }

  // ── Delete agent ──
  const [pendingDeleteAgent, setPendingDeleteAgent] = useState<AgentOrGuest | null>(null);
  const [pendingDeleteAgentId, setPendingDeleteAgentId] = useState<string | null>(null);

  const pendingDeleteHasSession = useMemo(() => {
    if (!pendingDeleteAgent) return false;
    return queries.activeSessions.some(
      (s) => s.agentId === pendingDeleteAgent.id && s.status === 'running',
    );
  }, [pendingDeleteAgent, queries.activeSessions]);

  const deleteAgentMutation = useMutation({
    mutationFn: async (agentId: string) => {
      const agentSessions = queries.activeSessions.filter(
        (s) => s.agentId === agentId && s.status === 'running',
      );
      if (agentSessions.length > 0) {
        await Promise.all(agentSessions.map((s) => terminateSession(s.id)));
      }
      const res = await fetch(`/api/agents/${agentId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          throw new Error("Can't delete — agent is currently running. Try again in a moment.");
        }
        throw new Error(body.message ?? 'Failed to delete agent');
      }
    },
    onMutate: (agentId) => {
      setPendingDeleteAgentId(agentId);
    },
    onSuccess: () => {
      setPendingDeleteAgent(null);
      toast({ title: 'Agent deleted' });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.agents(projectId) });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: teamsQueryKeys.teams(projectId) });
      }
      queryClient.invalidateQueries({ queryKey: ['teams', 'detail'] });
    },
    onError: (error) => {
      toast({
        title: 'Failed to delete agent',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setPendingDeleteAgentId(null);
    },
  });

  function handleConfirmDelete() {
    if (!pendingDeleteAgent) return;
    deleteAgentMutation.mutate(pendingDeleteAgent.id);
  }

  // ── Quick-add team agent ──
  const createTeamAgentMutation = useMutation({
    mutationFn: async (payload: {
      teamId: string;
      teamName: string;
      providerConfigId: string;
      name: string;
    }) => {
      const res = await fetch(`/api/teams/${payload.teamId}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerConfigId: payload.providerConfigId,
          name: payload.name,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? 'Failed to add agent');
      }
      return { agent: await res.json(), teamName: payload.teamName };
    },
    onSuccess: ({ agent, teamName }) => {
      toast({ title: `Added ${agent.name} to ${teamName}` });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.agents(projectId) });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: teamsQueryKeys.teams(projectId) });
      }
      queryClient.invalidateQueries({ queryKey: ['teams', 'detail'] });
    },
    onError: (error) => {
      toast({
        title: 'Failed to add agent',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  function handleAddTeamAgent(
    payload: import('@/ui/components/chat/TeamQuickAddButton').QuickAddPayload,
  ) {
    createTeamAgentMutation.mutate({
      teamId: payload.teamId,
      teamName: payload.teamName,
      providerConfigId: payload.providerConfigId,
      name: payload.computedName,
    });
  }

  // ── Quick-edit team modal ──
  const [quickEditTeam, setQuickEditTeam] = useState<{
    teamId: string;
    teamName: string;
    maxMembers: number;
    maxConcurrentTasks: number;
    allowTeamLeadCreateAgents: boolean;
  } | null>(null);
  const [qeMaxMembers, setQeMaxMembers] = useState(5);
  const [qeMaxConcurrentTasks, setQeMaxConcurrentTasks] = useState(5);
  const [qeAllowTeamLeadCreateAgents, setQeAllowTeamLeadCreateAgents] = useState(false);

  function handleOpenEditTeam(payload: {
    teamId: string;
    teamName: string;
    maxMembers: number;
    maxConcurrentTasks: number;
    allowTeamLeadCreateAgents: boolean;
  }) {
    setQuickEditTeam(payload);
    setQeMaxMembers(payload.maxMembers);
    setQeMaxConcurrentTasks(payload.maxConcurrentTasks);
    setQeAllowTeamLeadCreateAgents(payload.allowTeamLeadCreateAgents);
  }

  const quickEditTeamMutation = useMutation({
    mutationFn: (payload: {
      teamId: string;
      maxMembers: number;
      maxConcurrentTasks: number;
      allowTeamLeadCreateAgents: boolean;
    }) =>
      updateTeam(payload.teamId, {
        maxMembers: payload.maxMembers,
        maxConcurrentTasks: payload.maxConcurrentTasks,
        allowTeamLeadCreateAgents: payload.allowTeamLeadCreateAgents,
      }),
    onSuccess: () => {
      const teamName = quickEditTeam?.teamName ?? '';
      const teamId = quickEditTeam?.teamId;
      setQuickEditTeam(null);
      toast({ title: `Team '${teamName}' updated` });
      if (projectId) {
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.agents(projectId) });
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
        queryClient.invalidateQueries({ queryKey: teamsQueryKeys.teams(projectId) });
      }
      if (teamId) {
        queryClient.invalidateQueries({ queryKey: teamsQueryKeys.detail(teamId) });
      }
    },
    onError: (error) => {
      toast({
        title: 'Failed to update team',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  // Handle switching provider config for a worktree agent
  const handleSwitchWorktreeConfig = useCallback(
    (
      group: WorktreeAgentGroup,
      agentId: string,
      providerConfigId: string,
      modelOverride?: string | null,
    ) => {
      updateWorktreeAgentConfigMutation.mutate({
        apiBase: group.apiBase,
        agentId,
        providerConfigId,
        modelOverride,
      });
    },
    [updateWorktreeAgentConfigMutation],
  );

  // Helper to fetch provider configs for a profile (used by ChatSidebar)
  const fetchProviderConfigsForProfile = useCallback(
    async (profileId: string): Promise<Array<{ id: string; name: string; providerId: string }>> => {
      const res = await fetch(`/api/profiles/${profileId}/provider-configs`);
      if (!res.ok) throw new Error('Failed to fetch provider configs');
      return res.json();
    },
    [],
  );

  // Build updating config agent IDs record for ChatSidebar
  const updatingConfigAgentIds: Record<string, boolean> = useMemo(
    () => (updatingConfigAgentId ? { [updatingConfigAgentId]: true } : {}),
    [updatingConfigAgentId],
  );

  // Get latest selected thread ID for socket callbacks
  const getLatestSelectedThreadId = useCallback(
    () => threadUiState.latestSelectedThreadRef.current,
    [threadUiState.latestSelectedThreadRef],
  );

  // Check if inline terminal is active
  const inlineActiveRef = useRef(threadUiState.showInlineTerminal);
  useEffect(() => {
    inlineActiveRef.current = threadUiState.showInlineTerminal;
  }, [threadUiState.showInlineTerminal]);
  const isInlineActive = useCallback(() => inlineActiveRef.current, []);

  // Socket handling - capture socketRef for ESC key interception
  const { socketRef } = useChatSocket({
    projectId,
    selectedThreadId: threadUiState.selectedThreadId,
    agents: queries.agents,
    onInlineUnread: threadUiState.incrementInlineUnread,
    getLatestSelectedThreadId,
    isInlineActive,
  });

  // ============================================
  // Derived State
  // ============================================

  const {
    currentThread,
    currentThreadMembers,
    selectedAgent,
    threadDisplayName,
    isDirectMessage,
    inlineTerminalState,
    showInlineTerminal,
    inlineTerminalSessionId,
    inlineUnreadCount,
  } = threadUiState;

  const selectedAgentPresence = selectedAgent ? queries.agentPresence[selectedAgent.id] : undefined;
  const isSelectedAgentOnline = Boolean(selectedAgentPresence?.online);

  const offlineGroupMembers = useMemo(() => {
    if (!currentThread?.isGroup) return [];
    return currentThreadMembers.filter((member) => !member.online);
  }, [currentThread, currentThreadMembers]);

  const canInviteMembers = Boolean(
    currentThread && currentThread.isGroup && currentThread.createdByType === 'user',
  );

  const inviteableAgents = useMemo(() => {
    if (!currentThread?.members) {
      return queries.agents;
    }
    return queries.agents.filter((agent) => !currentThread.members!.includes(agent.id));
  }, [queries.agents, currentThread]);

  const inlineTerminalAgentName = inlineTerminalState
    ? (queries.agents.find((a) => a.id === inlineTerminalState.agentId)?.name ?? null)
    : null;
  const inlineTerminalAgentId = inlineTerminalState?.agentId ?? null;

  const isInlineSessionWindowOpen = useMemo(() => {
    if (!inlineTerminalSessionId) return false;
    return terminalWindows.some((w) => w.id === inlineTerminalSessionId && !w.minimized);
  }, [inlineTerminalSessionId, terminalWindows]);

  // Per-agent tab state for Terminal/Session toggle
  const [agentTabStates, setAgentTabStates] = useState<Record<string, InlineTerminalTab>>({});
  const inlineActiveTab: InlineTerminalTab =
    (inlineTerminalAgentId ? agentTabStates[inlineTerminalAgentId] : undefined) ?? 'terminal';

  const handleInlineTabChange = useCallback(
    (tab: InlineTerminalTab) => {
      if (!inlineTerminalAgentId) return;
      setAgentTabStates((prev) => ({ ...prev, [inlineTerminalAgentId]: tab }));
    },
    [inlineTerminalAgentId],
  );

  // Session transcript for Session tab
  const sessionTranscript = useSessionTranscript(inlineTerminalSessionId, {
    enableTranscript: inlineActiveTab === 'session',
  });

  // ============================================
  // Handlers
  // ============================================

  const handleSendMessage = useCallback(
    (content: string, targets?: string[]) => {
      if (!threadUiState.selectedThreadId) return;
      queries.sendMessageMutation.mutate({
        threadId: threadUiState.selectedThreadId,
        content,
        targets,
      });
      threadUiState.setMessageInput('');
    },
    [threadUiState, queries.sendMessageMutation],
  );

  const handleLaunchWorktreeAgentChat = useCallback(
    (group: WorktreeAgentGroup, agentId: string) => {
      const selectedAgent = group.agents.find((agent) => agent.id === agentId);
      if (!selectedAgent) {
        toast({
          title: 'Unable to select agent',
          description: 'Agent details are unavailable.',
          variant: 'destructive',
        });
        return;
      }

      threadUiState.handleSelectThread(null);
      setSelectedWorktreeAgent({
        worktreeName: group.name,
        agentId,
        group,
      });
    },
    [threadUiState, toast],
  );

  const handleSelectThread = useCallback(
    (threadId: string) => {
      setSelectedWorktreeAgent(null);
      threadUiState.handleSelectThread(threadId);
    },
    [threadUiState],
  );

  useEffect(() => {
    if (!selectedWorktreeAgent) {
      return;
    }

    const nextGroup = worktreeAgentGroups.find(
      (group) => group.name === selectedWorktreeAgent.worktreeName,
    );

    if (!nextGroup) {
      setSelectedWorktreeAgent(null);
      return;
    }

    if (!nextGroup.agents.some((agent) => agent.id === selectedWorktreeAgent.agentId)) {
      setSelectedWorktreeAgent(null);
      return;
    }

    if (nextGroup !== selectedWorktreeAgent.group) {
      setSelectedWorktreeAgent({
        ...selectedWorktreeAgent,
        group: nextGroup,
      });
    }
  }, [selectedWorktreeAgent, worktreeAgentGroups]);

  useEffect(() => {
    if (threadUiState.selectedThreadId) {
      setSelectedWorktreeAgent(null);
    }
  }, [threadUiState.selectedThreadId]);

  const selectedWorktreeAgentDetails = useMemo(() => {
    if (!selectedWorktreeAgent) {
      return null;
    }

    const agent = selectedWorktreeAgent.group.agents.find(
      (candidate) => candidate.id === selectedWorktreeAgent.agentId,
    );
    if (!agent) {
      return null;
    }

    const presence = selectedWorktreeAgent.group.agentPresence[selectedWorktreeAgent.agentId];
    const sessionId = presence?.sessionId ?? null;
    const isOnline = Boolean(presence?.online && sessionId);

    return {
      agentName: agent.name,
      worktreeName: selectedWorktreeAgent.worktreeName,
      isOnline,
      sessionId,
    };
  }, [selectedWorktreeAgent]);

  const getWorktreeAgentKey = useCallback((worktreeName: string, agentId: string): string => {
    return `${worktreeName}:${agentId}`;
  }, []);

  const setWorktreeSessionAction = useCallback(
    (agentKey: string, action: WorktreeSessionAction | null) => {
      setWorktreeSessionActionsByAgentKey((previous) => {
        if (!action) {
          if (!(agentKey in previous)) {
            return previous;
          }
          const next = { ...previous };
          delete next[agentKey];
          return next;
        }
        return {
          ...previous,
          [agentKey]: action,
        };
      });
    },
    [],
  );

  const showWorktreeMcpToast = useCallback(
    (providerName?: string) => {
      toast({
        title: 'MCP not configured',
        description: `Switch to worktree tab to configure MCP${providerName ? ` for ${providerName}` : ''}.`,
        variant: 'destructive',
      });
    },
    [toast],
  );

  const refreshWorktreeAgentGroups = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: ['chat-worktree-agent-groups'],
      refetchType: 'none',
    });
    await queryClient.refetchQueries({
      queryKey: ['chat-worktree-agent-groups'],
      type: 'active',
    });
  }, [queryClient]);

  const selectedWorktreeSessionId = selectedWorktreeAgentDetails?.isOnline
    ? selectedWorktreeAgentDetails.sessionId
    : null;

  const selectedWorktreeWindowId = useMemo(() => {
    if (!selectedWorktreeSessionId || !selectedWorktreeAgentDetails) {
      return null;
    }

    return `worktree:${encodeURIComponent(selectedWorktreeAgentDetails.worktreeName)}:${selectedWorktreeSessionId}`;
  }, [selectedWorktreeSessionId, selectedWorktreeAgentDetails]);

  const isSelectedWorktreeSessionWindowOpen = useMemo(() => {
    if (!selectedWorktreeWindowId) {
      return false;
    }

    return terminalWindows.some((window) => {
      return window.id === selectedWorktreeWindowId && !window.minimized;
    });
  }, [selectedWorktreeWindowId, terminalWindows]);

  const handleOpenSelectedWorktreeWindow = useCallback(() => {
    if (!selectedWorktreeSessionId || !selectedWorktreeAgentDetails) {
      return;
    }

    openWorktreeTerminalWindow({
      sessionId: selectedWorktreeSessionId,
      agentName: selectedWorktreeAgentDetails.agentName,
      worktreeName: selectedWorktreeAgentDetails.worktreeName,
    });
  }, [openWorktreeTerminalWindow, selectedWorktreeSessionId, selectedWorktreeAgentDetails]);

  const handleLaunchWorktreeSession = useCallback(
    async (group: WorktreeAgentGroup, agentId: string) => {
      if (!group.devchainProjectId) {
        toast({
          title: 'Worktree project unavailable',
          description: `Cannot launch session for ${group.name} because project metadata is missing.`,
          variant: 'destructive',
        });
        return;
      }

      const agentKey = getWorktreeAgentKey(group.name, agentId);
      setWorktreeSessionAction(agentKey, 'launching');
      try {
        await launchSession(agentId, group.devchainProjectId, undefined, group.apiBase);
        toast({
          title: 'Session launched',
          description: `Session started for ${group.name}:${agentId}.`,
        });
        await refreshWorktreeAgentGroups();
      } catch (error) {
        if (error instanceof SessionApiError && error.hasCode('MCP_NOT_CONFIGURED')) {
          const providerName =
            typeof error.payload?.details?.providerName === 'string'
              ? error.payload.details.providerName
              : undefined;
          showWorktreeMcpToast(providerName);
          return;
        }
        toast({
          title: 'Failed to launch session',
          description:
            error instanceof Error ? error.message : 'Unable to launch session right now.',
          variant: 'destructive',
        });
      } finally {
        setWorktreeSessionAction(agentKey, null);
      }
    },
    [
      getWorktreeAgentKey,
      refreshWorktreeAgentGroups,
      setWorktreeSessionAction,
      showWorktreeMcpToast,
      toast,
    ],
  );

  const handleRestartWorktreeSession = useCallback(
    async (group: WorktreeAgentGroup, agentId: string) => {
      if (!group.devchainProjectId) {
        toast({
          title: 'Worktree project unavailable',
          description: `Cannot restart session for ${group.name} because project metadata is missing.`,
          variant: 'destructive',
        });
        return;
      }

      const agentKey = getWorktreeAgentKey(group.name, agentId);
      setWorktreeSessionAction(agentKey, 'restarting');
      try {
        const currentSessionId = group.agentPresence[agentId]?.sessionId ?? '';
        const result = await restartSession(
          agentId,
          group.devchainProjectId,
          currentSessionId,
          group.apiBase,
        );
        if (result.terminateWarning) {
          toast({
            title: 'Session restarted with warning',
            description: result.terminateWarning,
            variant: 'destructive',
          });
        } else {
          toast({
            title: 'Session restarted',
            description: `Session ${result.session.id.slice(0, 8)} started.`,
          });
        }
        clearPendingRestart(restartKeyForWorktree(group.apiBase, agentId));
        await refreshWorktreeAgentGroups();
      } catch (error) {
        if (error instanceof SessionApiError && error.hasCode('MCP_NOT_CONFIGURED')) {
          const providerName =
            typeof error.payload?.details?.providerName === 'string'
              ? error.payload.details.providerName
              : undefined;
          showWorktreeMcpToast(providerName);
          return;
        }
        toast({
          title: 'Failed to restart session',
          description:
            error instanceof Error ? error.message : 'Unable to restart session right now.',
          variant: 'destructive',
        });
      } finally {
        setWorktreeSessionAction(agentKey, null);
      }
    },
    [
      clearPendingRestart,
      getWorktreeAgentKey,
      refreshWorktreeAgentGroups,
      setWorktreeSessionAction,
      showWorktreeMcpToast,
      toast,
    ],
  );

  const handleTerminateWorktreeSession = useCallback(
    async (group: WorktreeAgentGroup, agentId: string, sessionId: string) => {
      const agentKey = getWorktreeAgentKey(group.name, agentId);
      setWorktreeSessionAction(agentKey, 'terminating');
      try {
        await terminateSession(sessionId, group.apiBase);
        clearPendingRestart(restartKeyForWorktree(group.apiBase, agentId));
        toast({
          title: 'Session terminated',
          description: 'The worktree session was terminated.',
        });
        await refreshWorktreeAgentGroups();
      } catch (error) {
        toast({
          title: 'Failed to terminate session',
          description:
            error instanceof Error ? error.message : 'Unable to terminate session right now.',
          variant: 'destructive',
        });
      } finally {
        setWorktreeSessionAction(agentKey, null);
      }
    },
    [
      clearPendingRestart,
      getWorktreeAgentKey,
      refreshWorktreeAgentGroups,
      setWorktreeSessionAction,
      toast,
    ],
  );

  const selectedWorktreeAgentKey = useMemo(() => {
    if (!selectedWorktreeAgent) {
      return null;
    }
    return getWorktreeAgentKey(selectedWorktreeAgent.worktreeName, selectedWorktreeAgent.agentId);
  }, [getWorktreeAgentKey, selectedWorktreeAgent]);

  const isSelectedWorktreeAgentLaunching = Boolean(
    selectedWorktreeAgentKey &&
      worktreeSessionActionsByAgentKey[selectedWorktreeAgentKey] === 'launching',
  );

  const handleLaunchSelectedWorktreeSession = useCallback(async () => {
    if (!selectedWorktreeAgent) {
      return;
    }
    await handleLaunchWorktreeSession(selectedWorktreeAgent.group, selectedWorktreeAgent.agentId);
  }, [selectedWorktreeAgent, handleLaunchWorktreeSession]);

  const selectedWorktreeAgentEmptyState = useMemo(() => {
    if (!selectedWorktreeAgentDetails) {
      return <p>Select a worktree agent from the sidebar.</p>;
    }

    return (
      <div className="flex flex-col items-center gap-3">
        <p>
          {selectedWorktreeAgentDetails.agentName} is currently offline in{' '}
          {selectedWorktreeAgentDetails.worktreeName}.
        </p>
        <Button
          type="button"
          size="sm"
          onClick={handleLaunchSelectedWorktreeSession}
          disabled={
            isSelectedWorktreeAgentLaunching || !selectedWorktreeAgent?.group.devchainProjectId
          }
        >
          {isSelectedWorktreeAgentLaunching ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Launching…
            </>
          ) : (
            'Launch session'
          )}
        </Button>
      </div>
    );
  }, [
    selectedWorktreeAgentDetails,
    handleLaunchSelectedWorktreeSession,
    isSelectedWorktreeAgentLaunching,
    selectedWorktreeAgent,
  ]);

  const handleClearSelectedWorktreeAgent = useCallback(() => {
    setSelectedWorktreeAgent(null);
  }, []);

  const handleCreateGroup = useCallback(
    async (agentIds: string[], title?: string) => {
      if (!projectId) {
        toast({
          title: 'Select a project',
          description: 'Choose a project before creating a group chat.',
          variant: 'destructive',
        });
        return;
      }
      const thread = await queries.createGroupMutation.mutateAsync({ agentIds, title });
      setSelectedWorktreeAgent(null);
      threadUiState.handleSelectThread(thread.id);
      toast({
        title: 'Group created',
        description: `Group "${thread.title || 'Untitled'}" has been created.`,
      });
    },
    [projectId, queries.createGroupMutation, threadUiState, toast],
  );

  const handleInviteMembers = useCallback(
    async (agentIds: string[], inviterName?: string) => {
      if (!threadUiState.selectedThreadId || !projectId) return;
      await queries.inviteMembersMutation.mutateAsync({
        threadId: threadUiState.selectedThreadId,
        agentIds,
        inviterName,
      });
      queries.refetchMessages();
      toast({
        title: 'Agents invited',
        description: 'Invite messages have been posted to the thread.',
      });
    },
    [threadUiState.selectedThreadId, projectId, queries, toast],
  );

  const handleClearHistory = useCallback(async () => {
    if (!threadUiState.selectedThreadId) return;
    threadUiState.setClearHistoryDialogOpen(false);
    await queries.clearHistoryMutation.mutateAsync(threadUiState.selectedThreadId);
  }, [threadUiState, queries.clearHistoryMutation]);

  const handlePurgeHistory = useCallback(async () => {
    if (!threadUiState.selectedThreadId) return;
    threadUiState.setClearHistoryDialogOpen(false);
    await queries.purgeHistoryMutation.mutateAsync(threadUiState.selectedThreadId);
  }, [threadUiState, queries.purgeHistoryMutation]);

  const handleOpenTerminal = useCallback(
    (agentId: string) => {
      const presence = queries.agentPresence[agentId];
      if (!threadUiState.selectedThreadId) return;

      if (!presence?.online || !presence.sessionId) {
        threadUiState.attachInlineTerminalForSelectedThread(agentId, null);
        return;
      }

      const session = queries.activeSessions.find((s) => s.id === presence.sessionId);
      if (session) {
        threadUiState.setTerminalMenuOpen(false);
        openTerminalWindow(session);
      }
    },
    [queries.agentPresence, queries.activeSessions, threadUiState, openTerminalWindow],
  );

  const handleOpenInlineTerminal = useCallback(
    (agentId: string) => {
      if (!threadUiState.selectedThreadId) return;
      const presence = queries.agentPresence[agentId];
      const session = presence?.sessionId
        ? queries.activeSessions.find((s) => s.id === presence.sessionId)
        : null;

      if (session) {
        try {
          closeWindow(session.id);
        } catch {
          // no-op if not open
        }
      }

      threadUiState.attachInlineTerminalForSelectedThread(agentId, session ? session.id : null);
    },
    [queries.agentPresence, queries.activeSessions, threadUiState, closeWindow],
  );

  const handleDetachInlineTerminal = useCallback(() => {
    if (!threadUiState.selectedThreadId || !inlineTerminalState) return;
    threadUiState.setInlineTerminalsByThread((prev) => {
      if (!prev[threadUiState.selectedThreadId!]) return prev;
      const next = { ...prev };
      delete next[threadUiState.selectedThreadId!];
      return next;
    });
    threadUiState.setTerminalMenuOpen(false);
    threadUiState.setInlineUnreadCount(0);
  }, [threadUiState, inlineTerminalState]);

  const handleVerifyMcp = useCallback(async (): Promise<boolean> => {
    queryClient.invalidateQueries({ queryKey: ['preflight'] });
    const result = await queries.refetchPreflight();
    const data = result.data as
      | { providers?: Array<{ id: string; mcpStatus: string }> }
      | undefined;
    if (!sessionControls.pendingLaunchAgent || !data?.providers) return false;
    const providerCheck = data.providers.find(
      (p) => p.id === sessionControls.pendingLaunchAgent!.providerId,
    );
    return providerCheck?.mcpStatus === 'pass';
  }, [queryClient, queries.refetchPreflight, sessionControls.pendingLaunchAgent]);

  // ESC key interception for terminal sessions
  useEffect(() => {
    const handleGlobalEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (
        threadUiState.groupDialogOpen ||
        threadUiState.inviteDialogOpen ||
        threadUiState.settingsDialogOpen ||
        threadUiState.clearHistoryDialogOpen
      ) {
        return;
      }

      let targetSessionId: string | null = null;
      if (showInlineTerminal && inlineTerminalSessionId) {
        targetSessionId = inlineTerminalSessionId;
      } else if (focusedWindowId) {
        targetSessionId = focusedWindowId;
      }

      if (targetSessionId && socketRef.current?.connected) {
        e.preventDefault();
        e.stopPropagation();
        socketRef.current.emit('terminal:input', {
          sessionId: targetSessionId,
          data: '\x1b',
        });
      }
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
  }, [
    threadUiState.groupDialogOpen,
    threadUiState.inviteDialogOpen,
    threadUiState.settingsDialogOpen,
    threadUiState.clearHistoryDialogOpen,
    showInlineTerminal,
    inlineTerminalSessionId,
    focusedWindowId,
  ]);

  // ============================================
  // Render CTAs
  // ============================================

  const shouldShowDirectLaunchCta = Boolean(
    queries.presenceReady && isDirectMessage && selectedAgent && !isSelectedAgentOnline,
  );
  const shouldShowGroupLaunchCta = Boolean(
    queries.presenceReady && currentThread?.isGroup && offlineGroupMembers.length > 0,
  );
  const launchingSelectedAgent =
    selectedAgent && sessionControls.launchingAgentIds[selectedAgent.id];

  const directLaunchCta =
    shouldShowDirectLaunchCta && selectedAgent ? (
      <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed border-border bg-muted/40 p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">Agent is not active.</p>
          <p className="text-xs text-muted-foreground">
            Launch a session to collaborate inline inside this conversation.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => sessionControls.handleLaunchSession(selectedAgent.id)}
          disabled={launchingSelectedAgent || !hasSelectedProject}
        >
          {launchingSelectedAgent ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Launching…
            </>
          ) : (
            'Launch session'
          )}
        </Button>
      </div>
    ) : null;

  const groupLaunchCta = shouldShowGroupLaunchCta ? (
    <div className="space-y-3 rounded-lg border border-dashed border-border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Agents aren&apos;t active.</p>
          <p className="text-xs text-muted-foreground">
            Launch sessions for offline agents to collaborate inline.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={sessionControls.handleStartAllAgents}
          disabled={sessionControls.startingAll || offlineGroupMembers.length === 0}
        >
          {sessionControls.startingAll ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Launching…
            </>
          ) : (
            'Launch all'
          )}
        </Button>
      </div>
    </div>
  ) : null;

  const composerBlockedContent = directLaunchCta ?? groupLaunchCta ?? null;

  // ============================================
  // Early Returns
  // ============================================

  if (projectsLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span>Loading projects…</span>
        </div>
      </div>
    );
  }

  if (!hasSelectedProject) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
        <AlertCircle className="mb-4 h-12 w-12" />
        <h2 className="text-xl font-semibold text-foreground">Select a project to open Chat</h2>
        <p className="mt-2 max-w-md">
          Use the project selector in the header to choose a project. Chat lists agents, threads,
          and messages for the selected project only.
        </p>
      </div>
    );
  }

  // ============================================
  // Main Render
  // ============================================

  return (
    <div className="flex h-full gap-4">
      {/* Left Sidebar */}
      <ChatSidebar
        projectId={projectId}
        agents={queries.agents}
        guests={queries.guests}
        agentPresence={queries.agentPresence}
        userThreads={queries.userThreads}
        agentThreads={queries.agentThreads}
        presenceReady={queries.presenceReady}
        offlineAgents={sessionControls.offlineAgents}
        agentsWithSessions={sessionControls.agentsWithSessions}
        agentsLoading={queries.agentsLoading}
        agentsError={queries.agentsError}
        userThreadsLoading={queries.userThreadsLoading}
        agentThreadsLoading={queries.agentThreadsLoading}
        launchingAgentIds={sessionControls.launchingAgentIds}
        restartingAgentId={sessionControls.restartingAgentId}
        startingAll={sessionControls.startingAll}
        terminatingAll={sessionControls.terminatingAll}
        isLaunchingChat={isLaunchingChat}
        selectedThreadId={threadUiState.selectedThreadId}
        selectedWorktreeAgent={
          selectedWorktreeAgent
            ? {
                worktreeName: selectedWorktreeAgent.worktreeName,
                agentId: selectedWorktreeAgent.agentId,
              }
            : null
        }
        hasSelectedProject={hasSelectedProject}
        onSelectThread={handleSelectThread}
        onLaunchChat={launchChat}
        worktreeAgentGroups={worktreeAgentGroups}
        worktreeAgentGroupsLoading={worktreeAgentGroupsLoading}
        onLaunchWorktreeAgentChat={handleLaunchWorktreeAgentChat}
        onLaunchWorktreeSession={handleLaunchWorktreeSession}
        onRestartWorktreeSession={handleRestartWorktreeSession}
        onTerminateWorktreeSession={handleTerminateWorktreeSession}
        onCreateGroup={() => threadUiState.setGroupDialogOpen(true)}
        onStartAllAgents={sessionControls.handleStartAllAgents}
        onTerminateAllConfirm={() => sessionControls.setTerminateAllConfirm(true)}
        onLaunchSession={sessionControls.handleLaunchSession}
        onRestartSession={handleRestartSessionWithClear}
        onTerminateConfirm={(agentId, sessionId) =>
          sessionControls.setTerminateConfirm({ agentId, sessionId })
        }
        getProviderForAgent={queries.getProviderForAgent}
        pendingRestartAgentIds={pendingRestartAgentIds}
        onMarkForRestart={markAgentsForRestart}
        worktreeSessionActionsByAgentKey={worktreeSessionActionsByAgentKey}
        validatedPresets={validatedPresets}
        activePreset={activePreset}
        onApplyPreset={handleApplyPreset}
        applyingPreset={applyPresetMutation.isPending}
        onSwitchConfig={handleSwitchConfig}
        fetchProviderConfigsForProfile={fetchProviderConfigsForProfile}
        updatingConfigAgentIds={updatingConfigAgentIds}
        onSwitchWorktreeConfig={handleSwitchWorktreeConfig}
        updatingWorktreeConfigKey={updatingWorktreeConfigKey}
        onCloneAgent={(agent, ctx) =>
          setPendingCloneAgent({
            agent,
            teamId: ctx?.teamId,
            teamName: ctx?.teamName,
            isTeamLead: ctx?.isTeamLead,
          })
        }
        onDeleteAgent={setPendingDeleteAgent}
        pendingDeleteAgentId={pendingDeleteAgentId}
        onAddTeamAgent={handleAddTeamAgent}
        projectProfiles={queries.profiles}
        onEditTeam={handleOpenEditTeam}
        createGroupPending={queries.createGroupMutation.isPending}
      />

      {/* Right Content Area */}
      <div className="flex flex-1 flex-col">
        {selectedWorktreeAgent ? (
          <div className="flex flex-1 min-h-0 flex-col p-4">
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-terminal text-terminal-foreground shadow-sm">
              <InlineTerminalHeader
                agentName={selectedWorktreeAgentDetails?.agentName ?? null}
                onBackToChat={handleClearSelectedWorktreeAgent}
                onOpenWindow={
                  selectedWorktreeSessionId ? handleOpenSelectedWorktreeWindow : undefined
                }
              />
              {selectedWorktreeSessionId ? (
                <WorktreeInlineTerminal
                  worktreeName={selectedWorktreeAgent.worktreeName}
                  sessionId={selectedWorktreeSessionId}
                  agentName={selectedWorktreeAgentDetails?.agentName ?? null}
                  isWindowOpen={isSelectedWorktreeSessionWindowOpen}
                  windowId={selectedWorktreeWindowId}
                />
              ) : (
                <InlineTerminalPanel
                  sessionId={null}
                  agentName={selectedWorktreeAgentDetails?.agentName ?? null}
                  isWindowOpen={false}
                  emptyState={selectedWorktreeAgentEmptyState}
                />
              )}
            </div>
          </div>
        ) : threadUiState.selectedThreadId ? (
          <>
            {/* Thread Header — hidden when inline terminal is active to avoid duplication */}
            {!(showInlineTerminal && CHAT_INLINE_TERMINAL_ENABLED) && (
              <ChatThreadHeader
                currentThread={currentThread}
                currentThreadMembers={currentThreadMembers}
                selectedAgent={selectedAgent}
                threadDisplayName={threadDisplayName}
                agentPresence={queries.agentPresence}
                inlineUnreadCount={inlineUnreadCount}
                terminalMenuOpen={threadUiState.terminalMenuOpen}
                hasSelectedProject={hasSelectedProject}
                canInviteMembers={canInviteMembers}
                isCoarsePointer={isCoarsePointer}
                setTerminalMenuOpen={threadUiState.setTerminalMenuOpen}
                onOpenTerminal={handleOpenTerminal}
                onOpenInlineTerminal={handleOpenInlineTerminal}
                onDetachInlineTerminal={handleDetachInlineTerminal}
                onOpenInviteDialog={() => threadUiState.setInviteDialogOpen(true)}
                onOpenSettingsDialog={() => threadUiState.setSettingsDialogOpen(true)}
                onOpenClearHistoryDialog={() => threadUiState.setClearHistoryDialogOpen(true)}
                inlineTerminalAgentId={inlineTerminalAgentId}
                clearHistoryPending={queries.clearHistoryMutation.isPending}
              />
            )}

            {showInlineTerminal && CHAT_INLINE_TERMINAL_ENABLED ? (
              <div className="flex flex-1 min-h-0 flex-col p-4">
                <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-terminal text-terminal-foreground shadow-sm">
                  <InlineTerminalHeader
                    agentName={inlineTerminalAgentName}
                    onBackToChat={handleDetachInlineTerminal}
                    showChatToggle={false}
                    onOpenWindow={
                      inlineTerminalAgentId
                        ? () => handleOpenTerminal(inlineTerminalAgentId)
                        : undefined
                    }
                    activeTab={inlineActiveTab}
                    onTabChange={handleInlineTabChange}
                    hasTranscript={Boolean(inlineTerminalSessionId)}
                    sessionChip={
                      sessionTranscript.metrics
                        ? {
                            metrics: sessionTranscript.metrics,
                            activeTab: inlineActiveTab,
                            onSwitchToSession: () => handleInlineTabChange('session'),
                          }
                        : undefined
                    }
                  />
                  <InlineTerminalPanel
                    sessionId={inlineTerminalSessionId}
                    agentName={inlineTerminalAgentName}
                    isWindowOpen={isInlineSessionWindowOpen}
                    activeTab={inlineActiveTab}
                    emptyState={
                      directLaunchCta ?? (
                        <p>Agent must be online before the terminal is available.</p>
                      )
                    }
                    sessionContent={
                      <SessionViewerPanel
                        sessionId={inlineTerminalSessionId}
                        messages={sessionTranscript.messages}
                        chunks={sessionTranscript.chunks}
                        metrics={sessionTranscript.metrics}
                        isLive={sessionTranscript.isLive}
                        isLoading={sessionTranscript.isLoading}
                        error={sessionTranscript.error}
                        warnings={sessionTranscript.session?.warnings}
                      />
                    }
                  />
                </div>
              </div>
            ) : (
              <>
                {/* Message List */}
                <ChatMessageList
                  messages={queries.messages}
                  getAgentName={(agentId) =>
                    agentId ? (queries.agents.find((a) => a.id === agentId)?.name ?? null) : null
                  }
                  getProviderForAgent={queries.getProviderForAgent}
                />

                {/* Message Composer */}
                {composerBlockedContent ? (
                  <div className="border-t p-4" aria-live="polite">
                    {composerBlockedContent}
                  </div>
                ) : (
                  <ChatComposer
                    messageInput={threadUiState.messageInput}
                    setMessageInput={threadUiState.setMessageInput}
                    agents={queries.agents}
                    agentPresence={queries.agentPresence}
                    onSendMessage={handleSendMessage}
                    parseMentions={parseMentions}
                    isSending={queries.sendMessageMutation.isPending}
                  />
                )}
              </>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-center">
            <div>
              <MessageSquare className="mx-auto mb-4 h-16 w-16 text-muted-foreground" />
              <h2 className="text-xl font-semibold">No conversation selected</h2>
              <p className="text-muted-foreground">
                Select an agent, group, or thread from the sidebar to start chatting
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      <ChatModals
        groupDialogOpen={threadUiState.groupDialogOpen}
        setGroupDialogOpen={threadUiState.setGroupDialogOpen}
        inviteDialogOpen={threadUiState.inviteDialogOpen}
        setInviteDialogOpen={threadUiState.setInviteDialogOpen}
        settingsDialogOpen={threadUiState.settingsDialogOpen}
        setSettingsDialogOpen={threadUiState.setSettingsDialogOpen}
        clearHistoryDialogOpen={threadUiState.clearHistoryDialogOpen}
        setClearHistoryDialogOpen={threadUiState.setClearHistoryDialogOpen}
        terminateConfirm={sessionControls.terminateConfirm}
        setTerminateConfirm={sessionControls.setTerminateConfirm}
        terminateAllConfirm={sessionControls.terminateAllConfirm}
        setTerminateAllConfirm={sessionControls.setTerminateAllConfirm}
        mcpModalOpen={sessionControls.mcpModalOpen}
        setMcpModalOpen={sessionControls.setMcpModalOpen}
        agents={queries.agents}
        inviteableAgents={inviteableAgents}
        currentThread={currentThread}
        currentThreadMembers={currentThreadMembers}
        agentsWithSessions={sessionControls.agentsWithSessions}
        pendingLaunchAgent={sessionControls.pendingLaunchAgent}
        setPendingLaunchAgent={sessionControls.setPendingLaunchAgent}
        projectId={projectId}
        projectRootPath={selectedProject?.rootPath}
        hasSelectedProject={hasSelectedProject}
        selectedThreadId={threadUiState.selectedThreadId}
        threadDisplayName={threadDisplayName}
        onCreateGroup={handleCreateGroup}
        onInviteMembers={handleInviteMembers}
        onClearHistory={handleClearHistory}
        onPurgeHistory={handlePurgeHistory}
        onTerminateSession={handleTerminateSessionWithClear}
        onTerminateAllAgents={handleTerminateAllAgentsWithClear}
        onMcpConfigured={sessionControls.handleMcpConfigured}
        onVerifyMcp={handleVerifyMcp}
        launchingAgentIds={sessionControls.launchingAgentIds}
        clearHistoryPending={queries.clearHistoryMutation.isPending}
        purgeHistoryPending={queries.purgeHistoryMutation.isPending}
        invitePending={queries.inviteMembersMutation.isPending}
        terminatingAll={sessionControls.terminatingAll}
      />

      {/* Clone agent confirmation */}
      <Dialog
        open={!!pendingCloneAgent}
        onOpenChange={(open) => {
          if (!open) setPendingCloneAgent(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clone agent</DialogTitle>
            <DialogDescription>
              {cloneTargetTeam ? (
                <>
                  A copy of &ldquo;{pendingCloneAgent?.agent.name}&rdquo; will be created as &ldquo;
                  {pendingCloneName}&rdquo; in team &ldquo;{cloneTargetTeam.teamName}&rdquo;.
                  Continue?
                </>
              ) : (
                <>
                  A fresh copy of &ldquo;{pendingCloneAgent?.agent.name}&rdquo; will be created as
                  &ldquo;{pendingCloneName}&rdquo;. It won&apos;t belong to any team. Continue?
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingCloneAgent(null)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmClone} disabled={cloneAgentMutation.isPending}>
              {cloneAgentMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Cloning...
                </>
              ) : (
                'Clone'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete agent confirmation */}
      <Dialog
        open={!!pendingDeleteAgent}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteAgent(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete agent</DialogTitle>
            <DialogDescription>
              {pendingDeleteHasSession
                ? `"${pendingDeleteAgent?.name}" has an active session. Confirming will stop the session and then permanently delete the agent. Continue?`
                : `Delete "${pendingDeleteAgent?.name}" from this team? This permanently removes the agent.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDeleteAgent(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={deleteAgentMutation.isPending}
            >
              {deleteAgentMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-edit team */}
      <Dialog
        open={!!quickEditTeam}
        onOpenChange={(open) => {
          if (!open) setQuickEditTeam(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit team &quot;{quickEditTeam?.teamName}&quot;</DialogTitle>
            <DialogDescription>Adjust team capacity settings.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>Max team members</Label>
                <span className="text-xs text-muted-foreground">{qeMaxMembers}</span>
              </div>
              <Slider
                min={2}
                max={10}
                step={1}
                value={[qeMaxMembers]}
                onValueChange={([v]) => {
                  setQeMaxMembers(v);
                  if (qeMaxConcurrentTasks > v) {
                    setQeMaxConcurrentTasks(v);
                  }
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>Max concurrent tasks</Label>
                <span className="text-xs text-muted-foreground">{qeMaxConcurrentTasks}</span>
              </div>
              <Slider
                min={1}
                max={qeMaxMembers}
                step={1}
                value={[qeMaxConcurrentTasks]}
                onValueChange={([v]) => setQeMaxConcurrentTasks(v)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="qe-allow-lead-create"
                  checked={qeAllowTeamLeadCreateAgents}
                  onCheckedChange={(checked) => setQeAllowTeamLeadCreateAgents(checked === true)}
                />
                <Label htmlFor="qe-allow-lead-create" className="text-sm font-normal">
                  Allow team lead to autonomously create team agents
                </Label>
              </div>
              <p className="text-xs text-muted-foreground pl-6">
                Controls only the autonomous AI agent. Humans can always add agents via the chat
                sidebar.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuickEditTeam(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!quickEditTeam) return;
                quickEditTeamMutation.mutate({
                  teamId: quickEditTeam.teamId,
                  maxMembers: qeMaxMembers,
                  maxConcurrentTasks: qeMaxConcurrentTasks,
                  allowTeamLeadCreateAgents: qeAllowTeamLeadCreateAgents,
                });
              }}
              disabled={quickEditTeamMutation.isPending}
            >
              {quickEditTeamMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
