import { memo, useMemo } from 'react';
import { Bot, ChevronRight } from 'lucide-react';
import type { SerializedTurn } from '@/ui/hooks/useSessionTranscript';
import {
  formatDuration,
  formatTimestamp,
  formatTokensCompact as formatTokens,
} from '@/ui/utils/session-reader-formatters';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { SemanticStepList } from './SemanticStepList';

export interface TurnGroupProps {
  sessionId?: string | null;
  turn: SerializedTurn;
  defaultOpen?: boolean;
}

function formatCount(count: number, singular: string, plural: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * @deprecated Use AIGroupCard with semanticSteps instead. Will be removed in cleanup epic.
 */
export const TurnGroup = memo(function TurnGroup({ sessionId, turn, defaultOpen }: TurnGroupProps) {
  const totalTokens = turn.tokens
    ? turn.tokens.input + turn.tokens.output + (turn.tokens.cached ?? 0)
    : 0;
  const summaryCounts = useMemo(
    () =>
      [
        formatCount(turn.summary.thinkingCount, 'thinking', 'thinking'),
        formatCount(turn.summary.toolCallCount, 'tool call', 'tool calls'),
        formatCount(turn.summary.subagentCount, 'subagent', 'subagents'),
        formatCount(turn.summary.outputCount, 'output', 'outputs'),
      ].filter((value): value is string => Boolean(value)),
    [turn.summary],
  );

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger
        className="group flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        data-testid="turn-group-trigger"
      >
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        <Bot className="h-3 w-3" />
        <span>{turn.model ?? 'Assistant'}</span>
        {summaryCounts.length > 0 && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span>{summaryCounts.join(', ')}</span>
          </>
        )}
        {totalTokens > 0 && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="tabular-nums">{formatTokens(totalTokens)}</span>
          </>
        )}
        <span className="text-muted-foreground/50">·</span>
        <span className="tabular-nums">{formatDuration(turn.durationMs)}</span>
        <span className="text-muted-foreground/50">·</span>
        <span>{formatTimestamp(turn.timestamp)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">
        <SemanticStepList sessionId={sessionId} steps={turn.steps} />
      </CollapsibleContent>
    </Collapsible>
  );
});

TurnGroup.displayName = 'TurnGroup';
