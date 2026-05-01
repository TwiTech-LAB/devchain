import { Eye, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
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
  const { items, hasMore, isLoading, isFetchingMore, isError, loadMore, refetch } =
    useAgentSessionHistory(agentId, projectId);

  async function copySessionId(id: string) {
    await navigator.clipboard.writeText(id);
    toast({ description: 'Session ID copied.' });
  }

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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-8 px-2 text-xs">Last active</TableHead>
            <TableHead className="h-8 px-2 text-xs">Size</TableHead>
            <TableHead className="h-8 px-2 text-xs">Session ID</TableHead>
            <TableHead className="h-8 w-20 px-2 text-xs" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const activeAt = item.lastActivityAt ?? item.endedAt ?? item.startedAt;
            return (
              <TableRow key={item.id}>
                <TableCell className="px-2 py-1.5 text-xs text-muted-foreground">
                  {formatRelativeTime(activeAt)}
                </TableCell>
                <TableCell className="px-2 py-1.5 text-xs text-muted-foreground">
                  {formatBytes(item.sizeBytes)}
                </TableCell>
                <TableCell className="px-2 py-1.5">
                  <button
                    type="button"
                    title={item.id}
                    className="font-mono text-xs text-foreground hover:text-primary"
                    onClick={() => copySessionId(item.id)}
                  >
                    {shortSessionId(item.id)}
                  </button>
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
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {hasMore && (
        <div className="mt-1.5 flex justify-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={isFetchingMore}
            onClick={() => loadMore()}
          >
            {isFetchingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
