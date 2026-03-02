import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/ui/hooks/use-toast';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import { useTerminalWindowManager } from '@/ui/terminal-windows';
import type { WsEnvelope } from '@/ui/lib/socket';
import {
  fetchAgentPresence,
  terminateSession,
  launchSession,
  restartSession,
  SessionApiError,
  type ActiveSession,
  type AgentPresenceMap,
} from '@/ui/lib/sessions';
import {
  TERMINAL_SESSIONS_QUERY_KEY,
  OPEN_TERMINAL_DOCK_EVENT,
} from '@/ui/components/terminal-dock';

// ============================================
// Last-used agent persistence helpers
// ============================================

const LAST_AGENT_STORAGE_KEY = 'devchain:lastAgentByProject';

export function readLastAgentId(projectId: string | null): string | null {
  if (!projectId || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LAST_AGENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed[projectId] === 'string') {
      return parsed[projectId] as string;
    }
  } catch {
    // ignore malformed payloads
  }
  return null;
}

export function writeLastAgentId(projectId: string, agentId: string) {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(LAST_AGENT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('invalid storage payload');
    }
    parsed[projectId] = agentId;
    window.localStorage.setItem(LAST_AGENT_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    window.localStorage.setItem(LAST_AGENT_STORAGE_KEY, JSON.stringify({ [projectId]: agentId }));
  }
}

// ============================================
// Types
// ============================================

export interface PendingMcpLaunch {
  agentId: string;
  providerId: string;
  providerName: string;
  action: 'launch' | 'restart';
  sessionId?: string;
}

export interface UseAgentSessionControlsOptions {
  projectId: string | null;
  refetchPreflight: () => Promise<{
    data?: { providers: Array<{ id: string; mcpStatus?: string }> };
  }>;
}

export interface UseAgentSessionControlsResult {
  // Presence
  agentPresence: AgentPresenceMap;

  // Loading states
  launchingAgentId: string | null;
  terminatingAgentId: string | null;
  restartingAgentId: string | null;

  // Last used agent
  lastUsedAgentId: string | null;

  // MCP modal state
  mcpModalOpen: boolean;
  setMcpModalOpen: (open: boolean) => void;
  pendingMcpLaunch: PendingMcpLaunch | null;
  setPendingMcpLaunch: (pending: PendingMcpLaunch | null) => void;

  // Operations
  handleLaunch: (agentId: string) => void;
  handleRestart: (agentId: string, sessionId: string) => Promise<void>;
  handleTerminate: (agentId: string, sessionId: string) => void;
  handleMcpConfigured: () => Promise<void>;
  handleVerifyMcp: () => Promise<boolean>;
}

// ============================================
// Hook
// ============================================

