import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAgentSessionHistory } from '@/ui/hooks/useAgentSessionHistory';
import { Skeleton } from '@/ui/components/ui/skeleton';
import { Button } from '@/ui/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { useToast } from '@/ui/hooks/use-toast';
import { renameSession, deleteSessionHistoryItem } from '@/ui/lib/sessions';
import type { SessionHistoryItem } from '@/ui/hooks/useAgentSessionHistory';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/ui/components/ui/alert-dialog';

export interface PreviousSessionsTableProps {
  agentId: string;
  projectId: string;
  onRead: (sessionId: string) => void;
  onRestore: (sessionId: string) => void;
  currentProviderName: string | null;
  restoringSessionIds: Record<string, boolean>;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortSessionId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function PreviousSessionsTable({
  agentId,
  projectId,
  onRead,
  onRestore,
  currentProviderName,
  restoringSessionIds,
}: PreviousSessionsTableProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const apiFetch = useFetchFactory();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string | null }) =>
      renameSession(id, projectId, name, apiFetch),
    onMutate: async ({ id, name }) => {
      await queryClient.cancelQueries({ queryKey: ['agentSessionHistory', agentId, projectId] });
      const allQueries = queryClient.getQueriesData<{ items: SessionHistoryItem[] }>({
        queryKey: ['agentSessionHistory', agentId, projectId],
      });
      const previousData = allQueries.map(([key, data]) => ({ key, data }));
      for (const [key, data] of allQueries) {
        if (!data?.items) continue;
        queryClient.setQueryData(key, {
          ...data,
          items: data.items.map((item) =>
            item.id === id ? { ...item, name: name?.trim() || null } : item,
          ),
        });
      }
      return { previousData };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousData) {
        for (const { key, data } of context.previousData) {
          queryClient.setQueryData(key, data);
        }
      }
      toast({ variant: 'destructive', description: "Couldn't rename session." });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['agentSessionHistory', agentId, projectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (vars: { id: string; wasLastOnPage?: boolean }) =>
      deleteSessionHistoryItem(vars.id, projectId, apiFetch),
    onSuccess: async (_data, variables) => {
      toast({ description: 'Session record deleted.' });
      setDeleteId(null);
      await queryClient.invalidateQueries({
        queryKey: ['agentSessionHistory', agentId, projectId],
      });
      if (variables.wasLastOnPage) goPrev();
    },
    onError: (err: Error) => {
      const msg = err.message || 'Failed to delete session record.';
      if (msg.includes('409') || msg.toLowerCase().includes('running')) {
        toast({ variant: 'destructive', description: 'Cannot delete a running session.' });
      } else if (msg.includes('404')) {
        toast({ variant: 'destructive', description: 'Session no longer exists.' });
        queryClient.invalidateQueries({ queryKey: ['agentSessionHistory', agentId, projectId] });
      } else {
        toast({ variant: 'destructive', description: msg });
      }
      setDeleteId(null);
    },
  });

  function startEditing(item: SessionHistoryItem) {
    setEditingId(item.id);
    setDraftName(item.name ?? '');
  }

  function commitEdit(item: SessionHistoryItem) {
    const trimmed = draftName.trim();
    const newName = trimmed || null;
    if (newName !== item.name) {
      renameMutation.mutate({ id: item.id, name: newName });
    }
    setEditingId(null);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function copySessionId(id: string, label = 'Session ID') {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
      toast({ description: `${label} copied.` });
    } catch {
      toast({ variant: 'destructive', description: "Couldn't copy to clipboard." });
    }
  }

  const {
    items,
    total,
    currentPage,
    totalPages,
    hasNext,
    hasPrev,
    isLoading,
    isFetching,
    isError,
    goNext,
    goPrev,
    refetch,
  } = useAgentSessionHistory(agentId, projectId);

  if (isLoading) {
    return (
      <div className="mt-3 space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Previous sessions</p>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-destructive">
        <span>Failed to load previous sessions.</span>
        <button
          type="button"
          className="flex items-center gap-1 underline hover:no-underline"
          onClick={() => refetch()}
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">No previous sessions for this agent yet.</p>
    );
  }

  return (
    <div className="mt-3 text-left">
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Previous sessions</p>
      <div className="max-h-[min(400px,60vh)] overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-2 text-xs">Last active</TableHead>
              <TableHead className="h-8 px-2 text-xs">Size</TableHead>
              <TableHead className="h-8 px-2 text-xs">Session ID</TableHead>
              <TableHead className="h-8 w-36 px-2 text-xs" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const activeAt = item.lastActivityAt ?? item.endedAt ?? item.startedAt;
              const visibleSessionId = item.providerSessionId ?? item.id;
              const visibleSessionLabel = item.providerSessionId
                ? 'Provider session ID'
                : 'DevChain session ID';
              return (
                <TableRow key={item.id}>
                  <TableCell className="px-2 py-1.5 text-xs text-muted-foreground">
                    {formatRelativeTime(activeAt)}
                  </TableCell>
                  <TableCell className="px-2 py-1.5 text-xs text-muted-foreground">
                    {formatBytes(item.sizeBytes)}
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    {editingId === item.id ? (
                      <input
                        ref={inputRef}
                        type="text"
                        maxLength={120}
                        className="h-6 w-full rounded border border-border bg-background px-1.5 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit(item);
                          if (e.key === 'Escape') cancelEdit();
                        }}
                        onBlur={() => commitEdit(item)}
                      />
                    ) : (
                      <button
                        type="button"
                        title={`${visibleSessionLabel}: ${visibleSessionId}`}
                        className="flex items-center gap-1 font-mono text-xs text-foreground hover:text-primary"
                        onClick={() => startEditing(item)}
                      >
                        {item.name ?? shortSessionId(visibleSessionId)}
                        <Pencil className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                      </button>
                    )}
                  </TableCell>
                  <TableCell className="w-20 px-2 py-1.5 text-right">
                    <div className="inline-flex items-center justify-end gap-0.5">
                      {(() => {
                        const isRestoring = restoringSessionIds[item.id] ?? false;
                        const noProviderSession = !item.providerSessionId;
                        const providerMismatch =
                          item.providerNameAtLaunch != null &&
                          currentProviderName != null &&
                          item.providerNameAtLaunch.toLowerCase() !==
                            currentProviderName.toLowerCase();
                        const isDisabled = isRestoring || noProviderSession || providerMismatch;
                        const disabledReason = noProviderSession
                          ? "Cannot restore — provider session id wasn't captured for this run."
                          : providerMismatch
                            ? `Cannot restore — agent's provider has changed (was ${item.providerNameAtLaunch}, now ${currentProviderName}).`
                            : null;

                        const btn = (
                          <button
                            type="button"
                            aria-label={disabledReason ?? 'Restore session'}
                            disabled={isDisabled}
                            className="rounded p-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
                            onClick={() => onRestore(item.id)}
                          >
                            {isRestoring ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )}
                          </button>
                        );

                        if (disabledReason) {
                          return (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">{btn}</span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-52 text-center">
                                  {disabledReason}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          );
                        }

                        return btn;
                      })()}
                      <button
                        type="button"
                        aria-label="Copy session ID"
                        title={`Copy ${visibleSessionLabel}`}
                        className="rounded p-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                        onClick={() => copySessionId(visibleSessionId, visibleSessionLabel)}
                      >
                        {copiedId === visibleSessionId ? (
                          <Check className="h-3.5 w-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                      {item.transcriptAvailable && (
                        <button
                          type="button"
                          title="Read transcript"
                          className="rounded p-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          onClick={() => onRead(item.id)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <AlertDialog
                        open={deleteId === item.id}
                        onOpenChange={(open) => {
                          if (!open) setDeleteId(null);
                        }}
                      >
                        <AlertDialogTrigger asChild>
                          <button
                            type="button"
                            aria-label="Delete session record"
                            title="Delete session record"
                            className="rounded p-1 text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            onClick={() => setDeleteId(item.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete session record</AlertDialogTitle>
                            <AlertDialogDescription>
                              This removes the session from DevChain&apos;s history. The transcript
                              file on disk is preserved. This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              disabled={deleteMutation.isPending}
                              onClick={() => {
                                deleteMutation.mutate({
                                  id: item.id,
                                  wasLastOnPage: items.length === 1 && currentPage > 1,
                                });
                              }}
                            >
                              {deleteMutation.isPending && (
                                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                              )}
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {total > 0 && (
          <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={!hasPrev || isFetching}
              onClick={goPrev}
            >
              <ChevronLeft className="mr-1 h-3 w-3" />
              Prev
            </Button>
            <span className="text-xs text-muted-foreground">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={!hasNext || isFetching}
              onClick={goNext}
            >
              Next
              <ChevronRight className="ml-1 h-3 w-3" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
