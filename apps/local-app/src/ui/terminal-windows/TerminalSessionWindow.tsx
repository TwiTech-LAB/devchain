import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Terminal, type TerminalHandle } from '@/ui/components/Terminal';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { TERMINAL_SESSIONS_QUERY_KEY } from '@/ui/components/terminal-dock/TerminalDock';
import {
  type ActiveSession,
  fetchAgentSummary,
  fetchEpicSummary,
  fetchProfileSummary,
  fetchProjectSummary,
  fetchProviderSummary,
  terminateSession,
} from '@/ui/lib/sessions';
import { getProviderIconDataUri } from '@/ui/lib/providers';
import {
  useTerminalWindows,
  type TerminalWindowDetail,
  type TerminalWindowMenuItem,
} from './TerminalWindowsContext';

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
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const closingRef = useRef(false);
  const terminalSessionsQueryKey = [
    ...TERMINAL_SESSIONS_QUERY_KEY,
    selectedProjectId ?? 'all',
  ] as const;

  const { data: epic } = useQuery({
    queryKey: ['terminal-window', 'epic', session.epicId],
    queryFn: () => fetchEpicSummary(session.epicId!),
    enabled: Boolean(session.epicId),
    staleTime: 2 * 60 * 1000, // 2 minutes - epic titles can change
    gcTime: 5 * 60 * 1000,
  });

  const { data: agent } = useQuery({
    queryKey: ['terminal-window', 'agent', session.agentId],
    queryFn: () => fetchAgentSummary(session.agentId!),
    enabled: Boolean(session.agentId),
    staleTime: 5 * 60 * 1000, // 5 minutes - agent data rarely changes
    gcTime: 10 * 60 * 1000,
  });

  // Profile and provider queries only run when agent.providerName is not available (fallback for older servers)
  const needsProviderFetch = Boolean(agent?.profileId && !agent?.providerName);
  const { data: profile } = useQuery({
    queryKey: ['terminal-window', 'profile', agent?.profileId],
    queryFn: () => fetchProfileSummary(agent!.profileId),
    enabled: needsProviderFetch,
    staleTime: 10 * 60 * 1000, // 10 minutes - profiles rarely change
    gcTime: 30 * 60 * 1000,
  });

  const { data: provider } = useQuery({
    queryKey: ['terminal-window', 'provider', profile?.providerId],
    queryFn: () => fetchProviderSummary(profile!.providerId),
    enabled: Boolean(profile?.providerId && !agent?.providerName),
    staleTime: 60 * 60 * 1000, // 1 hour - providers almost never change
    gcTime: 24 * 60 * 60 * 1000, // 24 hours
  });

  // Use providerName from agent (enriched) or fallback to provider chain
  const resolvedProviderName = agent?.providerName ?? provider?.name;

  const { data: project } = useQuery({
    queryKey: ['terminal-window', 'project', epic?.projectId],
    queryFn: () => fetchProjectSummary(epic!.projectId),
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

  const terminateMutation = useMutation({
    mutationFn: async () => {
      await terminateSession(session.id);
      await queryClient.invalidateQueries({ queryKey: terminalSessionsQueryKey });
    },
    onSuccess: () => {
      toast({
        title: 'Session terminated',
        description: `Session ${session.id.slice(0, 8)} has been terminated.`,
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

  const publishWindowMeta = useCallback(
    (handle: TerminalHandle | null) => {
      const title = epic?.title ?? `Session ${session.id.slice(0, 8)}`;
      const subtitleParts: string[] = [];
      if (agent?.name) {
        subtitleParts.push(agent.name);
      } else {
        subtitleParts.push('Unassigned agent');
      }
      if (project?.name) {
        subtitleParts.push(project.name);
      }

      // Resolve provider icon from enriched agent.providerName or fallback chain
      const providerIconUri = getProviderIconDataUri(resolvedProviderName);

      const details = [
        {
          label: 'Session',
          value: session.id.slice(0, 8),
          title: session.id,
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
      ].filter(Boolean) as TerminalWindowDetail[];

      const menuItems: TerminalWindowMenuItem[] = [
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
          id: 'clear-buffer',
          label: 'Clear terminal buffer',
          onSelect: () => handle?.clear?.(),
          disabled: !handle,
          shortcut: 'Ctrl+K',
        },
        {
          id: 'terminate-session',
          label: 'Terminate session',
          tone: 'destructive',
          onSelect: requestTerminate,
        },
      ];

      updateWindowMeta(session.id, {
        title,
        subtitle: subtitleParts.filter(Boolean).join(' • ') || undefined,
        menuItems,
        details,
      });
    },
    [
      agent?.name,
      epic?.title,
      handleCopyTmux,
      project?.name,
      resolvedProviderName,
      requestTerminate,
      session.id,
      session.tmuxSessionId,
      updateWindowMeta,
      handleCopyTmuxCommand,
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
      description: `Session ${session.id.slice(0, 8)} has completed.`,
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
        description={`Terminate session ${session.id.slice(0, 8)}? This will stop the underlying tmux pane.`}
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
        title: `Session ${session.id.slice(0, 8)}`,
        subtitle: 'Loading metadata…',
        menuItems: [],
        details: [
          {
            label: 'Session',
            value: session.id.slice(0, 8),
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
