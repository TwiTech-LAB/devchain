import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Terminal, type TerminalHandle } from '@/ui/components/Terminal';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useWorktreeSocket } from '@/ui/hooks/useWorktreeSocket';
import { TERMINAL_SESSIONS_QUERY_KEY } from '@/ui/components/terminal-dock/TerminalDock';
import {
  type ActiveSession,
  fetchAgentSummary,
  fetchEpicSummary,
  fetchProfileSummary,
  fetchProjectSummary,
  fetchProviderSummary,
  renameSession,
  terminateSession,
} from '@/ui/lib/sessions';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { getProviderIconDataUri } from '@/ui/lib/providers';
import {
  useTerminalWindows,
  type TerminalWindowDetail,
  type TerminalWindowMenuItem,
} from './TerminalWindowsContext';

function shortSessionId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

interface TerminalSessionWindowContentProps {
  session: ActiveSession;
  onRequestClose: () => void;
}

export function TerminalSessionWindowContent({
  session,
  onRequestClose,
}: TerminalSessionWindowContentProps) {
  const handleRef = useRef<TerminalHandle | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { selectedProjectId } = useSelectedProject();
  const { updateWindowMeta, setWindowHandle } = useTerminalWindows();
  const apiFetch = useFetchFactory();
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(session.name ?? '');
  const [copiedId, setCopiedId] = useState(false);
  const closingRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const terminalSessionsQueryKey = useMemo(
    () => [...TERMINAL_SESSIONS_QUERY_KEY, selectedProjectId ?? 'all'] as const,
    [selectedProjectId],
  );

  // Local display name — source-of-truth for this window's rename UX.
  // Cache is a sync channel for cross-surface updates, not the primary source.
  // Remediation: R4 (epic 5b9c46e1) — local state avoids inserting into the
  // dock cache which would create phantom entries.
  const [windowName, setWindowName] = useState<string | null>(session.name ?? null);

  const { data: cachedSessionName } = useQuery({
    queryKey: terminalSessionsQueryKey,
    queryFn: () => queryClient.getQueryData<ActiveSession[]>(terminalSessionsQueryKey) ?? [],
    select: (data): string | null => {
      const found = data.find((s) => s.id === session.id);
      return found?.name ?? null;
    },
    enabled: true,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // Intentionally omit windowName from deps to avoid sync loops.
  useEffect(() => {
    if (cachedSessionName != null && cachedSessionName !== windowName) {
      setWindowName(cachedSessionName);
    }
  }, [cachedSessionName]); // eslint-disable-line

  const { data: epic } = useQuery({
    queryKey: ['terminal-window', 'epic', session.epicId],
    queryFn: () => fetchEpicSummary(session.epicId!, apiFetch),
    enabled: Boolean(session.epicId),
    staleTime: 2 * 60 * 1000, // 2 minutes - epic titles can change
    gcTime: 5 * 60 * 1000,
  });

  const { data: agent } = useQuery({
    queryKey: ['terminal-window', 'agent', session.agentId],
    queryFn: () => fetchAgentSummary(session.agentId!, apiFetch),
    enabled: Boolean(session.agentId),
    staleTime: 5 * 60 * 1000, // 5 minutes - agent data rarely changes
    gcTime: 10 * 60 * 1000,
  });

  // Profile and provider queries only run when agent.providerName is not available (fallback for older servers)
  const needsProviderFetch = Boolean(agent?.profileId && !agent?.providerName);
  const { data: profile } = useQuery({
    queryKey: ['terminal-window', 'profile', agent?.profileId],
    queryFn: () => fetchProfileSummary(agent!.profileId, apiFetch),
    enabled: needsProviderFetch,
    staleTime: 10 * 60 * 1000, // 10 minutes - profiles rarely change
    gcTime: 30 * 60 * 1000,
  });

  const { data: provider } = useQuery({
    queryKey: ['terminal-window', 'provider', profile?.providerId],
    queryFn: () => fetchProviderSummary(profile!.providerId, apiFetch),
    enabled: Boolean(profile?.providerId && !agent?.providerName),
    staleTime: 60 * 60 * 1000, // 1 hour - providers almost never change
    gcTime: 24 * 60 * 60 * 1000, // 24 hours
  });

  // Use providerName from agent (enriched) or fallback to provider chain
  const resolvedProviderName = agent?.providerName ?? provider?.name;

  const { data: project } = useQuery({
    queryKey: ['terminal-window', 'project', epic?.projectId],
    queryFn: () => fetchProjectSummary(epic!.projectId, apiFetch),
    enabled: Boolean(epic?.projectId),
    staleTime: 10 * 60 * 1000, // 10 minutes - project names rarely change
    gcTime: 30 * 60 * 1000,
  });

  const handleCopyTmux = useCallback(async () => {
    if (!session.tmuxSessionId) {
      toast({
        title: 'No tmux session id',
        description: 'This session has not published a tmux id yet.',
        variant: 'destructive',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(session.tmuxSessionId);
      toast({
        title: 'Copied tmux id',
        description: `${session.tmuxSessionId} copied to clipboard.`,
      });
    } catch (error) {
      toast({
        title: 'Copy failed',
        description:
          error instanceof Error
            ? error.message
            : 'Clipboard access is unavailable in this context.',
        variant: 'destructive',
      });
    }
  }, [session.tmuxSessionId, toast]);

  const handleCopyTmuxCommand = useCallback(async () => {
    if (!session.tmuxSessionId) {
      toast({
        title: 'No tmux session id',
        description: 'This session has not published a tmux id yet.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const command = `tmux a -t ${session.tmuxSessionId}`;
      await navigator.clipboard.writeText(command);
      toast({
        title: 'Copied tmux command',
        description: `${command} copied to clipboard.`,
      });
    } catch (error) {
      toast({
        title: 'Copy failed',
        description:
          error instanceof Error
            ? error.message
            : 'Clipboard access is unavailable in this context.',
        variant: 'destructive',
      });
    }
  }, [session.tmuxSessionId, toast]);

  const displayName = windowName ?? shortSessionId(session.id);

  const handleCopySessionId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(session.id);
      setCopiedId(true);
      toast({ description: 'Session ID copied.' });
      setTimeout(() => setCopiedId(false), 2000);
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  }, [session.id, toast]);

  const handleRenameSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim() || null;
      setIsRenaming(false);

      const previousName = windowName;
      if (trimmed === previousName) return;

      setWindowName(trimmed);

      const queryKey = terminalSessionsQueryKey;
      queryClient.setQueryData<ActiveSession[]>(queryKey, (old) => {
        if (!old) return old;
        return old.map((s) => (s.id === session.id ? { ...s, name: trimmed } : s));
      });

      renameSession(session.id, selectedProjectId ?? '', trimmed, apiFetch).catch((err) => {
        setWindowName(previousName);
        queryClient.setQueryData<ActiveSession[]>(queryKey, (old) => {
          if (!old) return old;
          return old.map((s) => (s.id === session.id ? { ...s, name: previousName } : s));
        });
        toast({
          title: 'Rename failed',
          description: err instanceof Error ? err.message : 'Could not rename session.',
          variant: 'destructive',
        });
      });
    },
    [queryClient, selectedProjectId, session.id, windowName, terminalSessionsQueryKey, toast],
  );

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleRenameSubmit(draftName);
      } else if (e.key === 'Escape') {
        setIsRenaming(false);
        setDraftName(windowName ?? '');
      }
    },
    [draftName, handleRenameSubmit, windowName],
  );

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const terminateMutation = useMutation({
    mutationFn: async () => {
      await terminateSession(session.id, '', apiFetch);
      await queryClient.invalidateQueries({ queryKey: terminalSessionsQueryKey });
    },
    onSuccess: () => {
      toast({
        title: 'Session terminated',
        description: `Session ${displayName} has been terminated.`,
      });
      if (!closingRef.current) {
        closingRef.current = true;
        onRequestClose();
      }
    },
    onError: (error: unknown) => {
      toast({
        title: 'Terminate failed',
        description:
          error instanceof Error ? error.message : 'Unable to terminate the session right now.',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setConfirmTerminate(false);
    },
  });

  const requestTerminate = useCallback(() => setConfirmTerminate(true), []);

  const providerIconUri = useMemo(
    () => getProviderIconDataUri(resolvedProviderName),
    [resolvedProviderName],
  );

  const details = useMemo(
    () =>
      [
        {
          label: 'Session',
          value: displayName,
          title: session.id,
          interactive: true,
          sessionId: session.id,
          isRenaming,
          draftName,
          renameInputRef,
          onRenameStart: () => {
            setDraftName(windowName ?? '');
            setIsRenaming(true);
          },
          onDraftChange: setDraftName,
          onRenameKeyDown: handleRenameKeyDown,
          onRenameBlur: () => handleRenameSubmit(draftName),
          onCopyId: handleCopySessionId,
          copiedId,
        },
        project?.name
          ? {
              label: 'Project',
              value: project.name,
              title: project.name,
            }
          : null,
        epic?.title
          ? {
              label: 'Epic',
              value: epic.title,
              title: epic.title,
            }
          : null,
        {
          label: 'Agent',
          value: agent?.name ?? 'Unassigned',
          title: agent?.name ?? undefined,
        },
        providerIconUri
          ? {
              label: 'providerIcon',
              value: providerIconUri,
              hidden: true,
            }
          : null,
      ].filter(Boolean) as TerminalWindowDetail[],
    [
      session.id,
      displayName,
      isRenaming,
      draftName,
      copiedId,
      agent?.name,
      project?.name,
      epic?.title,
      providerIconUri,
      handleRenameKeyDown,
      handleRenameSubmit,
      handleCopySessionId,
      windowName,
    ],
  );

  const menuItems: TerminalWindowMenuItem[] = useMemo(
    () => [
      {
        id: 'copy-tmux',
        label: 'Copy tmux id',
        onSelect: handleCopyTmux,
        disabled: !session.tmuxSessionId,
      },
      {
        id: 'copy-tmux-command',
        label: 'Copy tmux attach command',
        onSelect: handleCopyTmuxCommand,
        disabled: !session.tmuxSessionId,
      },
      {
        id: 'terminate-session',
        label: 'Terminate session',
        tone: 'destructive',
        onSelect: requestTerminate,
      },
    ],
    [handleCopyTmux, handleCopyTmuxCommand, session.tmuxSessionId, requestTerminate],
  );

  const publishWindowMeta = useCallback(
    (handle: TerminalHandle | null) => {
      const title = epic?.title ?? displayName ?? `Session ${shortSessionId(session.id)}`;
      const subtitleParts: string[] = [];
      if (agent?.name) {
        subtitleParts.push(agent.name);
      } else {
        subtitleParts.push('Unassigned agent');
      }
      if (project?.name) {
        subtitleParts.push(project.name);
      }

      const effectiveMenuItems: TerminalWindowMenuItem[] = [
        ...menuItems,
        {
          id: 'clear-buffer',
          label: 'Clear terminal buffer',
          onSelect: () => handle?.clear?.(),
          disabled: !handle,
          shortcut: 'Ctrl+K',
        },
      ];

      updateWindowMeta(session.id, {
        title,
        subtitle: subtitleParts.filter(Boolean).join(' • ') || undefined,
        menuItems: effectiveMenuItems,
        details,
      });
    },
    [
      agent?.name,
      displayName,
      epic?.title,
      project?.name,
      session.id,
      details,
      menuItems,
      updateWindowMeta,
    ],
  );

  useEffect(() => {
    publishWindowMeta(handleRef.current);
  }, [publishWindowMeta]);

  const handleTerminalRef = useCallback(
    (handle: TerminalHandle | null) => {
      handleRef.current = handle;
      setWindowHandle(session.id, handle);
      publishWindowMeta(handle);
    },
    [publishWindowMeta, session.id, setWindowHandle],
  );

  const handleSessionEnded = useCallback(() => {
    if (closingRef.current) {
      return;
    }
    toast({
      title: 'Session ended',
      description: `Session ${displayName} has completed.`,
    });
    closingRef.current = true;
    onRequestClose();
  }, [onRequestClose, session.id, toast]);

  return (
    <>
      <Terminal
        ref={handleTerminalRef}
        sessionId={session.id}
        socket={null}
        onSessionEnded={handleSessionEnded}
      />
      <ConfirmDialog
        open={confirmTerminate}
        onOpenChange={setConfirmTerminate}
        onConfirm={() => terminateMutation.mutate()}
        title="Terminate session"
        description={`Terminate session ${displayName}? This will stop the underlying tmux pane.`}
        confirmText="Terminate"
        variant="destructive"
        loading={terminateMutation.isPending}
      />
    </>
  );
}

export function useTerminalWindowManager() {
  const { openWindow, closeWindow, focusWindow } = useTerminalWindows();

  return useCallback(
    (session: ActiveSession) => {
      openWindow({
        id: session.id,
        sessionId: session.id,
        title: session.name ?? `Session ${shortSessionId(session.id)}`,
        subtitle: 'Loading metadata…',
        menuItems: [],
        details: [
          {
            label: 'Session',
            value: session.name ?? shortSessionId(session.id),
            title: session.id,
          },
        ],
        content: (
          <TerminalSessionWindowContent
            key={session.id}
            session={session}
            onRequestClose={() => closeWindow(session.id)}
          />
        ),
      });

      focusWindow(session.id);
    },
    [closeWindow, focusWindow, openWindow],
  );
}

interface WorktreeTerminalWindowContentProps {
  windowId: string;
  sessionId: string;
  agentName: string;
  worktreeName: string;
  onRequestClose: () => void;
}

function WorktreeTerminalWindowContent({
  windowId,
  sessionId,
  agentName,
  worktreeName,
  onRequestClose,
}: WorktreeTerminalWindowContentProps) {
  const { socket } = useWorktreeSocket(worktreeName);
  const { updateWindowMeta, setWindowHandle } = useTerminalWindows();
  const handleRef = useRef<TerminalHandle | null>(null);
  const [connectionLabel, setConnectionLabel] = useState<string>(
    socket.connected ? 'Connected' : 'Connecting',
  );

  const publishWindowMeta = useCallback(
    (handle: TerminalHandle | null) => {
      const details: TerminalWindowDetail[] = [
        {
          label: 'Agent',
          value: agentName,
          title: agentName,
        },
        {
          label: 'Worktree',
          value: worktreeName,
          title: worktreeName,
        },
        {
          label: 'Connection',
          value: connectionLabel,
        },
      ];

      const menuItems: TerminalWindowMenuItem[] = [
        {
          id: 'clear-buffer',
          label: 'Clear terminal buffer',
          onSelect: () => handle?.clear?.(),
          disabled: !handle,
          shortcut: 'Ctrl+K',
        },
      ];

      updateWindowMeta(windowId, {
        title: `${agentName} — ${worktreeName}`,
        subtitle: 'Worktree terminal',
        details,
        menuItems,
      });
    },
    [agentName, connectionLabel, updateWindowMeta, windowId, worktreeName],
  );

  useEffect(() => {
    publishWindowMeta(handleRef.current);
  }, [publishWindowMeta]);

  useEffect(() => {
    const onConnect = () => setConnectionLabel('Connected');
    const onDisconnect = () => setConnectionLabel('Disconnected');

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [socket]);

  const handleTerminalRef = useCallback(
    (handle: TerminalHandle | null) => {
      handleRef.current = handle;
      setWindowHandle(windowId, handle);
      publishWindowMeta(handle);
    },
    [publishWindowMeta, setWindowHandle, windowId],
  );

  const handleSessionEnded = useCallback(() => {
    onRequestClose();
  }, [onRequestClose]);

  return (
    <Terminal
      ref={handleTerminalRef}
      sessionId={sessionId}
      socket={socket}
      onSessionEnded={handleSessionEnded}
    />
  );
}

export interface WorktreeTerminalWindowInput {
  sessionId: string;
  agentName: string;
  worktreeName: string;
}

export function useWorktreeTerminalWindowManager() {
  const { openWindow, closeWindow, focusWindow } = useTerminalWindows();

  return useCallback(
    ({ sessionId, agentName, worktreeName }: WorktreeTerminalWindowInput) => {
      const windowId = `worktree:${encodeURIComponent(worktreeName)}:${sessionId}`;

      openWindow({
        id: windowId,
        title: `${agentName} — ${worktreeName}`,
        subtitle: 'Worktree terminal',
        menuItems: [],
        details: [
          {
            label: 'Agent',
            value: agentName,
            title: agentName,
          },
          {
            label: 'Worktree',
            value: worktreeName,
            title: worktreeName,
          },
          {
            label: 'Connection',
            value: 'Connecting',
          },
        ],
        content: (
          <WorktreeTerminalWindowContent
            key={windowId}
            windowId={windowId}
            sessionId={sessionId}
            agentName={agentName}
            worktreeName={worktreeName}
            onRequestClose={() => closeWindow(windowId)}
          />
        ),
      });

      focusWindow(windowId);
    },
    [closeWindow, focusWindow, openWindow],
  );
}
