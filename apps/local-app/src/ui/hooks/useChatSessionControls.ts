import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useToast } from '@/ui/hooks/use-toast';
import {
  launchSession,
  restartSession,
  terminateSession,
  restoreSession,
  createSavePoint,
  startFromSavePoint,
  rollbackSession,
  agentSessionTreeKey,
  agentSessionTreeKeyPrefix,
  SessionApiError,
  type ActiveSession,
  type AgentPresenceMap,
  type SavePointAvailability,
  type SessionTreePage,
} from '@/ui/lib/sessions';
import { transcriptQueryKeys } from '@/ui/hooks/useSessionTranscript';
import { holdRollback } from '@/ui/lib/rollback-holds';
import { chatQueryKeys, type AgentOrGuest } from './useChatQueries';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import {
  getMcpProviderDetails,
  isMcpNotConfigured,
  restoreConflictTitle,
  runTrackedOperation,
  savePointConflictTitle,
  useLifecyclePendingTracker,
} from '@/ui/hooks/lifecycle/session-lifecycle-core';

// ============================================
// Types
// ============================================

export interface PendingLaunchAgent {
  agentId: string;
  providerId: string;
  providerName: string;
  options: { attach?: boolean; silent?: boolean };
}

export interface UseChatSessionControlsOptions {
  projectId: string | null;
  selectedAgentId: string | null;
  agentPresence: AgentPresenceMap;
  agents: AgentOrGuest[];
  presenceReady: boolean;
  onInlineTerminalAttach?: (agentId: string, sessionId: string | null) => void;
  onTerminalMenuClose?: () => void;
}

export interface UseChatSessionControlsResult {
  // Loading states
  launchingAgentIds: Record<string, boolean>;
  restartingAgentId: string | null;
  startingAll: boolean;
  terminatingAll: boolean;

  // MCP modal state
  mcpModalOpen: boolean;
  setMcpModalOpen: (open: boolean) => void;
  pendingLaunchAgent: PendingLaunchAgent | null;
  setPendingLaunchAgent: (agent: PendingLaunchAgent | null) => void;

  // Terminate confirm state
  terminateConfirm: { agentId: string; sessionId: string } | null;
  setTerminateConfirm: (confirm: { agentId: string; sessionId: string } | null) => void;
  terminateAllConfirm: boolean;
  setTerminateAllConfirm: (confirm: boolean) => void;

  // Derived state
  offlineAgents: AgentOrGuest[];
  agentsWithSessions: AgentOrGuest[];

  // Handlers
  handleLaunchSession: (
    agentId: string,
    options?: { attach?: boolean; silent?: boolean },
  ) => Promise<ActiveSession | null>;
  handleRestartSession: (agentId: string) => Promise<void>;
  handleRestoreSession: (
    sessionId: string,
    agentId: string,
    replaceRunningSessionId?: string,
    switchToProviderConfigId?: string,
  ) => Promise<void>;
  handleSavePoint: (
    sessionId: string,
    agentId: string,
    availability: SavePointAvailability | undefined,
  ) => Promise<void>;
  handleStartFromSavePoint: (
    savePointId: string,
    agentId: string,
    availability: SavePointAvailability | undefined,
    replaceRunningSessionId?: string,
  ) => Promise<ActiveSession | null>;
  /** Restarts the session at one of its save points on the same row. */
  handleRollbackSession: (
    sessionId: string,
    savePointId: string,
    agentId: string,
    keepCurrent: boolean,
    replaceRunningSessionId: string | undefined,
    savePointLabel: string,
  ) => Promise<void>;
  handleTerminateSession: (agentId: string, sessionId: string) => Promise<void>;
  handleStartAllAgents: () => Promise<void>;
  handleTerminateAllAgents: () => Promise<void>;
  handleMcpConfigured: () => Promise<void>;
  handleVerifyMcp: () => Promise<boolean>;

