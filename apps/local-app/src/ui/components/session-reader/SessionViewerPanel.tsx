import { memo, useMemo } from 'react';
import { cn } from '@/ui/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import {
  ChevronRight,
  User,
  Bot,
  Terminal,
  Layers,
  Brain,
  Wrench,
  AlertTriangle,
} from 'lucide-react';
import type { SerializedMessage, SerializedChunk } from '@/ui/hooks/useSessionTranscript';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';
import type {
  UnifiedContentBlock,
  UnifiedToolCall,
  UnifiedToolResult,
} from '@/modules/session-reader/dtos/unified-session.types';
import {
  formatTokensCompact as formatTokens,
  formatTimestamp,
  truncateText,
} from '@/ui/utils/session-reader-formatters';
import { MarkdownRenderer } from '@/ui/components/shared/MarkdownRenderer';
import { CopyTextButton } from '@/ui/components/shared/CopyTextButton';
import { SessionMetricsHeader } from './SessionMetricsHeader';
import { AIGroupCard } from './AIGroupCard';
import { SessionViewModeProvider } from '@/ui/hooks/useSessionViewMode';
import { PagedSessionMessageList, type ChunkRendererProps } from './PagedSessionMessageList';
import { ClampedContent } from './ClampedContent';
import { useTranscriptDisclosure } from '@/ui/hooks/useTranscriptDisclosure';
import { FullToolResultStatus, loadFullResultLabel, useFullToolResult } from './useFullToolResult';

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

