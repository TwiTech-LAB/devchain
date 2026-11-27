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
import { useSessionViewMode } from '@/ui/hooks/useSessionViewMode';
import { useTranscriptDisclosure } from '@/ui/hooks/useTranscriptDisclosure';
import { ClampedContent } from './ClampedContent';

const TRUNCATE_THRESHOLD = 5000;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ThinkingBlockProps {
  step: SerializedSemanticStep;
  /** Scopes the open-state keys; step ids repeat across chunks. */
  chunkId?: string;
  isStepHot?: boolean;
  percentOfChunk?: number;
}

export function ThinkingBlock({
  step,
  chunkId = '',
  isStepHot,
  percentOfChunk,
}: ThinkingBlockProps) {
  const { mode } = useSessionViewMode();
  const text = step.content.thinkingText ?? '';
  const estimatedTokens = step.estimatedTokens ?? 0;
  const previewText = text ? truncateText(text, 80) : '';
  const isLong = text.length > TRUNCATE_THRESHOLD;
  const [open, setOpen] = useTranscriptDisclosure(`${chunkId}:${step.id}:section`);
  const [showFull, setShowFull] = useTranscriptDisclosure(`${chunkId}:${step.id}:content`);

  // The character cap bounds the DOM size of the collapsed preview.
  const displayText = isLong && !showFull ? text.slice(0, TRUNCATE_THRESHOLD) + '…' : text;

  return (
    <div
      className={cn(isStepHot && 'border-l-2 border-status-warn pl-1.5')}
      data-testid="thinking-block-wrapper"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="group flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
          data-testid="thinking-block-trigger"
        >
          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
          <Brain className="h-3 w-3 text-purple-400" />
          <span>Thinking</span>
          {text && (
            <span
              className="truncate max-w-[300px] text-muted-foreground font-mono italic"
              data-testid="thinking-preview"
            >
              — {previewText}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {isStepHot && mode === 'diagnostic' && (
              <Flame className="h-3 w-3 text-status-warn" data-testid="step-hotspot-flame" />
            )}
            {isStepHot && mode === 'diagnostic' && percentOfChunk != null && percentOfChunk > 0 && (
              <span
                className="text-status-warn font-medium text-[10px] tabular-nums"
                data-testid="step-hotspot-pct"
              >
                {Math.round(percentOfChunk)}%
              </span>
            )}
            {estimatedTokens > 0 && (
              <span
                className="text-muted-foreground text-[10px] tabular-nums"
                data-testid="thinking-token-badge"
              >
                ~{formatTokens(estimatedTokens)}
              </span>
            )}
            {step.durationMs > 0 && (
              <span
                className="text-muted-foreground text-[10px] tabular-nums"
                data-testid="thinking-duration"
              >
                {formatDuration(step.durationMs)}
              </span>
            )}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ClampedContent
            disclosureKey={`${chunkId}:${step.id}:content`}
            expanded={showFull}
            onExpandedChange={setShowFull}
            maxHeight={256}
            truncated={isLong}
            className="mt-1"
            fadeClassName="from-muted"
          >
            <pre
              className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-foreground leading-relaxed"
              data-testid="thinking-block-content"
            >
              {displayText}
            </pre>
          </ClampedContent>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
