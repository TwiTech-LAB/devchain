import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleHelp,
  Clock,
  Hourglass,
  RefreshCw,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useSyncStatus } from '@/ui/hooks/useSyncStatus';
import { cn } from '@/ui/lib/utils';
import {
  SYNC_VERDICT_LABELS,
  countText,
  lastReceivedText,
  pendingText,
} from '@/ui/pages/cloud/file-sync-display';
import type {
  FileSyncStatusScope,
  FileSyncVerdict,
} from '@/ui/pages/cloud/lib/remote-vm-contracts';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { formatSampleTime } from './RemoteMetricsStrip';

const SYNC_STATUS_POLL_MS = 5_000;
const FILE_SYNC_TAB_HREF = '/cloud?section=remote-vm&tab=file-sync';

// Theme tokens of `status-tone.ts`: ok, running (primary), warn and neutral (muted).
const VERDICTS: Record<FileSyncVerdict, { icon: LucideIcon; tone: string; motion?: string }> = {
  'in-sync': { icon: CircleCheck, tone: 'text-status-ok' },
  syncing: { icon: RefreshCw, tone: 'text-primary', motion: 'motion-safe:animate-spin' },
  waiting: { icon: Clock, tone: 'text-primary' },
  disconnected: { icon: Unplug, tone: 'text-status-warn' },
  problem: { icon: TriangleAlert, tone: 'text-status-warn' },
  busy: { icon: Hourglass, tone: 'text-muted-foreground' },
  unknown: { icon: CircleHelp, tone: 'text-muted-foreground' },
};

function SyncTooltip({ scope, checkedAt }: { scope: FileSyncStatusScope; checkedAt: string }) {
  return (
    <div className="space-y-1" data-testid="remote-sync-tooltip">
      <p className="text-sm font-medium">File sync: {SYNC_VERDICT_LABELS[scope.verdict]}</p>
      {scope.reason && <p>{scope.reason}</p>}
      <p>To the VM: {pendingText(scope.toVm)}</p>
      <p>From the VM: {pendingText(scope.fromVm)}</p>
      <p>
        Failed: {countText(scope.failed.home)} on this PC, {countText(scope.failed.vm)} on the VM
        (last reported)
      </p>
      <p className="break-all">
        Last received: {lastReceivedText(scope.lastReceived, formatSampleTime)}
      </p>
      <p className="text-muted-foreground">Checked {formatSampleTime(checkedAt)}</p>
    </div>
  );
}

function PendingBadge({
  icon: Icon,
  items,
  label,
}: {
  icon: LucideIcon;
  items: number;
  label: string;
}) {
  if (items <= 0) return null;
  return (
    <span className="flex items-center tabular-nums" data-testid={`remote-sync-${label}`}>
      <Icon aria-hidden="true" className="h-3 w-3" />
      {items}
    </span>
  );
}

/**
 * The selected VM project's measured file sync status for the dock. Renders nothing while
 * the first read loads, when the read fails, and when the answer has no scope for the
 * project (for example while its binding detaches).
 */
export function RemoteSyncIndicator({
  projectId,
  cloudUiEnabled,
}: {
  projectId: string;
  /** Without the cloud UI the `/cloud` route does not exist, so a click does nothing. */
  cloudUiEnabled: boolean;
}) {
  const navigate = useNavigate();
  const { data, isError } = useSyncStatus({ projectId, pollMs: SYNC_STATUS_POLL_MS });
  const scope = data?.scopes.find((candidate) => candidate.projectId === projectId);
  if (!data || isError || !scope) return null;

  const verdict = VERDICTS[scope.verdict];
  const Icon = verdict.icon;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid="remote-sync-indicator"
            data-verdict={scope.verdict}
            aria-label={`File sync: ${SYNC_VERDICT_LABELS[scope.verdict]}`}
            onClick={cloudUiEnabled ? () => navigate(FILE_SYNC_TAB_HREF) : undefined}
            className={cn(
              'flex h-8 items-center gap-1 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring',
              verdict.tone,
            )}
          >
            <Icon
              aria-hidden="true"
              data-testid="remote-sync-icon"
              className={cn('h-4 w-4', verdict.motion)}
            />
            <PendingBadge icon={ArrowUp} items={scope.toVm?.items ?? 0} label="to-vm" />
            <PendingBadge icon={ArrowDown} items={scope.fromVm?.items ?? 0} label="from-vm" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs p-3">
          <SyncTooltip scope={scope} checkedAt={data.checkedAt} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
