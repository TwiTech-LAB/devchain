import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { ChevronRight, Layers } from 'lucide-react';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import {
  formatTokensCompact as formatTokens,
  formatDuration,
} from '@/ui/utils/session-reader-formatters';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SubagentItemProps {
  step: SerializedSemanticStep;
}

export function SubagentItem({ step }: SubagentItemProps) {
  const description = step.content.subagentDescription ?? 'Subagent task';
  const totalTokens = step.tokens ? step.tokens.input + step.tokens.output : 0;
  const model = step.content.sourceModel;

  return (
    <Collapsible>
      <CollapsibleTrigger
        className="group flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
        data-testid="subagent-trigger"
      >
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        <Layers className="h-3 w-3 text-blue-400" />
        <span className="font-medium">{description}</span>
        {step.durationMs > 0 && (
          <span className="text-muted-foreground/60 text-[10px] tabular-nums">
            {formatDuration(step.durationMs)}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className="mt-1 rounded-md border border-border/30 bg-muted/20 px-2.5 py-2 text-[11px] text-muted-foreground"
          data-testid="subagent-details"
        >
          <div className="space-y-1">
            {model && (
              <div className="flex items-center justify-between">
                <span>Model</span>
                <span className="tabular-nums">{model}</span>
              </div>
            )}
            {totalTokens > 0 && (
              <div className="flex items-center justify-between">
                <span>Tokens</span>
                <span className="tabular-nums">{formatTokens(totalTokens)}</span>
              </div>
            )}
            {step.durationMs > 0 && (
              <div className="flex items-center justify-between">
                <span>Duration</span>
                <span className="tabular-nums">{formatDuration(step.durationMs)}</span>
              </div>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
