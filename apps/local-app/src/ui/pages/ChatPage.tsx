import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Loader2, AlertCircle, MessageSquare } from 'lucide-react';
import type { Preset } from '@/ui/lib/preset-types';
import { restartKeyForMain } from '@/ui/lib/restart-keys';
import {
  useTerminalWindowManager,
  useTerminalWindows,
  useWorktreeTerminalWindowManager,
} from '@/ui/terminal-windows';
import { parseMentions } from '@/ui/lib/chat';
import { useChatLauncher } from '@/ui/components/chat/ChatLauncher';
import { useToastHelpers } from '@/ui/lib/toast-helpers';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { usePointerCoarse } from '@/ui/hooks/usePointerCoarse';
import { useActiveSessionConfirm } from '@/ui/hooks/useActiveSessionConfirm';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { useWorktreeAgents, type WorktreeAgentGroup } from '@/ui/hooks/useWorktreeAgents';
import { useWorktreeSessionControls } from '@/ui/hooks/useWorktreeSessionControls';
import { useTeamQuickEdit } from '@/ui/hooks/chat/useTeamQuickEdit';
import { usePresetApply } from '@/ui/hooks/chat/usePresetApply';
import { useAgentConfigSwitch } from '@/ui/hooks/chat/useAgentConfigSwitch';
import { useAgentAdminActions } from '@/ui/hooks/chat/useAgentAdminActions';
import { useWorktreeSocket } from '@/ui/hooks/useWorktreeSocket';

// Inline terminal components
import { InlineTerminalPanel } from '@/ui/components/chat/InlineTerminalPanel';
import {
  CustomPromptPicker,
  type CustomPromptPickerTarget,
} from '@/ui/components/chat/CustomPromptPicker';
import {
  InlineTerminalHeader,
  type InlineTerminalTab,
} from '@/ui/components/chat/InlineTerminalHeader';
import { Button } from '@/ui/components/ui/button';

// Session reader
import { useSessionTranscript } from '@/ui/hooks/useSessionTranscript';
import { SessionViewerPanel } from '@/ui/components/session-reader/SessionViewerPanel';
import { isPagedTranscriptEnabled } from '@/ui/hooks/usePagedTranscript';

// Extracted hooks
import { useChatQueries } from '@/ui/hooks/useChatQueries';
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
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import type { TerminalHandle } from '@/ui/components/Terminal';
import { useInlineTerminalPromptShortcut } from '@/ui/hooks/chat/useInlineTerminalPromptShortcut';

// Extracted components
import {
  ChatSidebar,
  type ChatSidebarData,
  type ChatSidebarSessionController,
  type ChatSidebarAdminActions,
} from '@/ui/components/chat/ChatSidebar';
import { ChatThreadHeader } from '@/ui/components/chat/ChatThreadHeader';
import { ChatMessageList } from '@/ui/components/chat/ChatMessageList';
import { ChatComposer } from '@/ui/components/chat/ChatComposer';
import { ChatModals } from '@/ui/components/chat/ChatModals';
import { PreviousSessionsTable } from '@/ui/components/chat/PreviousSessionsTable';
import { SessionReadSlideOver } from '@/ui/components/chat/SessionReadSlideOver';

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
  terminalRef?: React.Ref<TerminalHandle>;
}

function WorktreeInlineTerminal({
  worktreeName,
  sessionId,
  agentName,
  isWindowOpen,
  windowId,
  terminalRef,
}: WorktreeInlineTerminalProps) {
  const { socket } = useWorktreeSocket(worktreeName);

  return (
    <InlineTerminalPanel
      sessionId={sessionId}
      socket={socket}
      agentName={agentName}
      isWindowOpen={isWindowOpen}
      windowId={windowId}
      terminalRef={terminalRef}
    />
  );
}

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function fetchPresets(
  projectId: string,
  fetchFn: FetchFn,
): Promise<{ presets: Preset[]; activePreset: string | null }> {
  const res = await fetchFn(`/api/projects/${projectId}/presets`);
  if (!res.ok) throw new Error('Failed to fetch presets');
  return res.json();
}

