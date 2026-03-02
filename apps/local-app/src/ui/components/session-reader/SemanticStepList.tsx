import { memo, useMemo } from 'react';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import type { StepHotspotEntry } from '@/ui/utils/hotspot-detection';
import { MarkdownRenderer } from '@/ui/components/shared/MarkdownRenderer';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCallItem } from './ToolCallItem';
import { SubagentItem } from './SubagentItem';

export interface SemanticStepListProps {
  sessionId?: string | null;
  steps: SerializedSemanticStep[];
  stepHotspots?: Map<string, StepHotspotEntry>;
}

export const SemanticStepList = memo(function SemanticStepList({
  sessionId,
  steps,
  stepHotspots,
}: SemanticStepListProps) {
  const toolCallIdSet = useMemo(
    () =>
      new Set(
        steps
          .filter((step) => step.type === 'tool_call' && step.content.toolCallId)
          .map((step) => step.content.toolCallId as string),
      ),
    [steps],
  );

  // Build a map of tool_call id → corresponding tool_result step.
  const resultMap = useMemo(() => {
    const map = new Map<string, SerializedSemanticStep>();
    for (const step of steps) {
      if (step.type === 'tool_result' && step.content.toolCallId) {
        map.set(step.content.toolCallId, step);
      }
    }
    return map;
  }, [steps]);

  return (
    <div className="space-y-1.5" data-testid="semantic-step-list">
      {steps.map((step) => {
        switch (step.type) {
          case 'thinking': {
            const thinkingHotspot = stepHotspots?.get(step.id);
            return (
              <ThinkingBlock
                key={step.id}
                step={step}
                isStepHot={thinkingHotspot?.isHot}
                percentOfChunk={thinkingHotspot?.percentOfChunk}
              />
            );
          }
          case 'tool_call': {
            const toolHotspot = stepHotspots?.get(step.id);
            return (
              <ToolCallItem
                key={step.id}
                sessionId={sessionId}
                step={step}
                resultStep={
                  step.content.toolCallId ? resultMap.get(step.content.toolCallId) : undefined
                }
                isStepHot={toolHotspot?.isHot}
                percentOfChunk={toolHotspot?.percentOfChunk}
              />
            );
          }
          case 'subagent':
            return <SubagentItem key={step.id} step={step} />;
          case 'output':
            return step.content.outputText?.trim() ? (
              <div key={step.id} className="border-l-2 border-emerald-400/40 pl-2">
                <MarkdownRenderer
                  content={step.content.outputText}
                  className="text-xs leading-relaxed [&_p]:my-1"
                />
              </div>
            ) : null;
          case 'tool_result': {
            const callId = step.content.toolCallId;
            if (callId && toolCallIdSet.has(callId)) {
              return null;
            }
            const resultText =
              typeof step.content.toolResultContent === 'string'
                ? step.content.toolResultContent
                : step.content.toolResultContent
                  ? JSON.stringify(step.content.toolResultContent, null, 2)
                  : '';
            if (!resultText.trim()) return null;

            return (
              <pre
                key={step.id}
                className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground/80 leading-relaxed"
                data-testid="orphan-tool-result"
              >
                {resultText}
              </pre>
            );
          }
          // interruption/other skipped
          default:
            return null;
        }
      })}
    </div>
  );
});

SemanticStepList.displayName = 'SemanticStepList';
