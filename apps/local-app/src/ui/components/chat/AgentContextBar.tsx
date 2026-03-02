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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentContextBar({
  contextPercent,
  totalContextTokens,
  contextWindowTokens,
}: AgentContextBarProps) {
  if (contextPercent === 0 || contextWindowTokens === 0) return null;

  const colorClass =
    contextPercent > 80 ? 'bg-destructive' : contextPercent > 50 ? 'bg-amber-500' : 'bg-primary/60';

  const pctLabel = formatContextPercent(totalContextTokens, contextWindowTokens);
  const tooltipText = `Context: ${pctLabel} used (${formatTokensCompact(totalContextTokens)} of ${formatTokensCompact(contextWindowTokens)})`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="h-[2px] w-full rounded-full bg-muted/40"
            role="progressbar"
            aria-valuenow={Math.round(contextPercent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`Context window ${pctLabel} used`}
            aria-label="Context window usage"
          >
            <div
              className={`h-full rounded-full transition-all ${colorClass}`}
              style={{ width: `${contextPercent}%` }}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {tooltipText}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