export function ChatPage() {
  const queryClient = useQueryClient();
  const { toast } = useToastHelpers();
  const { confirmIfActiveSessions, dialogProps: activeSessionDialogProps } =
    useActiveSessionConfirm();
  const { selectedProjectId, selectedProject, projectsLoading } = useSelectedProject();
  const projectId = selectedProjectId ?? null;
  const hasSelectedProject = Boolean(projectId);
  const isCoarsePointer = usePointerCoarse();
  const openTerminalWindow = useTerminalWindowManager();
  const openWorktreeTerminalWindow = useWorktreeTerminalWindowManager();
  const apiFetch = useFetchFactory();
  const { windows: terminalWindows, closeWindow, focusedWindowId } = useTerminalWindows();
  const [mainTerminalHandle, setMainTerminalHandle] = useState<TerminalHandle | null>(null);
  const [worktreeTerminalHandle, setWorktreeTerminalHandle] = useState<TerminalHandle | null>(null);
  const [customPromptPickerOpen, setCustomPromptPickerOpen] = useState(false);

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
    queryFn: () => fetchPresets(projectId!, apiFetch),
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
            const res = await apiFetch(`/api/profiles/${profileId}/provider-configs`);
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

  const { validatedPresets, handleApplyPreset, applyingPreset } = usePresetApply({
    projectId,
    apiFetch,
    presets,
    agentsWithProfiles,
    configsMap,
    agents: queries.agents,
    agentPresence: queries.agentPresence,
    markAgentsForRestart,
    confirmIfActiveSessions,
  });

  // ============================================
  // Provider Config Switching
  // ============================================

  const {
    handleSwitchConfig,
    handleSwitchWorktreeConfig,
    fetchProviderConfigsForProfile,
    updatingConfigAgentIds,
    updatingWorktreeConfigKey,
  } = useAgentConfigSwitch({
    apiFetch,
    projectId,
    agentPresence: queries.agentPresence,
    worktreeAgentGroups,
    markAgentsForRestart,
  });

  // ── Agent admin actions (clone / delete / quick-add) ──
  const {
    pendingCloneAgent,
    setPendingCloneAgent,
    pendingCloneName,
    cloneTargetTeam,
    handleConfirmClone,
    cloningAgent,
    pendingDeleteAgent,
    setPendingDeleteAgent,
    pendingDeleteAgentId,
    pendingDeleteHasSession,
    handleConfirmDelete,
    deletingAgent,
    handleAddTeamAgent,
  } = useAgentAdminActions({
    apiFetch,
    projectId,
    agents: queries.agents,
    activeSessions: queries.activeSessions,
  });

  const [readSlideOverSessionId, setReadSlideOverSessionId] = useState<string | null>(null);

  // ── Quick-edit team modal (domain hook) ──
  const quickEdit = useTeamQuickEdit({ projectId });

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
  const inlineTerminalSession = inlineTerminalSessionId
    ? queries.activeSessions.find((session) => session.id === inlineTerminalSessionId)
    : undefined;
  const inlineTerminalSessionName = inlineTerminalSession?.name ?? null;
  const isInlineTerminalSessionRunning = inlineTerminalSession?.status === 'running';

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
    enableTranscript: !isPagedTranscriptEnabled() && inlineActiveTab === 'session',
    isSessionRunning: isInlineTerminalSessionRunning,
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
      apiBase: selectedWorktreeAgent.group.apiBase,
      devchainProjectId: selectedWorktreeAgent.group.devchainProjectId,
      isOnline,
      sessionId,
    };
  }, [selectedWorktreeAgent]);

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

  // Worktree session lifecycle lives in its policy adapter (Seam 1); ChatPage
  // only injects the cache-refresh and pending-restart seams it owns.
  const {
    worktreeSessionActionsByAgentKey,
    getWorktreeAgentKey,
    handleLaunchWorktreeSession,
    handleRestartWorktreeSession,
    handleTerminateWorktreeSession,
  } = useWorktreeSessionControls({ refreshWorktreeAgentGroups, clearPendingRestart });

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

  const canOpenMainCustomPrompts = Boolean(
    !selectedWorktreeAgent &&
      projectId &&
      showInlineTerminal &&
      inlineTerminalSessionId &&
      inlineActiveTab === 'terminal' &&
      !isInlineSessionWindowOpen &&
      mainTerminalHandle,
  );
  const canOpenWorktreeCustomPrompts = Boolean(
    selectedWorktreeAgentDetails?.devchainProjectId &&
      selectedWorktreeSessionId &&
      !isSelectedWorktreeSessionWindowOpen &&
      worktreeTerminalHandle,
  );

  const customPromptTarget = useMemo<CustomPromptPickerTarget | null>(() => {
    if (
      selectedWorktreeAgentDetails?.devchainProjectId &&
      selectedWorktreeSessionId &&
      !isSelectedWorktreeSessionWindowOpen &&
      worktreeTerminalHandle
    ) {
      return {
        sessionId: selectedWorktreeSessionId,
        projectId: selectedWorktreeAgentDetails.devchainProjectId,
        apiBase: selectedWorktreeAgentDetails.apiBase,
        fetchFn: fetch,
        terminalHandle: worktreeTerminalHandle,
      };
    }

    if (
      !selectedWorktreeAgent &&
      projectId &&
      showInlineTerminal &&
      inlineTerminalSessionId &&
      inlineActiveTab === 'terminal' &&
      !isInlineSessionWindowOpen &&
      mainTerminalHandle
    ) {
      return {
        sessionId: inlineTerminalSessionId,
        projectId,
        apiBase: '',
        fetchFn: apiFetch,
        terminalHandle: mainTerminalHandle,
      };
    }

    return null;
  }, [
    apiFetch,
    inlineActiveTab,
    inlineTerminalSessionId,
    isInlineSessionWindowOpen,
    isSelectedWorktreeSessionWindowOpen,
    mainTerminalHandle,
    projectId,
    selectedWorktreeAgent,
    selectedWorktreeAgentDetails,
    selectedWorktreeSessionId,
    showInlineTerminal,
    worktreeTerminalHandle,
  ]);

  useEffect(() => {
    if (customPromptPickerOpen && !customPromptTarget) {
      setCustomPromptPickerOpen(false);
    }
  }, [customPromptPickerOpen, customPromptTarget]);

  const handleOpenCustomPrompts = useCallback(() => {
    if (customPromptTarget) {
      setCustomPromptPickerOpen(true);
    }
  }, [customPromptTarget]);

  useInlineTerminalPromptShortcut(
    canOpenMainCustomPrompts || canOpenWorktreeCustomPrompts,
    handleOpenCustomPrompts,
  );

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
        threadUiState.clearHistoryDialogOpen ||
        customPromptPickerOpen
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
        // Claim authority before sending input — focusedWindowId is UI-only state
        // and does not trigger terminal:focus. claimAuthority is idempotent.
        // Known limitation: worktree floating windows use a separate worktree socket;
        // the main socket cannot claim authority on those sessions (pre-existing).
        socketRef.current.emit('terminal:focus', { sessionId: targetSessionId });
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
    customPromptPickerOpen,
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
      <div className="space-y-0">
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
        {projectId && (
          <PreviousSessionsTable
            agentId={selectedAgent.id}
            projectId={projectId}
            onRead={setReadSlideOverSessionId}
            onRestore={(sessionId) =>
              sessionControls.handleRestoreSession(sessionId, selectedAgent.id)
            }
            currentProviderName={selectedAgent.providerConfig?.providerName ?? null}
            restoringSessionIds={sessionControls.restoringSessionIds}
          />
        )}
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
  // ChatSidebar prop bundles (memoized for referential stability)
  // ============================================

  const sidebarData = useMemo<ChatSidebarData>(
    () => ({
      projectId,
      agents: queries.agents,
      guests: queries.guests,
      worktreeAgentGroups,
      worktreeAgentGroupsLoading,
      agentPresence: queries.agentPresence,
      userThreads: queries.userThreads,
      agentThreads: queries.agentThreads,
      presenceReady: queries.presenceReady,
      offlineAgents: sessionControls.offlineAgents,
      agentsWithSessions: sessionControls.agentsWithSessions,
      agentsLoading: queries.agentsLoading,
      agentsError: queries.agentsError,
      userThreadsLoading: queries.userThreadsLoading,
      agentThreadsLoading: queries.agentThreadsLoading,
      selectedThreadId: threadUiState.selectedThreadId,
      selectedWorktreeAgent: selectedWorktreeAgent
        ? {
            worktreeName: selectedWorktreeAgent.worktreeName,
            agentId: selectedWorktreeAgent.agentId,
          }
        : null,
      hasSelectedProject,
      getProviderForAgent: queries.getProviderForAgent,
      validatedPresets,
      activePreset,
      projectProfiles: queries.profiles,
    }),
    [
      projectId,
      queries.agents,
      queries.guests,
      worktreeAgentGroups,
      worktreeAgentGroupsLoading,
      queries.agentPresence,
      queries.userThreads,
      queries.agentThreads,
      queries.presenceReady,
      sessionControls.offlineAgents,
      sessionControls.agentsWithSessions,
      queries.agentsLoading,
      queries.agentsError,
      queries.userThreadsLoading,
      queries.agentThreadsLoading,
      threadUiState.selectedThreadId,
      selectedWorktreeAgent,
      hasSelectedProject,
      queries.getProviderForAgent,
      validatedPresets,
      activePreset,
      queries.profiles,
    ],
  );

  const sidebarSessionController = useMemo<ChatSidebarSessionController>(
    () => ({
      launchingAgentIds: sessionControls.launchingAgentIds,
      restartingAgentId: sessionControls.restartingAgentId,
      startingAll: sessionControls.startingAll,
      terminatingAll: sessionControls.terminatingAll,
      isLaunchingChat,
      onSelectThread: handleSelectThread,
      onLaunchChat: launchChat,
      onLaunchWorktreeAgentChat: handleLaunchWorktreeAgentChat,
      onLaunchWorktreeSession: handleLaunchWorktreeSession,
      onRestartWorktreeSession: handleRestartWorktreeSession,
      onTerminateWorktreeSession: handleTerminateWorktreeSession,
      onCreateGroup: () => threadUiState.setGroupDialogOpen(true),
      onStartAllAgents: sessionControls.handleStartAllAgents,
      onTerminateAllConfirm: () => sessionControls.setTerminateAllConfirm(true),
      onLaunchSession: sessionControls.handleLaunchSession,
      onRestartSession: handleRestartSessionWithClear,
      onTerminateConfirm: (agentId, sessionId) =>
        sessionControls.setTerminateConfirm({ agentId, sessionId }),
      pendingRestartAgentIds,
      onMarkForRestart: markAgentsForRestart,
      worktreeSessionActionsByAgentKey,
      onApplyPreset: handleApplyPreset,
      applyingPreset,
      onSwitchConfig: handleSwitchConfig,
      fetchProviderConfigsForProfile,
      updatingConfigAgentIds,
      onSwitchWorktreeConfig: handleSwitchWorktreeConfig,
      updatingWorktreeConfigKey,
      createGroupPending: queries.createGroupMutation.isPending,
    }),
    [
      sessionControls.launchingAgentIds,
      sessionControls.restartingAgentId,
      sessionControls.startingAll,
      sessionControls.terminatingAll,
      isLaunchingChat,
      handleSelectThread,
      launchChat,
      handleLaunchWorktreeAgentChat,
      handleLaunchWorktreeSession,
      handleRestartWorktreeSession,
      handleTerminateWorktreeSession,
      threadUiState.setGroupDialogOpen,
      sessionControls.handleStartAllAgents,
      sessionControls.setTerminateAllConfirm,
      sessionControls.handleLaunchSession,
      handleRestartSessionWithClear,
      sessionControls.setTerminateConfirm,
      pendingRestartAgentIds,
      markAgentsForRestart,
      worktreeSessionActionsByAgentKey,
      handleApplyPreset,
      applyingPreset,
      handleSwitchConfig,
      fetchProviderConfigsForProfile,
      updatingConfigAgentIds,
      handleSwitchWorktreeConfig,
      updatingWorktreeConfigKey,
      queries.createGroupMutation.isPending,
    ],
  );

  const sidebarAdminActions = useMemo<ChatSidebarAdminActions>(
    () => ({
      onCloneAgent: (agent, ctx) =>
        setPendingCloneAgent({
          agent,
          teamId: ctx?.teamId,
          teamName: ctx?.teamName,
          isTeamLead: ctx?.isTeamLead,
        }),
      onDeleteAgent: setPendingDeleteAgent,
      pendingDeleteAgentId,
      onAddTeamAgent: handleAddTeamAgent,
      onEditTeam: quickEdit.openEditTeam,
    }),
    [
      setPendingCloneAgent,
      setPendingDeleteAgent,
      pendingDeleteAgentId,
      handleAddTeamAgent,
      quickEdit.openEditTeam,
    ],
  );

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
        data={sidebarData}
        sessionController={sidebarSessionController}
        adminActions={sidebarAdminActions}
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
                onOpenPrompts={canOpenWorktreeCustomPrompts ? handleOpenCustomPrompts : undefined}
              />
              {selectedWorktreeSessionId ? (
                <WorktreeInlineTerminal
                  worktreeName={selectedWorktreeAgent.worktreeName}
                  sessionId={selectedWorktreeSessionId}
                  agentName={selectedWorktreeAgentDetails?.agentName ?? null}
                  isWindowOpen={isSelectedWorktreeSessionWindowOpen}
                  windowId={selectedWorktreeWindowId}
                  terminalRef={setWorktreeTerminalHandle}
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
                    onOpenPrompts={canOpenMainCustomPrompts ? handleOpenCustomPrompts : undefined}
                    activeTab={inlineActiveTab}
                    onTabChange={handleInlineTabChange}
                    hasTranscript={Boolean(inlineTerminalSessionId)}
                    sessionId={inlineTerminalSessionId}
                    sessionName={inlineTerminalSessionName}
                    projectId={projectId}
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
                    terminalRef={setMainTerminalHandle}
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
            <Button onClick={handleConfirmClone} disabled={cloningAgent}>
              {cloningAgent ? (
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
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={deletingAgent}>
              {deletingAgent ? (
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
        open={!!quickEdit.quickEditTeam}
        onOpenChange={(open) => {
          if (!open) quickEdit.closeEditTeam();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit team &quot;{quickEdit.quickEditTeam?.teamName}&quot;</DialogTitle>
            <DialogDescription>Adjust team capacity settings.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>Max team members</Label>
                <span className="text-xs text-muted-foreground">{quickEdit.maxMembers}</span>
              </div>
              <Slider
                min={2}
                max={10}
                step={1}
                value={[quickEdit.maxMembers]}
                onValueChange={([v]) => {
                  quickEdit.setMaxMembers(v);
                  if (quickEdit.maxConcurrentTasks > v) {
                    quickEdit.setMaxConcurrentTasks(v);
                  }
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>Max concurrent tasks</Label>
                <span className="text-xs text-muted-foreground">
                  {quickEdit.maxConcurrentTasks}
                </span>
              </div>
              <Slider
                min={1}
                max={quickEdit.maxMembers}
                step={1}
                value={[quickEdit.maxConcurrentTasks]}
                onValueChange={([v]) => quickEdit.setMaxConcurrentTasks(v)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="qe-allow-lead-create"
                  checked={quickEdit.allowTeamLeadCreateAgents}
                  onCheckedChange={(checked) =>
                    quickEdit.setAllowTeamLeadCreateAgents(checked === true)
                  }
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
            <Button variant="outline" onClick={() => quickEdit.closeEditTeam()}>
              Cancel
            </Button>
            <Button onClick={() => quickEdit.submit()} disabled={quickEdit.isPending}>
              {quickEdit.isPending ? (
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

      <SessionReadSlideOver
        sessionId={readSlideOverSessionId}
        onClose={() => setReadSlideOverSessionId(null)}
      />
      {customPromptTarget && (
        <CustomPromptPicker
          open={customPromptPickerOpen}
          target={customPromptTarget}
          onOpenChange={setCustomPromptPickerOpen}
        />
      )}
      <ConfirmDialog {...activeSessionDialogProps} />
    </div>
  );
}