function extractText(content: UnifiedContentBlock[]): string {
  return content
    .filter((b): b is Extract<UnifiedContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function extractThinking(content: UnifiedContentBlock[]): string[] {
  return content
    .filter((b): b is Extract<UnifiedContentBlock, { type: 'thinking' }> => b.type === 'thinking')
    .map((b) => b.thinking);
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SessionViewerPanelProps {
  sessionId?: string | null;
  metrics?: UnifiedMetrics;
  isLive: boolean;
}

// ---------------------------------------------------------------------------
// Thinking Block
// ---------------------------------------------------------------------------

function ThinkingBlock({ text, disclosureKey }: { text: string; disclosureKey: string }) {
  const [open, setOpen] = useTranscriptDisclosure(`${disclosureKey}:section`);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        <Brain className="h-3 w-3" />
        <span>Thinking</span>
        <span className="ml-1 text-muted-foreground font-mono italic">
          ({truncateText(text, 40)})
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ClampedContent
          disclosureKey={disclosureKey}
          maxHeight={192}
          className="mt-1"
          fadeClassName="from-muted"
          data-testid="fallback-thinking"
        >
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-foreground leading-relaxed">
            {text}
          </pre>
        </ClampedContent>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Tool Call Block
// ---------------------------------------------------------------------------

interface ToolCallBlockProps {
  sessionId?: string | null;
  messageId: string;
  toolCall: UnifiedToolCall;
  result?: UnifiedToolResult;
}

const INPUT_PREVIEW_CHARS = 120;
const RESULT_PREVIEW_CHARS = 500;

const ToolCallBlock = memo(function ToolCallBlock({
  sessionId,
  messageId,
  toolCall,
  result,
}: ToolCallBlockProps) {
  const isTask = toolCall.isTask;
  const keyPrefix = `${messageId}:tool:${toolCall.id}`;
  const [open, setOpen] = useTranscriptDisclosure(`${keyPrefix}:section`);
  const [inputExpanded, setInputExpanded] = useTranscriptDisclosure(`${keyPrefix}:input`);
  const [resultExpanded, setResultExpanded] = useTranscriptDisclosure(`${keyPrefix}:result`);
  const fullResult = useFullToolResult({
    sessionId,
    toolCallId: toolCall.id,
    isTruncated: result?.isTruncated,
    expanded: resultExpanded,
  });

  const compactInput = useMemo(() => JSON.stringify(toolCall.input) ?? '', [toolCall.input]);
  const fullInput = useMemo(() => JSON.stringify(toolCall.input, null, 2) ?? '', [toolCall.input]);
  const isInputLong = compactInput.length > INPUT_PREVIEW_CHARS;

  const toolResultText = useMemo(() => {
    if (!result) return null;
    return typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content, null, 2);
  }, [result]);
  const resultText = fullResult.fullText ?? toolResultText;
  const isResultCut = fullResult.canLoad && fullResult.fullText === null;
  const isResultLong = (resultText?.length ?? 0) > RESULT_PREVIEW_CHARS;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        {isTask ? <Layers className="h-3 w-3 text-status-info" /> : <Wrench className="h-3 w-3" />}
        <span className="font-mono font-medium">{toolCall.name}</span>
        {isTask && toolCall.taskDescription && (
          <span className="ml-1 text-muted-foreground">
            — {truncateText(toolCall.taskDescription, 50)}
          </span>
        )}
        {result?.isError && <AlertTriangle className="h-3 w-3 text-destructive" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-1">
          <ClampedContent
            disclosureKey={`${keyPrefix}:input`}
            expanded={inputExpanded}
            onExpandedChange={setInputExpanded}
            maxHeight={128}
            truncated={isInputLong}
            fadeClassName="from-muted"
            data-testid="fallback-tool-input"
          >
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-foreground leading-relaxed">
              {inputExpanded ? fullInput : truncateText(compactInput, INPUT_PREVIEW_CHARS)}
            </pre>
          </ClampedContent>
          {resultText && (
            <ClampedContent
              disclosureKey={`${keyPrefix}:result`}
              expanded={resultExpanded}
              onExpandedChange={setResultExpanded}
              maxHeight={128}
              truncated={isResultLong || isResultCut}
              collapsedLabel={isResultCut ? loadFullResultLabel(result?.fullLength) : undefined}
              fadeClassName={result?.isError ? 'from-destructive/10' : 'from-muted'}
              data-testid="fallback-tool-result"
            >
              <pre
                className={cn(
                  'overflow-x-auto whitespace-pre-wrap rounded-md p-2 text-[11px] leading-relaxed',
                  result?.isError
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted/40 text-foreground',
                )}
              >
                {resultExpanded || isResultCut
                  ? resultText
                  : truncateText(resultText, RESULT_PREVIEW_CHARS)}
              </pre>
            </ClampedContent>
          )}
          <FullToolResultStatus isLoading={fullResult.isLoading} error={fullResult.error} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

ToolCallBlock.displayName = 'ToolCallBlock';

// ---------------------------------------------------------------------------
// Message Cards
// ---------------------------------------------------------------------------

interface MessageCardProps {
  sessionId?: string | null;
  message: SerializedMessage;
}

const UserMessageCard = memo(function UserMessageCard({
  message,
  chunkId,
}: MessageCardProps & { chunkId?: string }) {
  const text = useMemo(() => extractText(message.content), [message.content]);
  const timestampText = useMemo(() => formatTimestamp(message.timestamp), [message.timestamp]);

  if (!text.trim()) return null;

  return (
    <div className="flex justify-end" data-testid="user-message-card">
      <div className="max-w-[85%] rounded-lg bg-primary/10 px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <User className="h-3 w-3" />
          <span>User</span>
          <span className="text-muted-foreground">·</span>
          <span>{timestampText}</span>
        </div>
        <ClampedContent
          disclosureKey={chunkId ? `${chunkId}:user:${message.id}` : `${message.id}:user`}
          fadeClassName="from-background"
        >
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{text}</div>
        </ClampedContent>
      </div>
    </div>
  );
});

UserMessageCard.displayName = 'UserMessageCard';

const AIMessageCard = memo(function AIMessageCard({ sessionId, message }: MessageCardProps) {
  const text = useMemo(() => extractText(message.content), [message.content]);
  const thinkingBlocks = useMemo(() => extractThinking(message.content), [message.content]);
  const toolResultMap = useMemo(
    () => new Map(message.toolResults.map((r) => [r.toolCallId, r])),
    [message.toolResults],
  );
  const timestampText = useMemo(() => formatTimestamp(message.timestamp), [message.timestamp]);

  return (
    <div className="flex justify-start" data-testid="ai-message-card">
      <div className="max-w-[90%] space-y-2 rounded-lg border border-border/40 bg-card px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Bot className="h-3 w-3" />
          <span>{message.model ?? 'Assistant'}</span>
          <span className="text-muted-foreground">·</span>
          <span>{timestampText}</span>
          {message.usage && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="tabular-nums">
                {formatTokens(message.usage.input + message.usage.output)}
              </span>
            </>
          )}
          {text.trim() && <CopyTextButton text={text} label="Copy message" className="ml-auto" />}
        </div>

        {/* Thinking blocks (collapsible, dimmed) */}
        {thinkingBlocks.map((thinking, idx) => (
          <ThinkingBlock
            key={`thinking-${idx}`}
            text={thinking}
            disclosureKey={`${message.id}:thinking:${idx}`}
          />
        ))}

        {/* Tool calls (collapsible) */}
        {message.toolCalls.map((tc) => (
          <ToolCallBlock
            key={tc.id}
            sessionId={sessionId}
            messageId={message.id}
            toolCall={tc}
            result={toolResultMap.get(tc.id)}
          />
        ))}

        {/* Output text (markdown rendered) */}
        {text.trim() && (
          <MarkdownRenderer
            content={text}
            className="text-sm leading-relaxed [&_p]:my-1"
            copyableCode
          />
        )}
      </div>
    </div>
  );
});

AIMessageCard.displayName = 'AIMessageCard';

const SystemMessageCard = memo(function SystemMessageCard({ message }: MessageCardProps) {
  const text = useMemo(() => extractText(message.content), [message.content]);
  const timestampText = useMemo(() => formatTimestamp(message.timestamp), [message.timestamp]);

  if (!text.trim()) return null;

  return (
    <div className="flex justify-start" data-testid="system-message-card">
      <div className="max-w-[90%] rounded-lg border border-border/20 bg-muted/20 px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Terminal className="h-3 w-3" />
          <span>System</span>
          <span className="text-muted-foreground">·</span>
          <span>{timestampText}</span>
        </div>
        <div className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">{text}</div>
      </div>
    </div>
  );
});

SystemMessageCard.displayName = 'SystemMessageCard';

function CompactMarker() {
  return (
    <div className="flex items-center gap-2 py-2" data-testid="compact-marker">
      <div className="flex-1 border-t border-dashed border-status-warn/40" />
      <span className="rounded-full bg-status-warn/10 px-3 py-0.5 text-[10px] font-medium text-status-warn">
        Context compacted
      </span>
      <div className="flex-1 border-t border-dashed border-status-warn/40" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chunk-based rendering
// ---------------------------------------------------------------------------

function renderMessage(msg: SerializedMessage, sessionId?: string | null, chunkId?: string) {
  if (msg.isCompactSummary) return <CompactMarker key={msg.id} />;
  switch (msg.role) {
    case 'user':
      return <UserMessageCard key={msg.id} message={msg} chunkId={chunkId} />;
    case 'assistant':
      return <AIMessageCard key={msg.id} sessionId={sessionId} message={msg} />;
    case 'system':
      return <SystemMessageCard key={msg.id} message={msg} />;
    default:
      return null;
  }
}

const ChunkRenderer = memo(function ChunkRenderer({
  sessionId,
  chunk,
  isLive,
  isAiGroupExpanded = false,
  onAiGroupToggle,
}: ChunkRendererProps) {
  return (
    <div className="space-y-3" data-testid={`chunk-${chunk.type}`}>
      {chunk.type === 'ai' && chunk.semanticSteps ? (
        <AIGroupCard
          sessionId={sessionId}
          chunk={chunk as SerializedChunk & { type: 'ai' }}
          isExpanded={isAiGroupExpanded}
          isLive={isLive}
          onToggle={() => onAiGroupToggle?.(chunk.id)}
        />
      ) : (
        chunk.messages.map((msg) => renderMessage(msg, sessionId, chunk.id))
      )}
    </div>
  );
});

ChunkRenderer.displayName = 'ChunkRenderer';

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

export function SessionViewerPanel({ sessionId, metrics, isLive }: SessionViewerPanelProps) {
  if (!sessionId) {
    return (
      <div className="flex h-full flex-col" data-testid="session-viewer-empty">
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          <p>No messages in this session yet.</p>
        </div>
      </div>
    );
  }

  // The panel fetches its own transcript bodies via index + chunk pages
  return (
    <SessionViewModeProvider>
      <div className="flex h-full flex-col" data-testid="session-viewer-panel-paged">
        {metrics && <SessionMetricsHeader metrics={metrics} />}
        <PagedSessionMessageList
          sessionId={sessionId}
          isLive={isLive}
          metrics={metrics}
          ChunkRenderer={ChunkRenderer}
        />
      </div>
    </SessionViewModeProvider>
  );
}
