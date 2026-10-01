import { memo, useCallback, useMemo, useState } from 'react';
import { cn } from '@/ui/lib/utils';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
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
import { SessionMetricsHeader } from './SessionMetricsHeader';
import { AIGroupCard } from './AIGroupCard';
import { SessionViewModeProvider } from '@/ui/hooks/useSessionViewMode';
import { PagedSessionMessageList, type ChunkRendererProps } from './PagedSessionMessageList';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

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

function ThinkingBlock({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        <Brain className="h-3 w-3" />
        <span>Thinking</span>
        <span className="ml-1 text-muted-foreground font-mono italic">
          ({truncateText(text, 40)})
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-foreground leading-relaxed">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Tool Call Block
// ---------------------------------------------------------------------------

interface ToolCallBlockProps {
  sessionId?: string | null;
  toolCall: UnifiedToolCall;
  result?: UnifiedToolResult;
}

interface FullToolResultResponse {
  sessionId: string;
  toolCallId: string;
  content: string | unknown[];
  isError: boolean;
  fullLength: number;
}

function formatToolResultSize(fullLength?: number): string {
  if (!fullLength || fullLength <= 0) return '';
  return `${(fullLength / 1024).toFixed(fullLength >= 10 * 1024 ? 0 : 1)} KB`;
}

const ToolCallBlock = memo(function ToolCallBlock({
  sessionId,
  toolCall,
  result,
}: ToolCallBlockProps) {
  const fetchFn = useFetchFactory();
  const isTask = toolCall.isTask;
  const [expandedServerResult, setExpandedServerResult] = useState<string | null>(null);
  const [isFetchingFullResult, setIsFetchingFullResult] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const inputPreview = useMemo(
    () => truncateText(JSON.stringify(toolCall.input), 120),
    [toolCall.input],
  );
  const toolResultText = useMemo(() => {
    if (!result) return null;
    return typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content, null, 2);
  }, [result]);
  const resultText = expandedServerResult ?? toolResultText;
  const isServerTruncated = result?.isTruncated === true;
  const loadFullLabel = useMemo(() => {
    if (!isServerTruncated) return null;
    const sizeText = formatToolResultSize(result?.fullLength);
    return sizeText ? `Show full result (${sizeText})` : 'Show full result';
  }, [isServerTruncated, result?.fullLength]);
  const resultPreview = useMemo(() => {
    if (!resultText) return null;
    if (isServerTruncated || expandedServerResult) return resultText;
    return truncateText(resultText, 500);
  }, [expandedServerResult, isServerTruncated, resultText]);

  const handleLoadFullResult = useCallback(async () => {
    if (!sessionId || !isServerTruncated || isFetchingFullResult || expandedServerResult) return;

    setFetchError(null);
    setIsFetchingFullResult(true);
    try {
      const response = await fetchJsonOrThrow<FullToolResultResponse>(
        `/api/sessions/${sessionId}/transcript/tool-result/${encodeURIComponent(toolCall.id)}`,
        {},
        'Failed to fetch full tool result',
        fetchFn,
      );
      const fullText =
        typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content, null, 2);
      setExpandedServerResult(fullText);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : 'Failed to fetch full tool result');
    } finally {
      setIsFetchingFullResult(false);
    }
  }, [
    expandedServerResult,
    fetchFn,
    isFetchingFullResult,
    isServerTruncated,
    sessionId,
    toolCall.id,
  ]);

  return (
    <Collapsible>
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
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-foreground leading-relaxed">
            {inputPreview}
          </pre>
          {resultText && (
            <pre
              className={cn(
                'max-h-32 overflow-auto whitespace-pre-wrap rounded-md p-2 text-[11px] leading-relaxed',
                result?.isError
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-muted/40 text-foreground',
              )}
            >
              {resultPreview}
            </pre>
          )}
          {isServerTruncated && !expandedServerResult && sessionId && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void handleLoadFullResult();
              }}
              className="mt-0.5 text-[10px] text-primary hover:underline disabled:opacity-60"
              disabled={isFetchingFullResult}
              data-testid="tool-result-load-full"
            >
              {isFetchingFullResult ? 'Loading full result…' : loadFullLabel}
            </button>
          )}
          {fetchError && (
            <p className="text-[10px] text-destructive" data-testid="tool-result-load-error">
              {fetchError}
            </p>
          )}
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

const UserMessageCard = memo(function UserMessageCard({ message }: MessageCardProps) {
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
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed">
          {text}
        </div>
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
        </div>

        {/* Thinking blocks (collapsible, dimmed) */}
        {thinkingBlocks.map((thinking, idx) => (
          <ThinkingBlock key={`thinking-${idx}`} text={thinking} />
        ))}

        {/* Tool calls (collapsible) */}
        {message.toolCalls.map((tc) => (
          <ToolCallBlock
            key={tc.id}
            sessionId={sessionId}
            toolCall={tc}
            result={toolResultMap.get(tc.id)}
          />
        ))}

        {/* Output text (markdown rendered) */}
        {text.trim() && (
          <MarkdownRenderer content={text} className="text-sm leading-relaxed [&_p]:my-1" />
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

function renderMessage(msg: SerializedMessage, sessionId?: string | null) {
  if (msg.isCompactSummary) return <CompactMarker key={msg.id} />;
  switch (msg.role) {
    case 'user':
      return <UserMessageCard key={msg.id} message={msg} />;
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
        chunk.messages.map((msg) => renderMessage(msg, sessionId))
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
