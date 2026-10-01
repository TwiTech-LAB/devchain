import type { ReactNode } from 'react';
import { useRemoteStatsHistory, type RemoteStatsSample } from '@/ui/hooks/useRemoteStatsHistory';
import { cn } from '@/ui/lib/utils';
import { Sparkline, type SparklineColorVar } from './Sparkline';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';

export function bytesToGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

/** RAM percent: used / total, or null while the total is unknown. */
export function ramPercent(sample: RemoteStatsSample): number | null {
  const trend = ramTrendPercent(sample);
  return trend === null ? null : Math.round(trend);
}

/** Same as `ramPercent`, kept fractional so the sparkline trend moves. */
function ramTrendPercent(sample: RemoteStatsSample): number | null {
  if (sample.memTotalBytes <= 0) return null;
  return (sample.memUsedBytes / sample.memTotalBytes) * 100;
}

/**
 * Disk percent the way `df` reads it: used / (used + available-to-non-root) when the
 * host reports `diskAvailBytes`; hosts that only report the total fall back to
 * used / total, which reads a few points low near full.
 */
export function diskPercent(sample: RemoteStatsSample): number | null {
  const trend = diskTrendPercent(sample);
  return trend === null ? null : Math.round(trend);
}

/** Same denominator policy as `diskPercent`, kept fractional so the sparkline trend moves. */
export function diskTrendPercent(sample: RemoteStatsSample): number | null {
  if (sample.diskAvailBytes !== undefined) {
    const dfTotal = sample.diskUsedBytes + sample.diskAvailBytes;
    if (dfTotal > 0) return (sample.diskUsedBytes / dfTotal) * 100;
  }
  if (sample.diskTotalBytes > 0) {
    return (sample.diskUsedBytes / sample.diskTotalBytes) * 100;
  }
  return null;
}

function cpuPercent(sample: RemoteStatsSample): number | null {
  if (!Number.isFinite(sample.cpuPercent)) return null;
  return Math.round(sample.cpuPercent);
}

/** Warning from 80%, destructive from 90%; the thresholds apply to the displayed (rounded) percent. */
function percentToneClass(percent: number | null): string {
  if (percent === null) return '';
  if (percent >= 90) return 'text-destructive';
  if (percent >= 80) return 'text-status-warn';
  return '';
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatSampleTime(sampledAt: string): string {
  const parsed = Date.parse(sampledAt);
  if (Number.isNaN(parsed)) return 'unknown';
  return new Date(parsed).toLocaleTimeString();
}

function MetricBlock({
  label,
  percent,
  series,
  colorVar,
  tooltip,
}: {
  label: string;
  percent: number | null;
  series: number[];
  colorVar: SparklineColorVar;
  tooltip: ReactNode;
}) {
  const percentText = percent === null ? '—' : `${percent}%`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={`remote-metric-${label.toLowerCase()}`}
          className="flex h-8 items-center gap-1.5 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${label} ${percentText}`}
        >
          <span className="hidden text-[10px] font-medium uppercase tracking-wide text-muted-foreground md:block">
            {label}
          </span>
          <span className={cn('font-semibold tabular-nums', percentToneClass(percent))}>
            {percentText}
          </span>
          <span className="hidden lg:block">
            <Sparkline values={series} colorVar={colorVar} />
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs p-3">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function MetricDivider() {
  return <span aria-hidden="true" className="hidden h-5 w-px bg-border md:block" />;
}

/**
 * Glance at the active remote's health for the dock header: CPU, RAM and Disk percents
 * with sparklines, driven by the home-owned stats-history query. Renders "Waiting for
 * stats" until the first samples arrive (including while the endpoint is unavailable).
 */
export function RemoteMetricsStrip({
  remoteId,
  remoteName,
}: {
  remoteId: string;
  remoteName: string;
}) {
  const historyQuery = useRemoteStatsHistory(remoteId);
  const samples = historyQuery.data?.samples ?? [];
  const latest: RemoteStatsSample | null = samples.length > 0 ? samples[samples.length - 1] : null;

  if (!latest) {
    return (
      <span data-testid="remote-metrics-strip" className="text-xs text-muted-foreground">
        Waiting for stats
      </span>
    );
  }

  const tooltip = (
    <div className="space-y-1" data-testid="remote-metrics-tooltip">
      <p className="text-sm font-medium">{remoteName}</p>
      <p>CPU {Math.round(latest.cpuPercent)}%</p>
      <p>
        RAM {bytesToGb(latest.memUsedBytes)} / {bytesToGb(latest.memTotalBytes)} GB
      </p>
      <p>
        Disk {bytesToGb(latest.diskUsedBytes)} / {bytesToGb(latest.diskTotalBytes)} GB
      </p>
      <p>
        Load {latest.load1.toFixed(1)} / {latest.load5.toFixed(1)}
      </p>
      <p>Up {formatUptime(latest.uptimeSec)}</p>
      <p className="text-muted-foreground">Sampled {formatSampleTime(latest.sampledAt)}</p>
    </div>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div data-testid="remote-metrics-strip" className="flex items-center gap-1.5">
        <MetricBlock
          label="CPU"
          percent={cpuPercent(latest)}
          series={samples.map((sample) => sample.cpuPercent)}
          colorVar="--metric-cpu"
          tooltip={tooltip}
        />
        <MetricDivider />
        <MetricBlock
          label="RAM"
          percent={ramPercent(latest)}
          series={samples.map((sample) => ramTrendPercent(sample) ?? 0)}
          colorVar="--metric-ram"
          tooltip={tooltip}
        />
        <MetricDivider />
        <MetricBlock
          label="Disk"
          percent={diskPercent(latest)}
          series={samples.map((sample) => diskTrendPercent(sample) ?? 0)}
          colorVar="--metric-disk"
          tooltip={tooltip}
        />
      </div>
    </TooltipProvider>
  );
}
