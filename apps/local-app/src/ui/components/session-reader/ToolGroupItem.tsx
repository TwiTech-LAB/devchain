import { useMemo } from 'react';
import { cn } from '@/ui/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { ChevronRight, FolderOpen, AlertTriangle, Flame } from 'lucide-react';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import type { ToolGroupDisplayItem } from '@/ui/utils/ai-group-enhancer';
import {
  formatDuration,
  formatTokensSmart as formatTokens,
} from '@/ui/utils/session-reader-formatters';
import { SemanticStepList } from './SemanticStepList';
import { useSessionViewMode } from '@/ui/hooks/useSessionViewMode';

export interface ToolGroupItemProps {
  sessionId?: string | null;
  group: ToolGroupDisplayItem;
  isStepHot?: boolean;
  percentOfChunk?: number;
}

function buildGroupLabel(group: ToolGroupDisplayItem): string {
  const base = `${group.toolName} × ${group.count}`;
  if (!group.commonPathPrefix) return base;

  const prefix = group.commonPathPrefix;
  const maxLen = 40;
  const display = prefix.length > maxLen ? '…' + prefix.slice(prefix.length - maxLen) : prefix;
  return `${base} (${display})`;
}

export function ToolGroupItem({ sessionId, group, isStepHot, percentOfChunk }: ToolGroupItemProps) {
  const { mode } = useSessionViewMode();
  const label = buildGroupLabel(group);

  const innerSteps = useMemo(() => {
    const steps: SerializedSemanticStep[] = [];
    for (const item of group.items) {
      steps.push(item.step as SerializedSemanticStep);
      if (item.linkedResult) {
        steps.push(item.linkedResult as SerializedSemanticStep);
      }
    }
    return steps;
  }, [group.items]);

  return (
    <div
      className={cn(isStepHot && 'border-l-2 border-amber-500 pl-1.5')}
      data-testid="tool-group-wrapper"
    >
      <Collapsible>
        <CollapsibleTrigger
          className="group flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
          data-testid="tool-group-trigger"
        >
          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
          <FolderOpen className="h-3 w-3 text-amber-400" />
          <span className="font-mono font-medium">{label}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {isStepHot && mode === 'diagnostic' && (
              <Flame className="h-3 w-3 text-amber-500" data-testid="tool-group-flame" />
            )}
            {isStepHot && mode === 'diagnostic' && percentOfChunk != null && percentOfChunk > 0 && (
              <span
                className="text-amber-600 font-medium text-[10px] tabular-nums"
                data-testid="tool-group-pct"
              >
                {Math.round(percentOfChunk)}%
              </span>
            )}
            {group.totalTokens > 0 && (
              <span
                className="text-muted-foreground/60 text-[10px] tabular-nums"
                data-testid="tool-group-tokens"
              >
                ~{formatTokens(group.totalTokens)}
              </span>
            )}
            {group.totalDurationMs > 0 && (
              <>
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full bg-green-500"
                  aria-hidden="true"
                />
                <span
                  className="text-muted-foreground/60 text-[10px] tabular-nums"
                  data-testid="tool-group-duration"
                >
                  {formatDuration(group.totalDurationMs)}
                </span>
              </>
            )}
          </span>
          {group.errorCount > 0 && (
            <AlertTriangle className="h-3 w-3 text-destructive" data-testid="tool-group-error" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 pl-4">
            <SemanticStepList sessionId={sessionId} steps={innerSteps} />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
