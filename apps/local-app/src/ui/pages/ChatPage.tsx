import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { Loader2, AlertCircle, Terminal as TerminalIcon } from 'lucide-react';
import type { Preset } from '@/ui/lib/preset-types';
import { restartKeyForMain } from '@/ui/lib/restart-keys';
import {
  useTerminalWindowManager,
  useTerminalWindows,
  useWorktreeTerminalWindowManager,
} from '@/ui/terminal-windows';
import { useToastHelpers } from '@/ui/lib/toast-helpers';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useActiveSessionConfirm } from '@/ui/hooks/useActiveSessionConfirm';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { useWorktreeAgents, type WorktreeAgentGroup } from '@/ui/hooks/useWorktreeAgents';
import { useWorktreeSessionControls } from '@/ui/hooks/useWorktreeSessionControls';
import { useTeamQuickEdit } from '@/ui/hooks/chat/useTeamQuickEdit';
import { usePresetApply } from '@/ui/hooks/chat/usePresetApply';
import { useAgentConfigSwitch } from '@/ui/hooks/chat/useAgentConfigSwitch';
import { useAgentAdminActions } from '@/ui/hooks/chat/useAgentAdminActions';
import { useWorktreeSocket } from '@/ui/hooks/useWorktreeSocket';
import {
  useMessagePools,
  isForceEligible,
  ForceConflictError,
  HOLD_REASON_LABELS,
  type ForceDeliveryResult,
} from '@/ui/hooks/chat/useMessagePools';
import {
  useForceDeliveryConfirm,
  type ForceDeliveryTarget,
} from '@/ui/hooks/chat/useForceDeliveryConfirm';

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
import {
  AssignAgentTimeDialog,
  type AssignAgentTimeTarget,
} from '@/ui/components/chat/AssignAgentTimeDialog';
import { Button } from '@/ui/components/ui/button';
import { useAgentTimeBuffers } from '@/ui/hooks/useAgentTimeBuffers';
import { epicTimeQueryKeys, formatEpicTimeMinutes } from '@/ui/lib/epic-time';

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
import { useAgentConsoleUiState } from '@/ui/hooks/useAgentConsoleUiState';
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
import { SessionLifecycleModals } from '@/ui/components/chat/SessionLifecycleModals';
import { PreviousSessionsTable } from '@/ui/components/chat/PreviousSessionsTable';
import { SessionReadSlideOver } from '@/ui/components/chat/SessionReadSlideOver';

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
  mainAgentIdAtSelection: string | null;
}

interface HumanReleaseTarget {
  agentId: string;
  agentName: string;
  messageCount: number;
}

function recordsEqual<T>(left: Readonly<Record<string, T>>, right: Readonly<Record<string, T>>) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && rightKeys.every((key) => left[key] === right[key]);
}

