import * as React from 'react';
import { cn } from '@/ui/lib/utils';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/ui/components/ui/tooltip';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuCheckboxItem,
} from '@/ui/components/ui/context-menu';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';
import {
  formatTokensCompact as formatTokens,
  formatCost,
  formatContextPercent,
} from '@/ui/utils/session-reader-formatters';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 200_000;
const CHIP_VISIBLE_ITEMS_STORAGE_KEY = 'devchain:chipVisibleItems';

type ChipVisibleItems = {
  tokens: boolean;
  cost: boolean;
  context: boolean;
  compactions: boolean;
};

const DEFAULT_VISIBLE_ITEMS: ChipVisibleItems = {
  tokens: true,
  cost: true,
  context: true,
  compactions: true,
};

function readChipPrefs(): ChipVisibleItems {
  if (typeof window === 'undefined') return DEFAULT_VISIBLE_ITEMS;
  try {
    const raw = window.localStorage.getItem(CHIP_VISIBLE_ITEMS_STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBLE_ITEMS;

    const parsed = JSON.parse(raw) as Partial<ChipVisibleItems>;
    return {
      tokens: parsed.tokens !== false,
      cost: parsed.cost !== false,
      context: parsed.context !== false,
      compactions: parsed.compactions !== false,
    };
  } catch {
    return DEFAULT_VISIBLE_ITEMS;
  }
}

function writeChipPrefs(next: ChipVisibleItems) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHIP_VISIBLE_ITEMS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage write failures
  }
}

export interface InlineSessionSummaryChipProps {
  /** Session metrics to display */
  metrics: UnifiedMetrics;
  /** Current active tab in the panel */
  activeTab: 'terminal' | 'session';
  /** Switch panel to Session tab */
  onSwitchToSession: () => void;
  /** Optional extra className */
  className?: string;
}

// ---------------------------------------------------------------------------
// Popover content (detailed metrics breakdown)
// ---------------------------------------------------------------------------

function MetricsPopoverContent({ metrics }: { metrics: UnifiedMetrics }) {
  const contextWindow = metrics.contextWindowTokens || 200_000;
  const totalContext = metrics.totalContextTokens;
  const modelCount = metrics.modelsUsed?.length ?? (metrics.primaryModel ? 1 : 0);

  return (
    <div className="space-y-2 text-xs">
      <div className="font-medium text-popover-foreground">Session Metrics</div>
      <div className="space-y-1 text-muted-foreground">
        <MetricRow label="Input Tokens" value={formatTokens(metrics.inputTokens)} />
        <MetricRow label="Cache Read" value={formatTokens(metrics.cacheReadTokens)} />
        <MetricRow label="Cache Write" value={formatTokens(metrics.cacheCreationTokens)} />
        <MetricRow label="Output Tokens" value={formatTokens(metrics.outputTokens)} />
        <div className="my-1 border-t border-border" />
        <MetricRow
          label="Total"
          value={formatTokens(metrics.totalTokens)}
          className="font-medium text-popover-foreground"
        />
        <MetricRow label="Cost" value={formatCost(metrics.costUsd)} />
        <MetricRow
          label="Visible Context"
          value={`${formatTokens(metrics.visibleContextTokens)} (${formatContextPercent(metrics.visibleContextTokens, totalContext)} of total)`}
        />
        <MetricRow label="Total Context" value={formatTokens(totalContext)} />
        <MetricRow
          label="Context Window"
          value={`${formatContextPercent(totalContext, contextWindow)} used (of ${formatTokens(contextWindow)})`}
        />
        <MetricRow
          label="Model"
          value={metrics.primaryModel + (modelCount > 1 ? ` (+${modelCount - 1})` : '')}
        />
        {metrics.compactionCount > 0 && (
          <MetricRow label="Compactions" value={String(metrics.compactionCount)} />
        )}
      </div>
    </div>
  );
}

function MetricRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function InlineSessionSummaryChip({
  metrics,
  activeTab,
  onSwitchToSession,
  className,
}: InlineSessionSummaryChipProps) {
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const [visible, setVisible] = React.useState<ChipVisibleItems>(() => readChipPrefs());
  const contextWindow = metrics.contextWindowTokens || DEFAULT_CONTEXT_WINDOW;
  const totalContext = metrics.totalContextTokens;
  const windowPctRaw = contextWindow > 0 ? (totalContext / contextWindow) * 100 : 0;
  const windowPct = Math.max(0, Math.min(windowPctRaw, 100));
  const modelCount = metrics.modelsUsed?.length ?? (metrics.primaryModel ? 1 : 0);

  const handleClick = React.useCallback(() => {
    if (activeTab === 'terminal') {
      onSwitchToSession();
    }
  }, [activeTab, onSwitchToSession]);

  const handleContextMenuShortcut = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (
        event.key === 'F10' &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        buttonRef.current?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
          }),
        );
      }
    },
    [],
  );

  const setVisibleItem = React.useCallback(
    (key: keyof ChipVisibleItems, checked: boolean | 'indeterminate') => {
      const nextChecked = checked === true;
      setVisible((previous) => {
        const next = { ...previous, [key]: nextChecked };
        writeChipPrefs(next);
        return next;
      });
    },
    [],
  );

  const formattedWindowPct = formatContextPercent(totalContext, contextWindow);
  const contextBarColorClass =
    windowPct > 80 ? 'bg-destructive' : windowPct > 50 ? 'bg-amber-500' : 'bg-primary/60';

  const parts: React.ReactNode[] = [
    <span key="model" className="max-w-[120px] truncate" title={metrics.primaryModel}>
      {metrics.primaryModel}
    </span>,
    ...(visible.tokens
      ? [
          <span key="tokens" className="tabular-nums">
            {formatTokens(metrics.totalTokens)}
          </span>,
        ]
      : []),
    ...(visible.cost
      ? [
          <span key="cost" className="tabular-nums">
            {formatCost(metrics.costUsd)}
          </span>,
        ]
      : []),
    ...(visible.context
      ? [
          <span key="context" className="inline-flex items-center gap-1">
            <span className="tabular-nums">{formattedWindowPct}</span>
            <span
              className="inline-block h-1.5 w-10 overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuenow={Math.round(windowPct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Context window ${Math.round(windowPct)}% used`}
            >
              <span
                className={cn('block h-full rounded-full transition-all', contextBarColorClass)}
                style={{ width: `${windowPct}%` }}
              />
            </span>
          </span>,
        ]
      : []),
    ...(visible.compactions && metrics.compactionCount > 0
      ? [
          <span key="compactions" className="tabular-nums">
            {metrics.compactionCount} compaction{metrics.compactionCount === 1 ? '' : 's'}
          </span>,
        ]
      : []),
  ];

  const inlineParts = parts.flatMap((part, index) =>
    index === 0
      ? [part]
      : [
          <span key={`sep-${index}`} className="text-muted-foreground/50" aria-hidden="true">
            ·
          </span>,
          part,
        ],
  );

  const ariaLabel =
    `Session metrics: model ${metrics.primaryModel}` +
    `${modelCount > 1 ? ` plus ${modelCount - 1} more` : ''}, ` +
    `total ${formatTokens(metrics.totalTokens)} tokens, ` +
    `cost ${formatCost(metrics.costUsd)}, ` +
    `context window ${formattedWindowPct} used, ` +
    `compactions ${metrics.compactionCount}` +
    (metrics.isOngoing ? ', ongoing' : '');

  return (
    <TooltipProvider delayDuration={300}>
      <ContextMenu onOpenChange={setMenuOpen}>
        <Tooltip open={!menuOpen && tooltipOpen} onOpenChange={setTooltipOpen}>
          <ContextMenuTrigger asChild>
            <TooltipTrigger asChild>
              <button
                ref={buttonRef}
                type="button"
                onClick={handleClick}
                onKeyDown={handleContextMenuShortcut}
                aria-label={ariaLabel}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  className,
                )}
              >
                <span
                  className={cn(
                    'inline-block h-1.5 w-1.5 rounded-full',
                    metrics.isOngoing ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/50',
                  )}
                  aria-hidden="true"
                />
                {inlineParts}
              </button>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <TooltipContent align="end" className="w-64 p-3">
            <MetricsPopoverContent metrics={metrics} />
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent className="w-48">
          <ContextMenuLabel>Visible Items</ContextMenuLabel>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem
            checked={visible.tokens}
            onCheckedChange={(checked) => setVisibleItem('tokens', checked)}
          >
            Tokens
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={visible.cost}
            onCheckedChange={(checked) => setVisibleItem('cost', checked)}
          >
            Cost
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={visible.context}
            onCheckedChange={(checked) => setVisibleItem('context', checked)}
          >
            Context
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={visible.compactions}
            onCheckedChange={(checked) => setVisibleItem('compactions', checked)}
          >
            Compactions
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>
    </TooltipProvider>
  );
}
