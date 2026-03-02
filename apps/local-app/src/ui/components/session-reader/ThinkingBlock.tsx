import { useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { ChevronRight, Brain, Flame } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import {
  formatTokensCompact as formatTokens,
  formatDuration,
  truncateText,
} from '@/ui/utils/session-reader-formatters';

const TRUNCATE_THRESHOLD = 5000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ThinkingBlockProps {
  step: SerializedSemanticStep;
  isStepHot?: boolean;
  percentOfChunk?: number;
}

export function ThinkingBlock({ step, isStepHot, percentOfChunk }: ThinkingBlockProps) {
  const text = step.content.thinkingText ?? '';
  const estimatedTokens = step.estimatedTokens ?? 0;
  const previewText = text ? truncateText(text, 80) : '';
  const isLong = text.length > TRUNCATE_THRESHOLD;
  const [showFull, setShowFull] = useState(false);

  const displayText = isLong && !showFull ? text.slice(0, TRUNCATE_THRESHOLD) + '…' : text;

  return (
    <div
      className={cn(isStepHot && 'border-l-2 border-amber-500 pl-1.5')}
      data-testid="thinking-block-wrapper"
    >
      <Collapsible>
        <CollapsibleTrigger
          className="group flex items-center gap-1.5 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
          data-testid="thinking-block-trigger"
        >
          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
          <Brain className="h-3 w-3 text-purple-400" />
          <span>Thinking</span>
          {text && (
            <span
              className="truncate max-w-[300px] text-muted-foreground/60 font-normal"
              data-testid="thinking-preview"
            >
              — {previewText}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {isStepHot && (
              <Flame className="h-3 w-3 text-amber-500" data-testid="step-hotspot-flame" />
            )}
            {isStepHot && percentOfChunk != null && percentOfChunk > 0 && (
              <span
                className="text-amber-600 font-medium text-[10px] tabular-nums"
                data-testid="step-hotspot-pct"
              >
                {Math.round(percentOfChunk)}%
              </span>
            )}
            {estimatedTokens > 0 && (
              <span
                className="text-muted-foreground/60 text-[10px] tabular-nums"
                data-testid="thinking-token-badge"
              >
                ~{formatTokens(estimatedTokens)}
              </span>
            )}
            {step.durationMs > 0 && (
              <span
                className="text-muted-foreground/60 text-[10px] tabular-nums"
                data-testid="thinking-duration"
              >
                {formatDuration(step.durationMs)}
              </span>
            )}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre
            className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground/80 leading-relaxed"
            data-testid="thinking-block-content"
          >
            {displayText}
          </pre>
          {isLong && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowFull((prev) => !prev);
              }}
              className="mt-1 text-[10px] text-primary/80 hover:text-primary transition-colors"
              data-testid="thinking-show-more"
            >
              {showFull ? 'Show less' : 'Show more'}
            </button>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