function describeHumanRelease(target: HumanReleaseTarget | null): string {
  if (!target) return '';
  const noun = target.messageCount === 1 ? 'message' : 'messages';
  return `${target.messageCount} queued ${noun} for ${target.agentName} will send when the terminal is quiet.`;
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
  const openTerminalWindow = useTerminalWindowManager();
  const openWorktreeTerminalWindow = useWorktreeTerminalWindowManager();
  const apiFetch = useFetchFactory();
  const { windows: terminalWindows, focusedWindowId } = useTerminalWindows();
  const [mainTerminalHandle, setMainTerminalHandle] = useState<TerminalHandle | null>(null);
  const [worktreeTerminalHandle, setWorktreeTerminalHandle] = useState<TerminalHandle | null>(null);
  const [customPromptPickerOpen, setCustomPromptPickerOpen] = useState(false);
  const [humanReleaseTarget, setHumanReleaseTarget] = useState<HumanReleaseTarget | null>(null);

  // Tick for relative durations (busy badge)
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const { worktreeAgentGroups, worktreeAgentGroupsLoading } = useWorktreeAgents(projectId);
  const [selectedWorktreeAgent, setSelectedWorktreeAgent] = useState<SelectedWorktreeAgent | null>(
    null,
  );

  // ============================================
  // Initialize Hooks
  // ============================================

  const queries = useChatQueries({
    projectId,
    projectRootPath: selectedProject?.rootPath,
  });

  const {
    pools: messagePools,
    releaseHumanHeldMessages,
    releasingAgentId,
    forceDeferredDelivery,
    forcingAgentId,
  } = useMessagePools(projectId);

  // The endpoint recomputes waitingMs on every poll, so the pools array is a
  // fresh reference even when held counts are identical; retain the previous
  // record then, or the sidebar data bundle would churn every poll interval.
  const prevHeldCountsRef = useRef<Record<string, number>>({});
  const humanHeldMessageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const pool of messagePools ?? []) {
      if (pool.humanHeldMessageCount > 0) {
        counts[pool.agentId] = pool.humanHeldMessageCount;
      }
    }
    const previous = prevHeldCountsRef.current;
    if (recordsEqual(previous, counts)) {
      return previous;
    }
    prevHeldCountsRef.current = counts;
    return counts;
  }, [messagePools]);

  const prevReleaseEligibleRef = useRef<Record<string, true>>({});
  const humanHeldReleaseEligibleAgentIds = useMemo(() => {
    const eligible: Record<string, true> = {};
    for (const pool of messagePools ?? []) {
      if (
        pool.humanHeldMessageCount > 0 &&
        pool.humanReleaseEligibleAt !== undefined &&
        pool.humanReleaseEligibleAt <= nowTick
      ) {
        eligible[pool.agentId] = true;
      }
    }
    const previous = prevReleaseEligibleRef.current;
    if (recordsEqual(previous, eligible)) return previous;
    prevReleaseEligibleRef.current = eligible;
    return eligible;
  }, [messagePools, nowTick]);

  const prevForceEligibleRef = useRef<Record<string, true>>({});
  const forceEligibleAgentIds = useMemo(() => {
    const eligible: Record<string, true> = {};
    for (const pool of messagePools ?? []) {
      if (isForceEligible(pool, nowTick)) eligible[pool.agentId] = true;
    }
    const previous = prevForceEligibleRef.current;
    if (recordsEqual(previous, eligible)) return previous;
    prevForceEligibleRef.current = eligible;
    return eligible;
  }, [messagePools, nowTick]);

  const prevHoldReasonLabelsRef = useRef<Record<string, string>>({});
  const holdReasonLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const pool of messagePools ?? []) {
      if (
        pool.holdReason &&
        pool.holdReason !== 'human_draft' &&
        !forceEligibleAgentIds[pool.agentId]
      ) {
        labels[pool.agentId] = HOLD_REASON_LABELS[pool.holdReason];
      }
    }
    const previous = prevHoldReasonLabelsRef.current;
    if (recordsEqual(previous, labels)) return previous;
    prevHoldReasonLabelsRef.current = labels;
    return labels;
  }, [messagePools, forceEligibleAgentIds]);

  const agentUiState = useAgentConsoleUiState({
    projectId,
    agentPresence: queries.agentPresence,
    agents: queries.agents,
    agentsQuerySuccess: queries.agentsQuerySuccess,
  });

  // One project-wide admitted read of claimable agent time; feeds every
  // main-agent row dot and the selected inline-terminal header action.
  const {
    admitted: agentTimeAdmitted,
    snapshot: agentTimeBufferSnapshot,
    minutesByAgentId: unloggedMinutesByAgentId,
  } = useAgentTimeBuffers(projectId);
  const [assignTimeTarget, setAssignTimeTarget] = useState<AssignAgentTimeTarget | null>(null);
  const inlineHeaderRef = useRef<HTMLDivElement | null>(null);

  // Inline terminal attach handler
  const handleInlineTerminalAttach = useCallback(
    (agentId: string, sessionId: string | null) => {
      agentUiState.attachInlineTerminalForAgent(agentId, sessionId);
    },
    [agentUiState],
  );

  // Session controls
  const sessionControls = useChatSessionControls({
    projectId,
    selectedAgentId: agentUiState.selectedAgentId,
    agentPresence: queries.agentPresence,
    agents: queries.agents,
    presenceReady: queries.presenceReady,
    onInlineTerminalAttach: handleInlineTerminalAttach,
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

  // Socket handling - capture socketRef for ESC key interception
  const { socketRef } = useChatSocket({ projectId });

  // ============================================
  // Derived State
  // ============================================

  const { selectedAgent, inlineTerminalState, showInlineTerminal, inlineTerminalSessionId } =
    agentUiState;

  const selectedAgentPresence = selectedAgent ? queries.agentPresence[selectedAgent.id] : undefined;
  const isSelectedAgentOnline = Boolean(
    selectedAgentPresence?.online && selectedAgentPresence.sessionId,
  );

  const inlineTerminalAgentName = inlineTerminalState
    ? (queries.agents.find((a) => a.id === inlineTerminalState.agentId)?.name ?? null)
    : null;
  const inlineTerminalAgentId = inlineTerminalState?.agentId ?? null;
  const inlineTerminalSession = inlineTerminalSessionId
    ? Array.isArray(queries.activeSessions)
      ? queries.activeSessions.find((session) => session.id === inlineTerminalSessionId)
      : undefined
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
  const sessionTranscript = useSessionTranscript(
    inlineTerminalSession ? inlineTerminalSessionId : null,
    {
      enableTranscript: !isPagedTranscriptEnabled() && inlineActiveTab === 'session',
      isSessionRunning: isInlineTerminalSessionRunning,
    },
  );

  // ── Manual buffered-time assignment ──

  const handleOpenAssignTime = useCallback(() => {
    const snapshot = agentTimeBufferSnapshot;
    if (!snapshot || !inlineTerminalAgentId || !agentTimeAdmitted) {
      return;
    }
    const item = snapshot.items.find((entry) => entry.agentId === inlineTerminalAgentId);
    if (!item || !snapshot.capturedAt || item.minutes < 1) {
      return;
    }
    const agentName =
      queries.agents.find((agent) => agent.id === inlineTerminalAgentId)?.name ??
      inlineTerminalAgentId;
    setAssignTimeTarget({
      agentId: item.agentId,
      agentName,
      capturedAt: snapshot.capturedAt,
      snapshotToken: item.snapshotToken,
      durationMs: item.durationMs,
      minutes: item.minutes,
      segmentCount: item.segmentCount,
      oldestActivityAt: item.oldestActivityAt,
      newestActivityAt: item.newestActivityAt,
    });
  }, [agentTimeAdmitted, agentTimeBufferSnapshot, inlineTerminalAgentId, queries.agents]);

  // Resolves after the dialog unmounts: its Radix focus restoration must not
  // override the success target. The trigger action may already be gone;
  // never focus a detached control — Terminal tab + inline terminal → the
  // terminal itself, otherwise the stable header root.
  const restorePostDialogFocus = useCallback(() => {
    window.setTimeout(() => {
      if (inlineActiveTab === 'terminal' && !isInlineSessionWindowOpen && mainTerminalHandle) {
        mainTerminalHandle.focus();
      } else {
        inlineHeaderRef.current?.focus();
      }
    }, 0);
  }, [inlineActiveTab, isInlineSessionWindowOpen, mainTerminalHandle]);

  const handleAssignTimeSuccess = useCallback(
    (target: AssignAgentTimeTarget, epic: { id: string; title: string }) => {
      setAssignTimeTarget(null);
      void queryClient.invalidateQueries({ queryKey: epicTimeQueryKeys.bufferRoot() });
      void queryClient.invalidateQueries({ queryKey: epicTimeQueryKeys.detailRoot() });
      void queryClient.invalidateQueries({ queryKey: epicTimeQueryKeys.batchRoot() });
      toast({
        title: 'Time logged',
        description: `Logged ${formatEpicTimeMinutes(target.minutes)} to ${epic.title}.`,
      });
      restorePostDialogFocus();
    },
    [queryClient, restorePostDialogFocus, toast],
  );

  // Reset discards the unlogged balance without an Epic: only the buffer
  // family changes (Epic-bound totals are untouched) and no time-logged
  // announcement fires — the closed dialog and refreshed markers are the
  // whole feedback.
  const handleResetTimeSuccess = useCallback(() => {
    setAssignTimeTarget(null);
    void queryClient.invalidateQueries({ queryKey: epicTimeQueryKeys.bufferRoot() });
    restorePostDialogFocus();
  }, [queryClient, restorePostDialogFocus]);

  const selectedInlineUnloggedMinutes = inlineTerminalAgentId
    ? (unloggedMinutesByAgentId[inlineTerminalAgentId] ?? 0)
    : 0;
  // Capability, not amount: declared whenever the main runtime is admitted so
  // the header menu keeps its checkbox even at zero or hidden amounts.
  const inlineUnloggedTime =
    agentTimeAdmitted && inlineTerminalAgentId
      ? {
          minutes: selectedInlineUnloggedMinutes,
          onAssign: handleOpenAssignTime,
        }
      : null;

  // ============================================
  // Handlers
  // ============================================

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

      setSelectedWorktreeAgent({
        worktreeName: group.name,
        agentId,
        group,
        mainAgentIdAtSelection: agentUiState.selectedAgentId,
      });
    },
    [agentUiState.selectedAgentId, toast],
  );

  const handleOpenHumanRelease = useCallback(
    (agentId: string) => {
      const pool = messagePools?.find((candidate) => candidate.agentId === agentId);
      if (!pool || pool.humanHeldMessageCount <= 0) return;
      setHumanReleaseTarget({
        agentId,
        agentName: pool.agentName,
        messageCount: pool.humanHeldMessageCount,
      });
    },
    [messagePools],
  );

  const handleConfirmHumanRelease = useCallback(() => {
    if (!humanReleaseTarget) return;
    void releaseHumanHeldMessages(humanReleaseTarget.agentId)
      .then(() => {
        setHumanReleaseTarget(null);
        toast({
          title: 'Queued messages released',
          description: 'Delivery will begin after the terminal remains quiet for two seconds.',
        });
      })
      .catch((error: unknown) => {
        toast({
          title: 'Queued messages are still held',
          description: error instanceof Error ? error.message : 'Release failed.',
          variant: 'destructive',
        });
      });
  }, [humanReleaseTarget, releaseHumanHeldMessages, toast]);

  const handleForceDeliveryResult = useCallback(
    (result: ForceDeliveryResult, target: ForceDeliveryTarget) => {
      const resultMessages: Record<
        string,
        { title: string; description: string; variant?: 'destructive' }
      > = {
        delivered: {
          title: 'Messages sent',
          description: `${target.messageCount} message${target.messageCount === 1 ? '' : 's'} delivered to the terminal.`,
        },
        unconfirmed: {
          title: 'Delivery unconfirmed',
          description: 'Messages were pasted but terminal confirmation timed out.',
        },
        deferred: {
          title: 'Messages still queued',
          description: 'Input or context changed before delivery could start.',
        },
        failed: {
          title: 'Delivery failed',
          description: result.reason ?? 'An error occurred during delivery.',
          variant: 'destructive',
        },
      };
      toast(resultMessages[result.status] ?? resultMessages.failed);
    },
    [toast],
  );

  const handleForceDeliveryError = useCallback(
    (error: unknown) => {
      if (error instanceof ForceConflictError) {
        toast({
          title: 'Queue changed',
          description: 'Review and confirm again.',
        });
        return;
      }
      toast({
        title: 'Send now failed',
        description: error instanceof Error ? error.message : 'Request failed.',
        variant: 'destructive',
      });
    },
    [toast],
  );

  const forceDeliveryConfirm = useForceDeliveryConfirm({
    pools: messagePools,
    now: nowTick,
    forceDeferredDelivery,
    forcingAgentId,
    onResult: handleForceDeliveryResult,
    onError: handleForceDeliveryError,
  });
  const openForceDeliveryConfirm = forceDeliveryConfirm.open;

  const handleOpenForceDelivery = useCallback(
    (agentId: string) => {
      openForceDeliveryConfirm(messagePools?.find((p) => p.agentId === agentId));
    },
    [messagePools, openForceDeliveryConfirm],
  );

  const handleSelectMainAgent = useCallback(
    (agentId: string) => {
      setSelectedWorktreeAgent(null);
      agentUiState.handleSelectAgent(agentId);
    },
    [agentUiState],
  );

  useEffect(() => {
    if (!selectedWorktreeAgent) {
      return;
    }

    if (
      selectedWorktreeAgent.mainAgentIdAtSelection === null &&
      agentUiState.selectedAgentId !== null
    ) {
      setSelectedWorktreeAgent({
        ...selectedWorktreeAgent,
        mainAgentIdAtSelection: agentUiState.selectedAgentId,
      });
      return;
    }

    if (agentUiState.selectedAgentId !== selectedWorktreeAgent.mainAgentIdAtSelection) {
      setSelectedWorktreeAgent(null);
    }
  }, [agentUiState.selectedAgentId, selectedWorktreeAgent]);

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

  const handleOpenTerminal = useCallback(
    (agentId: string) => {
      const presence = queries.agentPresence[agentId];
      if (!presence?.online || !presence.sessionId) return;

      const session = queries.activeSessions.find((s) => s.id === presence.sessionId);
      if (session) {
        openTerminalWindow(session);
      }
    },
    [queries.agentPresence, queries.activeSessions, openTerminalWindow],
  );

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
      if (customPromptPickerOpen) {
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
  }, [customPromptPickerOpen, showInlineTerminal, inlineTerminalSessionId, focusedWindowId]);

  // ============================================
  // Render CTAs
  // ============================================

  const shouldShowDirectLaunchCta = Boolean(
    queries.presenceReady && selectedAgent && !isSelectedAgentOnline,
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
              Launch a session to open this agent&apos;s terminal.
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
              'Launch Session'
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
      presenceReady: queries.presenceReady,
      offlineAgents: sessionControls.offlineAgents,
      agentsWithSessions: sessionControls.agentsWithSessions,
      agentsLoading: queries.agentsLoading,
      agentsError: queries.agentsError,
      selectedAgentId: agentUiState.selectedAgentId,
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
      humanHeldMessageCounts,
      humanHeldReleaseEligibleAgentIds,
      forceEligibleAgentIds,
      holdReasonLabels,
      unloggedTimeMinutes: unloggedMinutesByAgentId,
    }),
    [
      projectId,
      queries.agents,
      queries.guests,
      worktreeAgentGroups,
      worktreeAgentGroupsLoading,
      queries.agentPresence,
      queries.presenceReady,
      sessionControls.offlineAgents,
      sessionControls.agentsWithSessions,
      queries.agentsLoading,
      queries.agentsError,
      agentUiState.selectedAgentId,
      selectedWorktreeAgent,
      hasSelectedProject,
      queries.getProviderForAgent,
      validatedPresets,
      activePreset,
      queries.profiles,
      humanHeldMessageCounts,
      humanHeldReleaseEligibleAgentIds,
      forceEligibleAgentIds,
      holdReasonLabels,
      unloggedMinutesByAgentId,
    ],
  );

  const sidebarSessionController = useMemo<ChatSidebarSessionController>(
    () => ({
      launchingAgentIds: sessionControls.launchingAgentIds,
      restartingAgentId: sessionControls.restartingAgentId,
      startingAll: sessionControls.startingAll,
      terminatingAll: sessionControls.terminatingAll,
      onSelectAgent: handleSelectMainAgent,
      onLaunchWorktreeAgentChat: handleLaunchWorktreeAgentChat,
      onLaunchWorktreeSession: handleLaunchWorktreeSession,
      onRestartWorktreeSession: handleRestartWorktreeSession,
      onTerminateWorktreeSession: handleTerminateWorktreeSession,
      onStartAllAgents: sessionControls.handleStartAllAgents,
      onTerminateAllConfirm: () => sessionControls.setTerminateAllConfirm(true),
      onLaunchSession: sessionControls.handleLaunchSession,
      onRestartSession: handleRestartSessionWithClear,
      onTerminateConfirm: (agentId, sessionId) =>
        sessionControls.setTerminateConfirm({ agentId, sessionId }),
      onReleaseHeldMessages: handleOpenHumanRelease,
      onForceDelivery: handleOpenForceDelivery,
      forcingAgentId,
      releasingHeldAgentId: releasingAgentId,
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
    }),
    [
      sessionControls.launchingAgentIds,
      sessionControls.restartingAgentId,
      sessionControls.startingAll,
      sessionControls.terminatingAll,
      handleSelectMainAgent,
      handleLaunchWorktreeAgentChat,
      handleLaunchWorktreeSession,
      handleRestartWorktreeSession,
      handleTerminateWorktreeSession,
      sessionControls.handleStartAllAgents,
      sessionControls.setTerminateAllConfirm,
      sessionControls.handleLaunchSession,
      handleRestartSessionWithClear,
      sessionControls.setTerminateConfirm,
      handleOpenHumanRelease,
      handleOpenForceDelivery,
      releasingAgentId,
      forcingAgentId,
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
          Use the project selector in the header to choose a project and open an agent terminal.
        </p>
      </div>
    );
  }

  function renderConsoleContent(): React.ReactNode {
    if (selectedWorktreeAgent) {
      return (
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
      );
    }

    if (!selectedAgent) {
      return (
        <div className="flex flex-1 items-center justify-center text-center">
          <div>
            <TerminalIcon className="mx-auto mb-4 h-16 w-16 text-muted-foreground" />
            <h2 className="text-xl font-semibold">No agent selected</h2>
            <p className="text-muted-foreground">Select an agent to open its terminal.</p>
          </div>
        </div>
      );
    }

    if (isSelectedAgentOnline && inlineTerminalSessionId) {
      return (
        <div className="flex flex-1 min-h-0 flex-col p-4">
          <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-terminal text-terminal-foreground shadow-sm">
            <InlineTerminalHeader
              agentName={inlineTerminalAgentName}
              showChatToggle={false}
              onOpenWindow={
                inlineTerminalAgentId ? () => handleOpenTerminal(inlineTerminalAgentId) : undefined
              }
              onOpenPrompts={canOpenMainCustomPrompts ? handleOpenCustomPrompts : undefined}
              activeTab={inlineActiveTab}
              onTabChange={handleInlineTabChange}
              hasTranscript={Boolean(inlineTerminalSession)}
              sessionId={inlineTerminalSessionId}
              sessionName={inlineTerminalSessionName}
              projectId={projectId}
              unloggedTime={inlineUnloggedTime}
              headerRef={inlineHeaderRef}
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
      );
    }

    return (
      <div
        className="flex flex-1 items-start justify-center overflow-y-auto p-6"
        aria-live="polite"
      >
        <div className="w-full max-w-4xl">
          {directLaunchCta ?? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading session state…
            </div>
          )}
        </div>
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
      <div className="flex flex-1 flex-col">{renderConsoleContent()}</div>

      <SessionLifecycleModals
        terminateConfirm={sessionControls.terminateConfirm}
        setTerminateConfirm={sessionControls.setTerminateConfirm}
        terminateAllConfirm={sessionControls.terminateAllConfirm}
        setTerminateAllConfirm={sessionControls.setTerminateAllConfirm}
        mcpModalOpen={sessionControls.mcpModalOpen}
        setMcpModalOpen={sessionControls.setMcpModalOpen}
        agentsWithSessions={sessionControls.agentsWithSessions}
        pendingLaunchAgent={sessionControls.pendingLaunchAgent}
        setPendingLaunchAgent={sessionControls.setPendingLaunchAgent}
        projectRootPath={selectedProject?.rootPath}
        hasSelectedProject={hasSelectedProject}
        onTerminateSession={handleTerminateSessionWithClear}
        onTerminateAllAgents={handleTerminateAllAgentsWithClear}
        onMcpConfigured={sessionControls.handleMcpConfigured}
        onVerifyMcp={handleVerifyMcp}
        launchingAgentIds={sessionControls.launchingAgentIds}
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
      <AssignAgentTimeDialog
        open={assignTimeTarget !== null}
        projectId={projectId}
        target={assignTimeTarget}
        onCancel={() => setAssignTimeTarget(null)}
        onSuccess={handleAssignTimeSuccess}
        onReset={handleResetTimeSuccess}
      />
      {customPromptTarget && (
        <CustomPromptPicker
          open={customPromptPickerOpen}
          target={customPromptTarget}
          onOpenChange={setCustomPromptPickerOpen}
        />
      )}
      <ConfirmDialog
        open={humanReleaseTarget !== null}
        onOpenChange={(open) => {
          if (!open && releasingAgentId === null) setHumanReleaseTarget(null);
        }}
        onConfirm={handleConfirmHumanRelease}
        title="Release queued messages, my draft is clear"
        description={describeHumanRelease(humanReleaseTarget)}
        confirmText="Yes"
        cancelText="No"
        loading={releasingAgentId === humanReleaseTarget?.agentId}
      />
      <ConfirmDialog {...forceDeliveryConfirm.dialogProps} />
      <ConfirmDialog {...activeSessionDialogProps} />
    </div>
  );
}
