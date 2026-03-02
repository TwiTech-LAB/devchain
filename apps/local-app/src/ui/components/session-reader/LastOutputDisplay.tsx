import { memo } from 'react';
import { MarkdownRenderer } from '@/ui/components/shared/MarkdownRenderer';
import { formatTimestamp } from '@/ui/utils/session-reader-formatters';
import type { LastOutput } from '@/ui/utils/ai-group-enhancer';

export interface LastOutputDisplayProps {
  lastOutput: LastOutput | null;
  isLive?: boolean;
  hideTimestamp?: boolean;
}

export const LastOutputDisplay = memo(function LastOutputDisplay({
  lastOutput,
  isLive = false,
  hideTimestamp = false,
}: LastOutputDisplayProps) {
  if (!lastOutput) {
    if (!isLive) return null;
    return (
      <div
        className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
        data-testid="last-output-placeholder"
      >
        No output yet
      </div>
    );
  }

  return (
    <div
      className="rounded-md border border-border/40 bg-card/60"
      data-testid="last-output-display"
    >
      <div className="border-b border-border/40 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>{lastOutput.type === 'tool_result' ? 'Latest tool result' : 'Latest output'}</span>
        {!hideTimestamp && (
          <>
            <span className="mx-1 text-muted-foreground/50">·</span>
            <span>{formatTimestamp(lastOutput.timestamp.toISOString())}</span>
          </>
        )}
      </div>
      <div className="max-h-96 overflow-y-auto px-3 py-2" data-testid="last-output-content">
        <MarkdownRenderer
          content={lastOutput.text}
          className="text-xs leading-relaxed [&_p]:my-1 [&_pre]:text-[11px]"
        />
      </div>
    </div>
  );
});

LastOutputDisplay.displayName = 'LastOutputDisplay';
