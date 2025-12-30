import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActiveSession,
  fetchActiveSessions,
  fetchAgentSummary,
  restartSession,
  terminateSession,
} from '@/ui/lib/sessions';
import { Button } from '@/ui/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/ui/components/ui/context-menu';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { useToast } from '@/ui/hooks/use-toast';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useTerminalWindows } from '@/ui/terminal-windows';
import { cn } from '@/ui/lib/utils';
import { ChevronRight, Copy, Loader2, Square, Terminal as TerminalIcon } from 'lucide-react';

export const TERMINAL_SESSIONS_QUERY_KEY = ['terminal-dock', 'sessions'] as const;
export const OPEN_TERMINAL_DOCK_EVENT = 'devchain:terminal-dock:open';

interface TerminalDockProps {
  expanded: boolean;
  sessions: ActiveSession[];
  activeSessionId: string | null;
  openSessionIds: string[];
  onToggle: () => void;
  onOpenSession: (session: ActiveSession) => void;
  onSessionsChange: (sessions: ActiveSession[]) => void;
  onSessionTerminated: (sessionId: string) => void;
}

interface SessionRowProps {
  session: ActiveSession;
  agentName: string;
  isFocused: boolean;
  onOpen: () => void;
  onCopyTmux: () => void;
  onTerminate: () => void;
  isTerminating: boolean;
}

function SessionRow({
  session,
  agentName,
  isFocused,
  onOpen,
  onCopyTmux,
  onTerminate,
  isTerminating,
}: SessionRowProps) {
  const isRunning = session.status === 'running';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
        isFocused ? 'bg-primary/10' : 'hover:bg-muted/50',
      )}
    >
      {/* Status dot */}
      <span
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          isRunning ? 'bg-emerald-500' : 'bg-muted-foreground',
        )}
        title={session.status}
      />

      {/* Session ID - clickable */}
      <button
        type="button"
        onClick={onOpen}
        className="shrink-0 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
        title={`Open session ${session.id}`}
      >
        {session.id.slice(0, 8)}
      </button>

      {/* Agent name - clickable */}
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 truncate text-left hover:text-foreground hover:underline"
        title={`Open session for ${agentName}`}
      >
        {agentName}
      </button>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Action buttons */}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={onCopyTmux}
          disabled={!session.tmuxSessionId}
          title="Copy tmux id"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-destructive hover:text-destructive"
          onClick={onTerminate}
          disabled={isTerminating}
          title="Terminate session"
        >
          {isTerminating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </Button>
      </div>
    </div>
  );
}

