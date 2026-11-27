import { memo } from 'react';
import { MarkdownRenderer } from '@/ui/components/shared/MarkdownRenderer';
import { CopyTextButton } from '@/ui/components/shared/CopyTextButton';
import { formatTimestamp } from '@/ui/utils/session-reader-formatters';
import type { LastOutput } from '@/ui/utils/ai-group-enhancer';
import { useTranscriptDisclosure } from '@/ui/hooks/useTranscriptDisclosure';
import { ClampedContent } from './ClampedContent';
import { FullToolResultStatus, useFullToolResult } from './useFullToolResult';

export interface LastOutputDisplayProps {
  sessionId?: string | null;
  lastOutput: LastOutput | null;
  /** Scopes the expand state key; step ids repeat across chunks. */
  chunkId?: string;
  isLive?: boolean;
  hideTimestamp?: boolean;
}

export const LastOutputDisplay = memo(function LastOutputDisplay({
  sessionId,
  lastOutput,
  chunkId,
  isLive = false,
  hideTimestamp = false,
}: LastOutputDisplayProps) {
  const disclosureKey = `${chunkId ?? ''}:last-output:${lastOutput?.stepId ?? ''}`;
  const [expanded, setExpanded] = useTranscriptDisclosure(disclosureKey);
  const fullResult = useFullToolResult({
    sessionId,
    toolCallId: lastOutput?.toolCallId,
    isTruncated: lastOutput?.type === 'tool_result' && lastOutput.isTruncated,
    expanded: expanded && !!lastOutput,
  });

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

  const text = fullResult.fullText ?? lastOutput.text;

  return (
    <div
      className="rounded-md border border-border/40 border-l-2 border-l-status-ok/40 bg-card/60"
      data-testid="last-output-display"
    >
      <div className="flex items-center border-b border-border/40 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>{lastOutput.type === 'tool_result' ? 'Latest tool result' : 'Latest output'}</span>
        {!hideTimestamp && (
          <>
            <span className="mx-1 text-muted-foreground">·</span>
            <span>{formatTimestamp(lastOutput.timestamp.toISOString())}</span>
          </>
        )}
        <CopyTextButton text={text} label="Copy output" className="ml-auto" />
      </div>
      <ClampedContent
        disclosureKey={disclosureKey}
        expanded={expanded}
        onExpandedChange={setExpanded}
        truncated={fullResult.canLoad && fullResult.fullText === null}
        className="px-3 py-2"
        data-testid="last-output-content"
      >
        <MarkdownRenderer
          content={text}
          className="text-sm leading-relaxed [&_p]:my-1 [&_pre]:text-[11px]"
          copyableCode
        />
      </ClampedContent>
      <div className="px-3 empty:hidden">
        <FullToolResultStatus isLoading={fullResult.isLoading} error={fullResult.error} />
      </div>
    </div>
  );
});

LastOutputDisplay.displayName = 'LastOutputDisplay';