  // Restore state
  restoringSessionIds: Record<string, boolean>;
  savingSessionIds: Record<string, boolean>;
  forkingSessionIds: Record<string, boolean>;
  /** The session and the chosen save point of each pending rollback. */
  rollingBackSessionIds: Record<string, boolean>;
}

// ============================================
// Hook
// ============================================

export function useChatSessionControls({
  projectId,
  selectedAgentId,
  agentPresence,
  agents,
  presenceReady,
  onInlineTerminalAttach,
  onTerminalMenuClose,
}: UseChatSessionControlsOptions): UseChatSessionControlsResult {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const apiFetch = useFetchFactory();
  const selection = useRef({ projectId, selectedAgentId });
  useEffect(() => {
    selection.current = { projectId, selectedAgentId };
  }, [projectId, selectedAgentId]);

  // Single terminate shares the historical launching projection.
  const pending = useLifecyclePendingTracker();
  const { setAction: setPendingAction, clear: clearPending } = pending;
  const launchingAgentIds = pending.recordOf('launching', 'terminating');
  const restartingAgentId = pending.singleKeyOf('restarting');
  const restoringSessionIds = pending.recordOf('restoring');
  const savingSessionIds = pending.recordOf('saving');
  const forkingSessionIds = pending.recordOf('forking');
  const rollingBackSessionIds = pending.recordOf('rollingBack');
  const [startingAll, setStartingAll] = useState(false);
  const [terminatingAll, setTerminatingAll] = useState(false);

  // MCP modal state
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [pendingLaunchAgent, setPendingLaunchAgent] = useState<PendingLaunchAgent | null>(null);

  // Terminate confirm state
  const [terminateConfirm, setTerminateConfirm] = useState<{
    agentId: string;
    sessionId: string;
  } | null>(null);
  const [terminateAllConfirm, setTerminateAllConfirm] = useState(false);

  // Derived state
  const offlineAgents = useMemo(
    () => (presenceReady ? agents.filter((a) => !a.disabled && !agentPresence[a.id]?.online) : []),
    [presenceReady, agents, agentPresence],
  );

  const agentsWithSessions = useMemo(
    () =>
      presenceReady
        ? agents.filter((a) => agentPresence[a.id]?.online && agentPresence[a.id]?.sessionId)
        : [],
    [presenceReady, agents, agentPresence],
  );

  const primeRunningSessionCache = useCallback(
    async (agentId: string, session: ActiveSession) => {
      if (!projectId) return;

      await Promise.all([
        queryClient.cancelQueries({ queryKey: chatQueryKeys.agentPresence(projectId) }),
        queryClient.cancelQueries({ queryKey: chatQueryKeys.activeSessions(projectId) }),
      ]);

      queryClient.setQueryData<AgentPresenceMap>(
        chatQueryKeys.agentPresence(projectId),
        (previous = {}) => ({
          ...previous,
          [agentId]: {
            ...previous[agentId],
            online: true,
            sessionId: session.id,
          },
        }),
      );

      queryClient.setQueryData<ActiveSession[]>(
        chatQueryKeys.activeSessions(projectId),
        (previous = []) => {
          const sessionAgentId = session.agentId ?? agentId;
          const remaining = previous.filter(
            (item) => item.id !== session.id && item.agentId !== sessionAgentId,
          );
          return [{ ...session, agentId: sessionAgentId }, ...remaining];
        },
      );
    },
    [projectId, queryClient],
  );

  // Launch session handler
  const handleLaunchSession = useCallback(
    async (
      agentId: string,
      { attach = true, silent = false }: { attach?: boolean; silent?: boolean } = {},
    ): Promise<ActiveSession | null> => {
      if (!projectId) {
        if (!silent) {
          toast({
            title: 'Select a project',
            description: 'Choose a project before launching a session.',
            variant: 'destructive',
          });
        }
        return null;
      }
      setPendingAction(agentId, 'launching');
      try {
        const raw = await launchSession(agentId, projectId, { silent }, apiFetch);
        if (!raw || typeof raw !== 'object' || !('id' in raw)) {
          throw new Error('Unexpected response when launching session');
        }

        const session: ActiveSession = {
          id: raw.id,
          epicId: raw.epicId ?? null,
          agentId: raw.agentId ?? agentId,
          tmuxSessionId: raw.tmuxSessionId ?? null,
          status: raw.status ?? 'running',
          startedAt: raw.startedAt,
          endedAt: raw.endedAt ?? null,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
        };

        if (!silent) {
          toast({
            title: 'Session launched',
            description: `Session ${session.id.slice(0, 8)} started.`,
          });
        }

        await primeRunningSessionCache(agentId, session);

        if (attach && selectedAgentId === agentId) {
          onInlineTerminalAttach?.(session.agentId ?? agentId, session.id);
          onTerminalMenuClose?.();
        }

        if (!silent) {
          queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
          queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
        }

        return session;
      } catch (error) {
        // Check if this is an MCP_NOT_CONFIGURED error from the backend
        if (isMcpNotConfigured(error)) {
          const details = getMcpProviderDetails(error);
          queryClient.invalidateQueries({ queryKey: ['preflight'] });

          if (silent) {
            toast({
              title: 'MCP not configured',
              description: `Provider "${details.providerName ?? 'Unknown'}" requires MCP configuration.`,
              variant: 'destructive',
            });
          } else {
            setPendingLaunchAgent({
              agentId,
              providerId: details.providerId ?? '',
              providerName: details.providerName ?? 'Unknown',
              options: { attach, silent },
            });
            setMcpModalOpen(true);
          }
          return null;
        }

        if (!silent) {
          toast({
            title: 'Failed to launch session',
            description:
              error instanceof Error ? error.message : 'Unable to launch session right now.',
            variant: 'destructive',
          });
        }
        return null;
      } finally {
        clearPending(agentId);
      }
    },
    [
      projectId,
      selectedAgentId,
      toast,
      queryClient,
      onInlineTerminalAttach,
      onTerminalMenuClose,
      primeRunningSessionCache,
      apiFetch,
      setPendingAction,
      clearPending,
    ],
  );

  // Restart session handler
  const handleRestartSession = useCallback(
    async (agentId: string) => {
      if (!projectId) {
        toast({
          title: 'Select a project',
          description: 'Choose a project before restarting a session.',
          variant: 'destructive',
        });
        return;
      }
      const presence = agentPresence[agentId];
      const sessionId = presence?.sessionId ?? null;
      setPendingAction(agentId, 'restarting');
      try {
        let session: ActiveSession;
        let terminateWarning: string | undefined;

        if (sessionId) {
          const result = await restartSession(agentId, projectId, sessionId, apiFetch);
          session = result.session;
          terminateWarning = result.terminateWarning;
        } else {
          session = await launchSession(agentId, projectId, undefined, apiFetch);
        }

        if (terminateWarning) {
          toast({
            title: 'Session restarted with warning',
            description: terminateWarning,
            variant: 'destructive',
          });
        } else {
          toast({
            title: sessionId ? 'Session restarted' : 'Session launched',
            description: session ? `Session ${session.id?.slice(0, 8)}` : 'Session started',
          });
        }

        await primeRunningSessionCache(agentId, session);

        queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });

        if (selectedAgentId === agentId) {
          onInlineTerminalAttach?.(agentId, session?.id ?? null);
        }
      } catch (error) {
        toast({
          title: sessionId ? 'Restart failed' : 'Launch failed',
          description: error instanceof Error ? error.message : 'Unable to start session',
          variant: 'destructive',
        });
      } finally {
        clearPending(agentId);
      }
    },
    [
      projectId,
      agentPresence,
      setPendingAction,
      toast,
      primeRunningSessionCache,
      queryClient,
      selectedAgentId,
      apiFetch,
      onInlineTerminalAttach,
      clearPending,
    ],
  );

  const showResumedSession = useCallback(
    async (agentId: string, session: ActiveSession) => {
      if (!projectId) return;
      await primeRunningSessionCache(agentId, session);
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
      // A family session moves between agents, so every agent's tree can change.
      void queryClient.invalidateQueries({ queryKey: agentSessionTreeKeyPrefix });
      if (
        selection.current.projectId === projectId &&
        selection.current.selectedAgentId === agentId
      ) {
        onInlineTerminalAttach?.(agentId, session.id);
        onTerminalMenuClose?.();
      }
    },
    [projectId, primeRunningSessionCache, queryClient, onInlineTerminalAttach, onTerminalMenuClose],
  );

  const handleRestoreSession = useCallback(
    async (
      sessionId: string,
      agentId: string,
      replaceRunningSessionId?: string,
      switchToProviderConfigId?: string,
    ) => {
      if (!projectId || pending.actionFor(sessionId)) return;
      await runTrackedOperation(pending, sessionId, 'restoring', {
        run: async () => {
          const session = await restoreSession(
            sessionId,
            {
              projectId,
              targetAgentId: agentId,
              replaceRunningSessionId,
              switchToProviderConfigId,
            },
            apiFetch,
          );
          toast({
            title: 'Session restored',
            description: `Session ${session.id.slice(0, 8)} is running.`,
          });
          await showResumedSession(agentId, session);
        },
        onError: (error) =>
          toast({
            title: restoreConflictTitle(error),
            description:
              error instanceof Error ? error.message : 'Unable to restore session right now.',
            variant: 'destructive',
          }),
      });
    },
    [projectId, apiFetch, toast, pending, showResumedSession],
  );

  const handleSavePoint = useCallback(
    async (sessionId: string, agentId: string, availability: SavePointAvailability | undefined) => {
      const presence = agentPresence[agentId];
      if (
        !projectId ||
        !presenceReady ||
        !availability?.available ||
        !presence?.online ||
        presence.sessionId !== sessionId ||
        presence.activityState === 'busy' ||
        pending.actionFor(sessionId)
      )
        return;

      await runTrackedOperation(pending, sessionId, 'saving', {
        run: async () => {
          const saved = await createSavePoint(sessionId, projectId, apiFetch);
          const time = new Date(saved.startedAt).toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
          });
          toast({ title: `Saved ${time}` });
          await queryClient.invalidateQueries({ queryKey: agentSessionTreeKeyPrefix });
        },
        onError: (error) =>
          toast({
            title: savePointConflictTitle(error, 'Save point failed'),
            description:
              error instanceof Error ? error.message : 'Unable to save the session right now.',
            variant: 'destructive',
          }),
      });
    },
    [projectId, presenceReady, agentPresence, pending, apiFetch, queryClient, toast],
  );

  const handleStartFromSavePoint = useCallback(
    async (
      savePointId: string,
      agentId: string,
      availability: SavePointAvailability | undefined,
      replaceRunningSessionId?: string,
    ) => {
      if (
        !projectId ||
        !presenceReady ||
        !availability?.available ||
        pending.actionFor(savePointId)
      )
        return null;
      if (
        !replaceRunningSessionId &&
        agentPresence[agentId]?.online &&
        agentPresence[agentId]?.sessionId
      )
        return null;

      return runTrackedOperation(pending, savePointId, 'forking', {
        run: async () => {
          const session = await startFromSavePoint(
            savePointId,
            { projectId, expectedAgentId: agentId, replaceRunningSessionId },
            apiFetch,
          );
          toast({
            title: 'Session forked',
            description: `Session ${session.id.slice(0, 8)} is running.`,
          });
          await showResumedSession(agentId, session);
          return session;
        },
        onError: (error) =>
          toast({
            title: savePointConflictTitle(error, 'Fork failed'),
            description:
              error instanceof Error ? error.message : 'Unable to fork the session right now.',
            variant: 'destructive',
          }),
      });
    },
    [projectId, presenceReady, agentPresence, pending, apiFetch, toast, showResumedSession],
  );

  const handleRollbackSession = useCallback(
    async (
      sessionId: string,
      savePointId: string,
      agentId: string,
      keepCurrent: boolean,
      replaceRunningSessionId: string | undefined,
      savePointLabel: string,
    ) => {
      if (!projectId || pending.actionFor(sessionId) || pending.actionFor(savePointId)) return;
      const treeKey = agentSessionTreeKey(agentId, projectId);
      // The record keeps its ID when a rollback replaces it, so cached pages would show old content.
      const refreshTranscripts = () => {
        const record = queryClient
          .getQueryData<InfiniteData<SessionTreePage>>(treeKey)
          ?.pages.flatMap((page) => page.items)
          .find((node) => node.parentSessionId === sessionId && node.beforeRollback);
        for (const id of record ? [sessionId, record.id] : [sessionId]) {
          void queryClient.invalidateQueries({ queryKey: transcriptQueryKeys.summary(id) });
          void queryClient.invalidateQueries({ queryKey: transcriptQueryKeys.index(id) });
          void queryClient.invalidateQueries({ queryKey: ['transcript-chunk-page', id] });
        }
      };

      setPendingAction(sessionId, 'rollingBack');
      // The row is stopped while the server copies the save point; the hold keeps its window open.
      const releaseHold = holdRollback(sessionId);
      try {
        await runTrackedOperation(pending, savePointId, 'rollingBack', {
          run: async () => {
            const session = await rollbackSession(
              sessionId,
              {
                projectId,
                savePointId,
                keepCurrent,
                expectedAgentId: agentId,
                replaceRunningSessionId,
              },
              apiFetch,
            );
            toast({ title: `Rolled back to ${savePointLabel}` });
            refreshTranscripts();
            await showResumedSession(agentId, session);
          },
          onError: (error) => {
            if (error instanceof SessionApiError && error.hasCode('ROLLBACK_START_FAILED')) {
              toast({
                title: 'Session rolled back but did not start',
                description: 'Use Restore to start it.',
                variant: 'destructive',
              });
              refreshTranscripts();
              void queryClient.invalidateQueries({ queryKey: agentSessionTreeKeyPrefix });
              void queryClient.invalidateQueries({
                queryKey: chatQueryKeys.agentPresence(projectId),
              });
              void queryClient.invalidateQueries({
                queryKey: chatQueryKeys.activeSessions(projectId),
              });
              return;
            }
            toast({
              title: savePointConflictTitle(error, 'Rollback failed'),
              description:
                error instanceof Error
                  ? error.message
                  : 'Unable to roll back the session right now.',
              variant: 'destructive',
            });
          },
        });
      } finally {
        releaseHold();
        clearPending(sessionId);
      }
    },
    [
      projectId,
      pending,
      queryClient,
      setPendingAction,
      clearPending,
      apiFetch,
      toast,
      showResumedSession,
    ],
  );

  // Terminate session handler
  const handleTerminateSession = useCallback(
    async (agentId: string, sessionId: string) => {
      if (!projectId) {
        toast({
          title: 'Select a project',
          description: 'Choose a project before terminating a session.',
          variant: 'destructive',
        });
        return;
      }
      setTerminateConfirm(null);
      setPendingAction(agentId, 'terminating');
      try {
        await terminateSession(sessionId, apiFetch, { expectedAgentId: agentId });
        toast({ title: 'Session terminated', description: 'The session was terminated.' });
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
      } catch (error) {
        toast({
          title: 'Terminate failed',
          description: error instanceof Error ? error.message : 'Unable to terminate session',
          variant: 'destructive',
        });
      } finally {
        clearPending(agentId);
      }
    },
    [projectId, queryClient, toast, apiFetch, setPendingAction, clearPending],
  );

  // Start all agents handler
  const handleStartAllAgents = useCallback(async () => {
    if (!presenceReady || offlineAgents.length === 0) return;

    setStartingAll(true);
    let succeeded = 0;
    let failed = 0;

    try {
      for (const agent of offlineAgents) {
        try {
          const session = await handleLaunchSession(agent.id, { attach: false, silent: true });
          if (session) {
            succeeded++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }
    } finally {
      setStartingAll(false);

      queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });

      if (failed === 0) {
        toast({
          title: 'All agents started',
          description: `${succeeded} session${succeeded !== 1 ? 's' : ''} launched successfully.`,
        });
      } else {
        toast({
          title: 'Batch launch complete',
          description: `${succeeded} started, ${failed} failed.`,
          variant: failed > 0 ? 'destructive' : 'default',
        });
      }
    }
  }, [presenceReady, offlineAgents, handleLaunchSession, queryClient, projectId, toast]);

  // Terminate all agents handler
  const handleTerminateAllAgents = useCallback(async () => {
    if (!presenceReady || agentsWithSessions.length === 0) return;

    setTerminatingAll(true);
    let succeeded = 0;
    let failed = 0;

    try {
      for (const agent of agentsWithSessions) {
        const sessionId = agentPresence[agent.id]?.sessionId;
        if (sessionId) {
          try {
            await terminateSession(sessionId, apiFetch, { expectedAgentId: agent.id });
            succeeded++;
          } catch {
            failed++;
          }
        }
      }
    } finally {
      setTerminatingAll(false);
      setTerminateAllConfirm(false);

      queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });

      if (failed === 0) {
        toast({
          title: 'All sessions terminated',
          description: `${succeeded} session${succeeded !== 1 ? 's' : ''} stopped.`,
        });
      } else {
        toast({
          title: 'Batch terminate complete',
          description: `${succeeded} stopped, ${failed} failed.`,
          variant: 'destructive',
        });
      }
    }
  }, [presenceReady, agentsWithSessions, agentPresence, apiFetch, queryClient, projectId, toast]);

  // MCP configured handler
  const handleMcpConfigured = useCallback(async () => {
    queryClient.invalidateQueries({ queryKey: ['preflight'] });

    if (pendingLaunchAgent && projectId) {
      const { agentId, options } = pendingLaunchAgent;
      const savedOptions = { ...options };
      setPendingLaunchAgent(null);
      await handleLaunchSession(agentId, savedOptions);
    } else {
      setPendingLaunchAgent(null);
    }
  }, [queryClient, pendingLaunchAgent, projectId, handleLaunchSession]);

  // Verify MCP handler
  const handleVerifyMcp = useCallback(async (): Promise<boolean> => {
    queryClient.invalidateQueries({ queryKey: ['preflight'] });
    // Note: This would need access to preflightResult and refetchPreflight
    // For now, return false - the caller should handle verification
    return false;
  }, [queryClient]);

  return {
    // Loading states
    launchingAgentIds,
    restartingAgentId,
    startingAll,
    terminatingAll,

    // MCP modal state
    mcpModalOpen,
    setMcpModalOpen,
    pendingLaunchAgent,
    setPendingLaunchAgent,

    // Terminate confirm state
    terminateConfirm,
    setTerminateConfirm,
    terminateAllConfirm,
    setTerminateAllConfirm,

    // Derived state
    offlineAgents,
    agentsWithSessions,

    // Handlers
    handleLaunchSession,
    handleRestartSession,
    handleRestoreSession,
    handleSavePoint,
    handleStartFromSavePoint,
    handleRollbackSession,
    handleTerminateSession,
    handleStartAllAgents,
    handleTerminateAllAgents,
    handleMcpConfigured,
    handleVerifyMcp,

    // Restore state
    restoringSessionIds,
    savingSessionIds,
    forkingSessionIds,
    rollingBackSessionIds,
  };
}