export function TerminalDock({
  expanded,
  sessions,
  activeSessionId,
  openSessionIds: _openSessionIds,
  onToggle,
  onOpenSession,
  onSessionsChange,
  onSessionTerminated,
}: TerminalDockProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmSessionId, setConfirmSessionId] = useState<string | null>(null);
  const [restartSessionId, setRestartSessionId] = useState<string | null>(null);
  const [srMessage, setSrMessage] = useState('');
  const { selectedProjectId } = useSelectedProject();
  const {
    windows: terminalWindows,
    focusedWindowId,
    restoreWindow,
    focusWindow,
    minimizeWindow,
  } = useTerminalWindows();
  const sessionsQueryKey = [...TERMINAL_SESSIONS_QUERY_KEY, selectedProjectId ?? 'all'] as const;

  const { data, isLoading, isFetching, error } = useQuery<ActiveSession[]>({
    queryKey: sessionsQueryKey,
    queryFn: () => fetchActiveSessions(selectedProjectId ?? undefined),
    enabled: expanded || sessions.length === 0,
    refetchInterval: expanded ? 7000 : false,
  });

  // Batch fetch agent summaries - deduplicate agent IDs across all sessions
  const uniqueAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of sessions) {
      if (s.agentId) ids.add(s.agentId);
    }
    return Array.from(ids);
  }, [sessions]);

  const agentQueries = useQueries({
    queries: uniqueAgentIds.map((agentId) => ({
      queryKey: ['agent-summary', agentId] as const,
      queryFn: () => fetchAgentSummary(agentId),
      enabled: expanded, // Only fetch when dock is expanded (collapsed pills use window.details fallback)
      staleTime: 5 * 60 * 1000, // 5 minutes - agent names rarely change
      gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
    })),
  });

  // Build agent name lookup map (memoized to avoid recalculating on every render)
  const agentNameMap = useMemo(() => {
    const map = new Map<string, string>();
    agentQueries.forEach((query, index) => {
      const agentId = uniqueAgentIds[index];
      if (query.data?.name) {
        map.set(agentId, query.data.name);
      }
    });
    return map;
  }, [agentQueries, uniqueAgentIds]);

  // Helper to get agent name with fallback
  const getAgentName = (agentId: string | null): string => {
    if (!agentId) return 'Unassigned';
    return agentNameMap.get(agentId) ?? agentId.slice(0, 8);
  };

  useEffect(() => {
    if (!data) {
      return;
    }

    onSessionsChange(data);
    setSrMessage(
      data.length === 0
        ? 'No active sessions in the terminal dock.'
        : `Terminal dock updated. ${data.length} active ${
            data.length === 1 ? 'session' : 'sessions'
          }.`,
    );
  }, [data, onSessionsChange]);

  const terminateMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      await terminateSession(sessionId);
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
    },
    onSuccess: (_, sessionId) => {
      toast({
        title: 'Session terminated',
        description: `Session ${sessionId.slice(0, 8)} terminated successfully.`,
      });
      onSessionTerminated(sessionId);
    },
    onError: (mutationError: unknown) => {
      const message =
        mutationError instanceof Error ? mutationError.message : 'Unable to terminate session';
      toast({
        title: 'Terminate failed',
        description: message,
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setConfirmSessionId(null);
    },
  });

  const restartMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const session = sessionsById.get(sessionId);
      if (!session?.agentId || !selectedProjectId) {
        throw new Error('Cannot restart: missing agent or project');
      }
      const result = await restartSession(session.agentId, selectedProjectId, sessionId);
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey });
      return result;
    },
    onSuccess: (result, sessionId) => {
      if (result.terminateWarning) {
        // Show warning that terminate failed but new session was launched
        toast({
          title: 'Session restarted with warning',
          description: result.terminateWarning,
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Session restarted',
          description: `Session ${sessionId.slice(0, 8)} restarted successfully.`,
        });
      }
    },
    onError: (mutationError: unknown) => {
      const message =
        mutationError instanceof Error ? mutationError.message : 'Unable to restart session';
      toast({
        title: 'Restart failed',
        description: message,
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setRestartSessionId(null);
    },
  });

  const handleCopyTmuxId = async (session: ActiveSession) => {
    if (!session.tmuxSessionId) {
      toast({
        title: 'No tmux id',
        description: 'This session does not have a tmux session id to copy yet.',
        variant: 'destructive',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(session.tmuxSessionId);
      toast({
        title: 'Copied tmux id',
        description: `Copied ${session.tmuxSessionId} to clipboard.`,
      });
    } catch (copyError) {
      const message =
        copyError instanceof Error
          ? copyError.message
          : 'Clipboard access is not available in this context.';
      toast({
        title: 'Copy failed',
        description: message,
        variant: 'destructive',
      });
    }
  };

  const handleTerminate = (sessionId: string) => {
    setConfirmSessionId(sessionId);
  };

  const displayedSessions = useMemo(() => sessions, [sessions]);

  // Precompute session lookup map for O(1) access instead of O(n) find()
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  // Terminal windows that have an associated session (open terminal windows)
  const openWindows = useMemo(() => terminalWindows.filter((w) => w.sessionId), [terminalWindows]);

  const collapsedLabel = `${displayedSessions.length} ${displayedSessions.length === 1 ? 'session' : 'sessions'}`;
  const statusDotColor = isFetching || error ? 'text-muted-foreground' : 'text-emerald-500';

  return (
    <section
      className={cn(
        'border-t border-border bg-card transition-[height] duration-200 ease-out',
        expanded ? 'h-[320px]' : 'h-12',
      )}
      aria-label="Terminal session dock"
    >
      <div
        className="flex h-12 items-center justify-between gap-3 px-4"
        onDoubleClick={(e) => {
          // Guard: don't toggle if clicking on buttons/pills
          // Defensive check: e.target may not be Element in edge cases
          if (!(e.target instanceof Element)) return;
          if (e.target.closest('button, [role="button"]')) return;
          onToggle();
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <button
            type="button"
            onClick={onToggle}
            className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse terminal dock' : 'Expand terminal dock'}
          >
            <TerminalIcon className="h-4 w-4" aria-hidden="true" />
            <span className={statusDotColor} aria-hidden="true">
              ●
            </span>
            <span>{collapsedLabel}</span>
            <ChevronRight
              className={cn('h-4 w-4 transition-transform', expanded && 'rotate-90')}
              aria-hidden="true"
            />
            {isFetching && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                aria-hidden="true"
              />
            )}
          </button>
          {error && (
            <span className="text-xs text-destructive">
              {(error as Error).message || 'Unable to load sessions'}
            </span>
          )}

          {/* Session pills - visible when windows are open */}
          {openWindows.length > 0 && (
            <div className="min-w-0 flex-1 overflow-x-auto">
              <div className="flex items-center gap-1.5">
                {openWindows.map((window) => {
                  const agentName =
                    window.details?.find((d) => d.label === 'Agent')?.value ||
                    window.subtitle ||
                    window.sessionId?.slice(0, 8) ||
                    'Unknown';
                  const session = window.sessionId ? sessionsById.get(window.sessionId) : undefined;
                  const isRunning = session?.status === 'running';
                  const providerIcon = window.details?.find(
                    (d) => d.label === 'providerIcon',
                  )?.value;

                  const isFocused = focusedWindowId === window.id;
                  const canRestart = Boolean(session?.agentId && selectedProjectId);

                  return (
                    <ContextMenu key={window.id}>
                      <ContextMenuTrigger asChild>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.minimized) {
                              restoreWindow(window.id);
                            } else if (isFocused) {
                              minimizeWindow(window.id);
                            } else {
                              focusWindow(window.id);
                            }
                          }}
                          aria-pressed={!window.minimized && isFocused}
                          className={cn(
                            'flex max-w-[140px] items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs transition-colors',
                            !window.minimized && isFocused
                              ? 'bg-primary text-primary-foreground'
                              : !window.minimized
                                ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                                : 'bg-muted hover:bg-muted/80',
                          )}
                        >
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              isRunning ? 'bg-emerald-500' : 'bg-muted-foreground',
                            )}
                          />
                          {providerIcon && (
                            <img src={providerIcon} alt="" className="h-4 w-4 shrink-0" />
                          )}
                          <span className="truncate">{agentName}</span>
                        </button>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem
                          disabled={!canRestart}
                          onSelect={() => {
                            if (session) setRestartSessionId(session.id);
                          }}
                        >
                          Restart session
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className="text-destructive focus:text-destructive"
                          disabled={!window.sessionId}
                          onSelect={() => {
                            // Use window.sessionId directly - works even if sessions list is stale
                            if (window.sessionId) setConfirmSessionId(window.sessionId);
                          }}
                        >
                          Terminate session
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <span className="sr-only" aria-live="polite">
        {srMessage}
      </span>

      {expanded && (
        <div className="flex h-[calc(100%-3rem)] flex-col border-t border-border">
          <header className="flex items-center justify-between px-4 py-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span>Active Sessions</span>
              {isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => queryClient.invalidateQueries({ queryKey: sessionsQueryKey })}
              disabled={isLoading || isFetching}
            >
              Refresh
            </Button>
          </header>

          <ScrollArea className="flex-1 px-4 pb-4">
            {isLoading && displayedSessions.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading sessions…
              </div>
            ) : displayedSessions.length === 0 ? (
              <div className="mt-6 text-sm text-muted-foreground">
                No active sessions. Launch a session from an epic or agent to see it here.
              </div>
            ) : (
              <div className="space-y-1">
                {displayedSessions.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    agentName={getAgentName(session.agentId)}
                    isFocused={session.id === activeSessionId}
                    onOpen={() => onOpenSession(session)}
                    onCopyTmux={() => handleCopyTmuxId(session)}
                    onTerminate={() => handleTerminate(session.id)}
                    isTerminating={terminateMutation.isPending && confirmSessionId === session.id}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      )}

      <ConfirmDialog
        open={confirmSessionId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmSessionId(null);
        }}
        onConfirm={() => {
          if (confirmSessionId) {
            terminateMutation.mutate(confirmSessionId);
          }
        }}
        title="Terminate session"
        description={
          confirmSessionId
            ? `Are you sure you want to terminate session ${confirmSessionId.slice(0, 8)}?`
            : 'Are you sure you want to terminate this session?'
        }
        confirmText="Terminate"
        variant="destructive"
        loading={terminateMutation.isPending}
      />

      <ConfirmDialog
        open={restartSessionId !== null}
        onOpenChange={(open) => {
          if (!open) setRestartSessionId(null);
        }}
        onConfirm={() => {
          if (restartSessionId) {
            restartMutation.mutate(restartSessionId);
          }
        }}
        title="Restart session"
        description={
          restartSessionId
            ? `Are you sure you want to restart session ${restartSessionId.slice(0, 8)}? This will terminate the current session and start a new one.`
            : 'Are you sure you want to restart this session?'
        }
        confirmText="Restart"
        loading={restartMutation.isPending}
      />
    </section>
  );
}
