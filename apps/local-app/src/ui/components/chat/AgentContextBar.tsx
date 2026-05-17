import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { formatContextPercent, formatTokensCompact } from '@/ui/utils/session-reader-formatters';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AgentContextBarProps {
  contextPercent: number;
  totalContextTokens: number;
  contextWindowTokens: number;
}

type ContextTier = 'healthy' | 'medium' | 'high' | 'critical';

function getContextTier(contextPercent: number): ContextTier {
  if (contextPercent >= 90) return 'critical';
  if (contextPercent >= 80) return 'high';
  if (contextPercent >= 50) return 'medium';
  return 'healthy';
}

const contextTierFillClass: Record<ContextTier, string> = {
  healthy: 'bg-primary',
  medium: 'bg-amber-500',
  high: 'bg-orange-500',
  critical: 'bg-destructive',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentContextBar({
  contextPercent,
  totalContextTokens,
  contextWindowTokens,
}: AgentContextBarProps) {
  if (contextPercent === 0 || contextWindowTokens === 0) return null;

  const tier = getContextTier(contextPercent);
  const pctLabel = formatContextPercent(totalContextTokens, contextWindowTokens);
  const tooltipText = `Context: ${pctLabel} used (${formatTokensCompact(totalContextTokens)} of ${formatTokensCompact(contextWindowTokens)})`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="w-full"
            role="progressbar"
            aria-valuenow={Math.round(contextPercent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`Context window ${pctLabel} used`}
            aria-label="Context window usage"
            data-context-tier={tier}
          >
            <span className="block h-px w-full overflow-hidden rounded-full bg-muted">
              <span
                className={`block h-full rounded-full transition-all ${contextTierFillClass[tier]}`}
                style={{ width: `${contextPercent}%` }}
              />
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
