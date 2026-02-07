import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/ui/hooks/use-toast';
import {
  launchSession,
  restartSession,
  terminateSession,
  SessionApiError,
  type ActiveSession,
  type AgentPresenceMap,
} from '@/ui/lib/sessions';
import { chatQueryKeys, type AgentOrGuest } from './useChatQueries';

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
  selectedThreadId: string | null;
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
  handleTerminateSession: (agentId: string, sessionId: string) => Promise<void>;
  handleStartAllAgents: () => Promise<void>;
  handleTerminateAllAgents: () => Promise<void>;
  handleMcpConfigured: () => Promise<void>;
  handleVerifyMcp: () => Promise<boolean>;
}

// ============================================
// Hook
// ============================================

export function useChatSessionControls({
  projectId,
  selectedThreadId,
  agentPresence,
  agents,
  presenceReady,
  onInlineTerminalAttach,
  onTerminalMenuClose,
}: UseChatSessionControlsOptions): UseChatSessionControlsResult {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Loading states
  const [launchingAgentIds, setLaunchingAgentIds] = useState<Record<string, boolean>>({});
  const [restartingAgentId, setRestartingAgentId] = useState<string | null>(null);
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
  const offlineAgents = presenceReady ? agents.filter((a) => !agentPresence[a.id]?.online) : [];

  const agentsWithSessions = presenceReady
    ? agents.filter((a) => agentPresence[a.id]?.online && agentPresence[a.id]?.sessionId)
    : [];

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
      if (attach && !selectedThreadId) {
        if (!silent) {
          toast({
            title: 'Select a conversation',
            description: 'Choose a chat thread before attaching an inline terminal.',
            variant: 'destructive',
          });
        }
        return null;
      }

      setLaunchingAgentIds((prev) => ({ ...prev, [agentId]: true }));
      try {
        const raw = await launchSession(agentId, projectId, { silent });
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

        if (attach && selectedThreadId) {
          onInlineTerminalAttach?.(session.agentId ?? agentId, session.id);
          onTerminalMenuClose?.();
        }

        if (!silent) {
          queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
          queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });
        }

        return session;
      } catch (error) {
        if (error instanceof SessionApiError && error.hasCode('CLAUDE_AUTO_COMPACT_ENABLED')) {
          queryClient.invalidateQueries({ queryKey: ['preflight'] });
          toast({
            title: 'Session launch blocked',
            description: 'Claude auto-compact is enabled - see the notification to resolve.',
          });
          return null;
        }

        // Check if this is an MCP_NOT_CONFIGURED error from the backend
        if (error instanceof SessionApiError && error.hasCode('MCP_NOT_CONFIGURED')) {
          const details = error.payload?.details;
          queryClient.invalidateQueries({ queryKey: ['preflight'] });

          if (silent) {
            toast({
              title: 'MCP not configured',
              description: `Provider "${details?.providerName ?? 'Unknown'}" requires MCP configuration.`,
              variant: 'destructive',
            });
          } else {
            setPendingLaunchAgent({
              agentId,
              providerId: details?.providerId ?? '',
              providerName: details?.providerName ?? 'Unknown',
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
        setLaunchingAgentIds((prev) => {
          const next = { ...prev };
          delete next[agentId];
          return next;
        });
      }
    },
    [projectId, selectedThreadId, toast, queryClient, onInlineTerminalAttach, onTerminalMenuClose],
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
      setRestartingAgentId(agentId);
      try {
        let session: ActiveSession;
        let terminateWarning: string | undefined;

        if (sessionId) {
          const result = await restartSession(agentId, projectId, sessionId);
          session = result.session;
          terminateWarning = result.terminateWarning;
        } else {
          session = await launchSession(agentId, projectId);
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

        queryClient.invalidateQueries({ queryKey: chatQueryKeys.agentPresence(projectId) });
        queryClient.invalidateQueries({ queryKey: chatQueryKeys.activeSessions(projectId) });

        if (selectedThreadId) {
          onInlineTerminalAttach?.(agentId, session?.id ?? null);
        }
      } catch (error) {
        if (error instanceof SessionApiError && error.hasCode('CLAUDE_AUTO_COMPACT_ENABLED')) {
          queryClient.invalidateQueries({ queryKey: ['preflight'] });
          toast({
            title: 'Session launch blocked',
            description: 'Claude auto-compact is enabled - see the notification to resolve.',
          });
          return;
        }

        toast({
          title: sessionId ? 'Restart failed' : 'Launch failed',
          description: error instanceof Error ? error.message : 'Unable to start session',
          variant: 'destructive',
        });
      } finally {
        setRestartingAgentId(null);
      }
    },
    [agentPresence, projectId, queryClient, selectedThreadId, onInlineTerminalAttach, toast],
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
      setLaunchingAgentIds((prev) => ({ ...prev, [agentId]: true }));
      try {
        await terminateSession(sessionId);
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
        setLaunchingAgentIds((prev) => {
          const next = { ...prev };
          delete next[agentId];
          return next;
        });
      }
    },
    [projectId, queryClient, toast],
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
            await terminateSession(sessionId);
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
  }, [presenceReady, agentsWithSessions, agentPresence, queryClient, projectId, toast]);

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
    handleTerminateSession,
    handleStartAllAgents,
    handleTerminateAllAgents,
    handleMcpConfigured,
    handleVerifyMcp,
  };
}