export function useAgentSessionControls({
  projectId,
  refetchPreflight,
}: UseAgentSessionControlsOptions): UseAgentSessionControlsResult {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const openTerminalWindow = useTerminalWindowManager();
  const terminalSessionsQueryKey = [...TERMINAL_SESSIONS_QUERY_KEY, projectId ?? 'all'] as const;

  // ---- State ----
  const [launchingAgentId, setLaunchingAgentId] = useState<string | null>(null);
  const [terminatingAgentId, setTerminatingAgentId] = useState<string | null>(null);
  const [restartingAgentId, setRestartingAgentId] = useState<string | null>(null);
  const [lastUsedAgentId, setLastUsedAgentId] = useState<string | null>(null);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [pendingMcpLaunch, setPendingMcpLaunch] = useState<PendingMcpLaunch | null>(null);

  // ---- Last used agent sync ----
  useEffect(() => {
    setLastUsedAgentId(readLastAgentId(projectId ?? null));
  }, [projectId]);

  // ---- Presence query ----
  const { data: agentPresence = {} as AgentPresenceMap, refetch: refetchPresence } = useQuery({
    queryKey: ['agent-presence', projectId],
    queryFn: () => fetchAgentPresence(projectId as string),
    enabled: !!projectId,
    refetchInterval: 2000,
  });

  // ---- Realtime presence via socket ----
  useAppSocket(
    {
      message: (envelope: WsEnvelope) => {
        const { topic, type } = envelope;
        if (
          (topic.startsWith('agent/') && type === 'presence') ||
          (topic.startsWith('session/') && type === 'activity')
        ) {
          queryClient.invalidateQueries({ queryKey: ['agent-presence'] });
          if (projectId) {
            queryClient.invalidateQueries({ queryKey: ['agent-presence', projectId] });
          }
          if (projectId) void refetchPresence();
        }
      },
    },
    [queryClient, projectId, refetchPresence],
  );

  // ---- Helper: persist last agent & open terminal dock ----
  const persistAndOpenDock = useCallback(
    (agentId: string) => {
      if (projectId) {
        writeLastAgentId(projectId, agentId);
        setLastUsedAgentId(agentId);
      }
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(OPEN_TERMINAL_DOCK_EVENT));
      }
    },
    [projectId],
  );

  // ---- Helper: update terminal sessions cache ----
  const updateTerminalSessionsCache = useCallback(
    (session: ActiveSession) => {
      queryClient.setQueryData(
        terminalSessionsQueryKey,
        (existing: ActiveSession[] | undefined) => {
          if (!existing || existing.length === 0) return [session];
          const idx = existing.findIndex((s) => s.id === session.id);
          if (idx >= 0) {
            const copy = existing.slice();
            copy[idx] = session;
            return copy;
          }
          return [session, ...existing];
        },
      );
      queryClient.invalidateQueries({ queryKey: terminalSessionsQueryKey });
    },
    [queryClient, terminalSessionsQueryKey],
  );

  // ---- Terminate mutation ----
  const terminateMutation = useMutation({
    mutationFn: (sessionId: string) => terminateSession(sessionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['active-sessions', projectId] });
      queryClient.invalidateQueries({ queryKey: ['agent-presence', projectId] });
      toast({
        title: 'Session terminated',
        description: 'The agent session was terminated successfully.',
      });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Failed to terminate session';
      toast({ title: 'Terminate failed', description: message, variant: 'destructive' });
    },
    onSettled: () => {
      setTerminatingAgentId(null);
    },
  });

  // ---- Launch mutation ----
  const launchMutation = useMutation({
    mutationFn: ({ agentId, pid }: { agentId: string; pid: string }) => launchSession(agentId, pid),
    onMutate: ({ agentId }) => {
      setLaunchingAgentId(agentId);
    },
    onSuccess: (data, variables) => {
      const launchedSession: ActiveSession = {
        id: data.id,
        epicId: data.epicId ?? null,
        agentId: data.agentId ?? variables.agentId,
        tmuxSessionId: data.tmuxSessionId ?? null,
        status: data.status,
        startedAt: data.startedAt,
        endedAt: data.endedAt ?? null,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
      toast({
        title: 'Session launched',
        description: `Session ${launchedSession.id.slice(0, 8)} created for ${variables.agentId}.`,
      });
      openTerminalWindow(launchedSession);
      updateTerminalSessionsCache(launchedSession);
      persistAndOpenDock(variables.agentId);
    },
    onError: (error: unknown, variables) => {
      if (error instanceof SessionApiError && error.hasCode('MCP_NOT_CONFIGURED')) {
        const details = error.payload?.details;
        setPendingMcpLaunch({
          agentId: variables.agentId,
          providerId: details?.providerId ?? '',
          providerName: details?.providerName ?? 'Unknown',
          action: 'launch',
        });
        setMcpModalOpen(true);
        queryClient.invalidateQueries({ queryKey: ['preflight'] });
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Unable to launch session for the agent.';
      toast({ title: 'Launch failed', description: message, variant: 'destructive' });
    },
    onSettled: () => {
      setLaunchingAgentId(null);
    },
  });

  // ---- Launch handler ----
  const handleLaunch = useCallback(
    (agentId: string) => {
      if (!projectId) return;
      launchMutation.mutate({ agentId, pid: projectId });
    },
    [projectId, launchMutation],
  );

  // ---- Restart (async, not via mutation for MCP error try/catch) ----
  const performRestart = useCallback(
    async (agentId: string, sessionId: string) => {
      if (!projectId) return;
      setRestartingAgentId(agentId);
      try {
        const result = await restartSession(agentId, projectId, sessionId);
        const newSession = result.session;
        openTerminalWindow(newSession);
        updateTerminalSessionsCache(newSession);
        queryClient.invalidateQueries({ queryKey: ['agent-presence', projectId] });
        persistAndOpenDock(agentId);

        if (result.terminateWarning) {
          toast({
            title: 'Session restarted with warning',
            description: result.terminateWarning,
            variant: 'destructive',
          });
        } else {
          toast({
            title: 'Session restarted',
            description: `Session ${newSession.id.slice(0, 8)} started successfully.`,
          });
        }
      } catch (e) {
        if (e instanceof SessionApiError && e.hasCode('MCP_NOT_CONFIGURED')) {
          const details = e.payload?.details;
          setPendingMcpLaunch({
            agentId,
            providerId: details?.providerId ?? '',
            providerName: details?.providerName ?? 'Unknown',
            action: 'restart',
            sessionId,
          });
          setMcpModalOpen(true);
          queryClient.invalidateQueries({ queryKey: ['preflight'] });
          return;
        }
        const msg = e instanceof Error ? e.message : 'Failed to restart session';
        toast({ title: 'Restart failed', description: msg, variant: 'destructive' });
      } finally {
        setRestartingAgentId(null);
      }
    },
    [
      projectId,
      queryClient,
      toast,
      openTerminalWindow,
      updateTerminalSessionsCache,
      persistAndOpenDock,
    ],
  );

  const handleRestart = useCallback(
    async (agentId: string, sessionId: string) => {
      await performRestart(agentId, sessionId);
    },
    [performRestart],
  );

  // ---- Terminate handler ----
  const handleTerminate = useCallback(
    (agentId: string, sessionId: string) => {
      setTerminatingAgentId(agentId);
      terminateMutation.mutate(sessionId);
    },
    [terminateMutation],
  );

  // ---- MCP configured handler (retryMcpEnsure) ----
  const handleMcpConfigured = useCallback(async () => {
    queryClient.invalidateQueries({ queryKey: ['preflight'] });
    await refetchPreflight();

    if (pendingMcpLaunch && projectId) {
      if (pendingMcpLaunch.action === 'restart' && pendingMcpLaunch.sessionId) {
        performRestart(pendingMcpLaunch.agentId, pendingMcpLaunch.sessionId);
      } else {
        launchMutation.mutate({
          agentId: pendingMcpLaunch.agentId,
          pid: projectId,
        });
      }
    }
    setPendingMcpLaunch(null);
  }, [queryClient, refetchPreflight, pendingMcpLaunch, projectId, performRestart, launchMutation]);

  // ---- Verify MCP handler ----
  const handleVerifyMcp = useCallback(async (): Promise<boolean> => {
    queryClient.invalidateQueries({ queryKey: ['preflight'] });
    const result = await refetchPreflight();
    if (!pendingMcpLaunch || !result.data) return false;
    const providerCheck = result.data.providers.find((p) => p.id === pendingMcpLaunch.providerId);
    return providerCheck?.mcpStatus === 'pass';
  }, [queryClient, refetchPreflight, pendingMcpLaunch]);

  return {
    agentPresence,
    launchingAgentId,
    terminatingAgentId,
    restartingAgentId,
    lastUsedAgentId,
    mcpModalOpen,
    setMcpModalOpen,
    pendingMcpLaunch,
    setPendingMcpLaunch,
    handleLaunch,
    handleRestart,
    handleTerminate,
    handleMcpConfigured,
    handleVerifyMcp,
  };
}
