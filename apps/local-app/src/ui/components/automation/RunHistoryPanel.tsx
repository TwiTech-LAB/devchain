import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, AlertCircle } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import {
  fetchScheduledEpicRuns,
  type ScheduledEpicRun,
  type ScheduledEpicRunStatus,
} from '@/ui/lib/scheduled-epics';

const PAGE_SIZE = 10;

function statusVariant(
  status: ScheduledEpicRunStatus,
): 'default' | 'destructive' | 'secondary' | 'outline' {
  switch (status) {
    case 'completed':
      return 'default';
    case 'failed':
      return 'destructive';
    case 'running':
    case 'pending':
      return 'outline';
    case 'skipped':
    default:
      return 'secondary';
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function computeLagMs(plannedFor: string, startedAt: string | null): number | null {
  if (!startedAt) return null;
  return new Date(startedAt).getTime() - new Date(plannedFor).getTime();
}

function formatLag(lagMs: number): string {
  if (lagMs < 0) return '<0ms';
  if (lagMs < 1000) return `${lagMs}ms`;
  if (lagMs < 60_000) return `${(lagMs / 1000).toFixed(1)}s`;
  return `${(lagMs / 60_000).toFixed(1)}m`;
}

interface RunRowProps {
  run: ScheduledEpicRun;
}

function RunRow({ run }: RunRowProps) {
  const [errorExpanded, setErrorExpanded] = useState(false);
  const lagMs = computeLagMs(run.plannedFor, run.startedAt);

  return (
    <div className="py-3 border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
        <Badge variant="secondary" className="text-xs">
          {run.source === 'manual' ? 'Manual' : 'Scheduler'}
        </Badge>
        {run.status === 'running' && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        )}
        {run.createdEpicId && (
          <Link
            to={`/epics/${run.createdEpicId}`}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            Epic {run.createdEpicId.slice(0, 8)}
          </Link>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Planned: {formatTime(run.plannedFor)}</span>
        {run.startedAt && <span>Started: {formatTime(run.startedAt)}</span>}
        {run.finishedAt && <span>Finished: {formatTime(run.finishedAt)}</span>}
        {lagMs !== null && <span>Lag: {formatLag(lagMs)}</span>}
      </div>
      {run.errorMessage && (
        <div className="mt-1">
          <button
            className="text-xs text-destructive hover:underline"
            onClick={() => setErrorExpanded((v) => !v)}
          >
            {errorExpanded ? 'Hide error' : 'Show error'}
          </button>
          {errorExpanded && (
            <p className="text-xs text-destructive mt-1 break-words">{run.errorMessage}</p>
          )}
        </div>
      )}
    </div>
  );
}

interface RunHistoryPanelProps {
  scheduleId: string;
}

export function RunHistoryPanel({ scheduleId }: RunHistoryPanelProps) {
  const [offset, setOffset] = useState(0);

  const { data, isLoading, error } = useQuery({
    queryKey: ['scheduled-epic-runs', scheduleId, offset],
    queryFn: () => fetchScheduledEpicRuns(scheduleId, { limit: PAGE_SIZE, offset }),
  });

  const total = data?.total ?? 0;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 px-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading history…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 py-4 px-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {error instanceof Error ? error.message : 'Failed to load run history'}
      </div>
    );
  }

  if (!data || data.items.length === 0) {
    return <p className="py-4 px-4 text-sm text-muted-foreground">No runs recorded yet.</p>;
  }

  return (
    <div className="px-4 pb-2">
      <div className="divide-y">
        {data.items.map((run) => (
          <RunRow key={run.id} run={run} />
        ))}
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between pt-3 text-sm text-muted-foreground">
          <span>
            Page {currentPage + 1} of {pageCount} ({total} total)
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              disabled={!hasPrev}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              disabled={!hasNext}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
