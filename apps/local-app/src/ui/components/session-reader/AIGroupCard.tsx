import { memo, useMemo } from 'react';
import { Bot, ChevronDown, Flame } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import type {
  SerializedChunk,
  SerializedMessage,
  SerializedSemanticStep,
} from '@/ui/hooks/useSessionTranscript';
import {
  buildDisplayItems,
  buildSummary,
  findLastOutput,
  getHeaderInputTotal,
  getHeaderTokens,
  type DisplayItem,
  type EnhancerStep,
} from '@/ui/utils/ai-group-enhancer';
import { classifyDisplayItemHotspots } from '@/ui/utils/hotspot-detection';
import {
  formatDuration,
  formatTimestamp,
  formatTokensCompact as formatTokens,
} from '@/ui/utils/session-reader-formatters';
import { SemanticStepList } from './SemanticStepList';
import { LastOutputDisplay } from './LastOutputDisplay';

export interface AIGroupCardProps {
  sessionId?: string | null;
  chunk: SerializedChunk & { type: 'ai' };
  isExpanded: boolean;
  isLive?: boolean;
  isHot?: boolean;
  contextPct?: number;
  inputDelta?: number;
  stepHotspotThreshold?: number | null;
  onToggle: () => void;
  onLayoutChange?: () => void;
}

function flattenDisplayItems(items: DisplayItem[]): SerializedSemanticStep[] {
  const steps: SerializedSemanticStep[] = [];
  for (const item of items) {
    if (item.type !== 'tool') {
      steps.push(item.step as SerializedSemanticStep);
      continue;
    }

    if (item.step.type === 'tool_call') {
      steps.push(item.step as SerializedSemanticStep);
      if (item.linkedResult) {
        steps.push(item.linkedResult as SerializedSemanticStep);
      }
      continue;
    }

    // Orphan tool_result: preserve it so SemanticStepList can render fallback output.
    steps.push(item.step as SerializedSemanticStep);
  }
  return steps;
}

function getChunkModel(messages: SerializedMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.model) {
      return message.model;
    }
  }
  return 'Assistant';
}

export const AIGroupCard = memo(function AIGroupCard({
  sessionId,
  chunk,
  isExpanded,
  isLive = false,
  isHot,
  contextPct,
  inputDelta,
  stepHotspotThreshold,
  onToggle,
  onLayoutChange,
}: AIGroupCardProps) {
  const semanticSteps = useMemo(
    () => (chunk.semanticSteps ?? []) as EnhancerStep[],
    [chunk.semanticSteps],
  );
  const model = useMemo(() => getChunkModel(chunk.messages), [chunk.messages]);
  const lastOutput = useMemo(() => findLastOutput(semanticSteps), [semanticSteps]);
  const displayItems = useMemo(
    () => buildDisplayItems(semanticSteps, lastOutput?.stepId ?? null),
    [lastOutput?.stepId, semanticSteps],
  );
  const displayItemSteps = useMemo(() => flattenDisplayItems(displayItems), [displayItems]);
  const summary = useMemo(() => buildSummary(displayItems), [displayItems]);
  const headerTokens = useMemo(() => getHeaderTokens(chunk), [chunk]);
  const timestampIso = useMemo(
    () => chunk.endTime ?? chunk.messages[chunk.messages.length - 1]?.timestamp ?? chunk.startTime,
    [chunk.endTime, chunk.messages, chunk.startTime],
  );

  // Step-level hotspot classification — only when expanded and threshold available
  const stepHotspots = useMemo(() => {
    if (!isExpanded || stepHotspotThreshold == null) return undefined;
    return classifyDisplayItemHotspots(displayItems, stepHotspotThreshold);
  }, [isExpanded, stepHotspotThreshold, displayItems]);

  return (
    <div
      className={cn(
        'border-l-2 py-1 pl-3',
        isHot
          ? 'border-amber-500/70 hover:border-amber-500'
          : 'border-primary/30 hover:border-primary/50',
      )}
      data-testid="ai-group-card"
    >
      <button
        type="button"
        role="button"
        onClick={() => {
          onToggle();
          onLayoutChange?.();
        }}
        className="flex w-full items-start justify-between gap-2 rounded-md px-1 py-1 text-left hover:bg-muted/40"
        data-testid="ai-group-header"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Bot className="h-3 w-3" />
            {isHot && <Flame className="h-3 w-3 text-amber-500" data-testid="ai-group-flame" />}
            <span>{model}</span>
            <span className="text-muted-foreground/50">·</span>
            <span className="truncate">{summary}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            {headerTokens && (
              <span className="tabular-nums">
                in {formatTokens(getHeaderInputTotal(chunk) ?? 0)}
                {inputDelta != null && inputDelta > 0 && (
                  <span
                    className="text-muted-foreground/50 ml-0.5"
                    data-testid="ai-group-input-delta"
                  >
                    (+{formatTokens(inputDelta)})
                  </span>
                )}
                {' · '}
                out {formatTokens(headerTokens.output)}
              </span>
            )}
            <span>{formatDuration(chunk.metrics.durationMs)}</span>
            <span>{formatTimestamp(timestampIso)}</span>
            {isHot && contextPct != null && (
              <span
                className="text-amber-600 font-medium tabular-nums"
                data-testid="ai-group-ctx-pct"
              >
                {contextPct < 1 ? '<1%' : `${Math.round(contextPct)}%`}
              </span>
            )}
          </div>
        </div>
        <ChevronDown
          className={cn('mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', {
            'rotate-180': isExpanded,
          })}
        />
      </button>

      {isExpanded && displayItemSteps.length > 0 && (
        <div className="mt-1 pl-4" data-testid="ai-group-expanded">
          <SemanticStepList
            sessionId={sessionId}
            steps={displayItemSteps}
            stepHotspots={stepHotspots}
          />
        </div>
      )}

      <div className="mt-2 pl-4">
        <LastOutputDisplay lastOutput={lastOutput} isLive={isLive} hideTimestamp />
      </div>
    </div>
  );
});

AIGroupCard.displayName = 'AIGroupCard';
