import { cn } from '@/ui/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { ChevronRight, Cpu, Layers } from 'lucide-react';
import type {
  UnifiedMetrics,
  PhaseTokenBreakdown,
} from '@/modules/session-reader/dtos/unified-session.types';
import {
  formatTokensCompact as formatTokens,
  formatCost,
  formatDuration,
  formatContextPercent,
} from '@/ui/utils/session-reader-formatters';

const DEFAULT_CONTEXT_WINDOW = 200_000;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SessionMetricsHeaderProps {
  metrics: UnifiedMetrics;
  /** Callback to scroll the session viewer to a specific message (used for compaction events) */
  onScrollToMessage?: (messageId: string) => void;
}

// ---------------------------------------------------------------------------
// Phase Breakdown Row
// ---------------------------------------------------------------------------

function PhaseRow({
  phase,
  onScrollToMessage,
}: {
  phase: PhaseTokenBreakdown;
  onScrollToMessage?: (messageId: string) => void;
}) {
  return (
    <div
      className="flex items-center gap-3 text-[11px] text-muted-foreground"
      data-testid={`phase-row-${phase.phaseNumber}`}
    >
      <span className="w-16 font-medium">Phase {phase.phaseNumber}</span>
      <span className="tabular-nums">{formatTokens(phase.contribution)}</span>
      <span className="text-muted-foreground/50">Peak:</span>
      <span className="tabular-nums">{formatTokens(phase.peakTokens)}</span>
      {phase.postCompaction !== undefined && (
        <>
          <span className="text-muted-foreground/50">Post:</span>
          <span className="tabular-nums">{formatTokens(phase.postCompaction)}</span>
        </>
      )}
      {phase.compactionMessageId && onScrollToMessage && (
        <button
          type="button"
          onClick={() => onScrollToMessage(phase.compactionMessageId!)}
          className="text-[10px] text-primary/80 hover:text-primary transition-colors underline"
          data-testid={`phase-link-${phase.phaseNumber}`}
        >
          View
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function SessionMetricsHeader({ metrics, onScrollToMessage }: SessionMetricsHeaderProps) {
  const contextWindow = metrics.contextWindowTokens || DEFAULT_CONTEXT_WINDOW;
  const totalContext = metrics.totalContextTokens;
  const windowPct = contextWindow > 0 ? (totalContext / contextWindow) * 100 : 0;
  const modelCount = metrics.modelsUsed?.length ?? (metrics.primaryModel ? 1 : 0);
  const hasPhases = metrics.compactionCount > 0 && metrics.phaseBreakdowns.length > 0;

  return (
    <div className="border-b border-border/60 bg-muted/30" data-testid="session-metrics-header">
      {/* Compact single-line bar */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-xs text-muted-foreground">
        {/* Model cluster */}
        <span className="inline-flex items-center gap-1" data-testid="metrics-model">
          <Cpu className="h-3 w-3" />
          <span>{metrics.primaryModel}</span>
          {modelCount > 1 && (
            <span
              className="rounded-full bg-muted/60 px-1.5 py-px text-[10px]"
              data-testid="model-count-badge"
            >
              +{modelCount - 1}
            </span>
          )}
        </span>

        <span className="border-r border-border/40 h-4" aria-hidden="true" />

        {/* Tokens cluster */}
        <span
          className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 tabular-nums"
          data-testid="metrics-tokens"
        >
          <span title="Input tokens">In: {formatTokens(metrics.inputTokens)}</span>
          <span title="Cache read tokens">CR: {formatTokens(metrics.cacheReadTokens)}</span>
          <span title="Cache write tokens">CW: {formatTokens(metrics.cacheCreationTokens)}</span>
          <span title="Output tokens">Out: {formatTokens(metrics.outputTokens)}</span>
          <span
            className="font-semibold text-foreground"
            title="Total tokens"
            data-testid="metrics-total-tokens"
          >
            {formatTokens(metrics.totalTokens)}
          </span>
        </span>

        <span className="text-muted-foreground/60" aria-hidden="true">
          ·
        </span>

        {/* Cost */}
        <span className="tabular-nums" data-testid="metrics-cost">
          {formatCost(metrics.costUsd)}
        </span>

        <span className="border-r border-border/40 h-4" aria-hidden="true" />

        {/* Status cluster */}
        <span className="inline-flex items-center gap-1" data-testid="metrics-context">
          <span className="tabular-nums">
            Visible: {formatTokens(metrics.visibleContextTokens)} / {formatTokens(totalContext)} (
            {formatContextPercent(metrics.visibleContextTokens, totalContext)})
          </span>
          <span
            className="inline-block h-1.5 w-12 overflow-hidden rounded-full bg-muted/60"
            role="progressbar"
            aria-valuenow={Math.round(Math.min(windowPct, 100))}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Context window ${Math.round(windowPct)}% used`}
          >
            <span
              className={cn(
                'block h-full rounded-full transition-all',
                windowPct > 80
                  ? 'bg-destructive'
                  : windowPct > 50
                    ? 'bg-amber-500'
                    : 'bg-primary/60',
              )}
              style={{ width: `${Math.min(windowPct, 100)}%` }}
            />
          </span>
        </span>

        {/* Duration */}
        {metrics.durationMs > 0 && (
          <>
            <span className="text-muted-foreground/60" aria-hidden="true">
              ·
            </span>
            <span className="tabular-nums" data-testid="metrics-duration">
              {formatDuration(metrics.durationMs)}
            </span>
          </>
        )}

        {/* Message count */}
        <span className="text-muted-foreground/60" aria-hidden="true">
          ·
        </span>
        <span className="tabular-nums" data-testid="metrics-messages">
          {metrics.messageCount} msgs
        </span>

        {/* Compaction count */}
        {metrics.compactionCount > 0 && (
          <>
            <span className="text-muted-foreground/60" aria-hidden="true">
              ·
            </span>
            <span
              className="inline-flex items-center gap-0.5 tabular-nums"
              data-testid="metrics-compactions"
            >
              <Layers className="h-3 w-3" />
              {metrics.compactionCount} compaction{metrics.compactionCount !== 1 ? 's' : ''}
            </span>
          </>
        )}

        {/* Live indicator */}
        {metrics.isOngoing && (
          <span className="ml-auto inline-flex items-center gap-1" data-testid="metrics-live">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse"
              aria-hidden="true"
            />
            Live
          </span>
        )}
      </div>

      {/* Expandable phase breakdown */}
      {hasPhases && (
        <Collapsible>
          <CollapsibleTrigger
            className="group flex w-full items-center gap-1 border-t border-border/30 px-3 py-1 text-[10px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
            data-testid="phase-breakdown-trigger"
          >
            <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
            <span>Phase breakdown</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-0.5 px-3 pb-1.5" data-testid="phase-breakdown-content">
              {metrics.phaseBreakdowns.map((phase) => (
                <PhaseRow
                  key={phase.phaseNumber}
                  phase={phase}
                  onScrollToMessage={onScrollToMessage}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
