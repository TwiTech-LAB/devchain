import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  X,
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
import { useAutoScrollBottom } from '@/ui/hooks/useAutoScrollBottom';
import { MarkdownRenderer } from '@/ui/components/shared/MarkdownRenderer';
import { SessionMetricsHeader } from './SessionMetricsHeader';
import { AIGroupCard } from './AIGroupCard';
import { SessionNavigationToolbar } from './SessionNavigationToolbar';
import {
  computeChunkHotspots,
  computeStepHotspotThreshold,
  filterChunksForHotspot,
} from '@/ui/utils/hotspot-detection';
import { getHeaderInputTotal } from '@/ui/utils/ai-group-enhancer';

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
  messages: SerializedMessage[];
  chunks: SerializedChunk[];
  metrics?: UnifiedMetrics;
  isLive: boolean;
  isLoading: boolean;
  error: Error | null;
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Thinking Block
// ---------------------------------------------------------------------------

function ThinkingBlock({ text }: { text: string }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        <Brain className="h-3 w-3" />
        <span>Thinking</span>
        <span className="ml-1 text-muted-foreground/50">({truncateText(text, 40)})</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground/80 leading-relaxed">
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
  }, [expandedServerResult, isFetchingFullResult, isServerTruncated, sessionId, toolCall.id]);

  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
        {isTask ? <Layers className="h-3 w-3 text-blue-400" /> : <Wrench className="h-3 w-3" />}
        <span className="font-medium">{toolCall.name}</span>
        {isTask && toolCall.taskDescription && (
          <span className="ml-1 text-muted-foreground/60">
            — {truncateText(toolCall.taskDescription, 50)}
          </span>
        )}
        {result?.isError && <AlertTriangle className="h-3 w-3 text-destructive" />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 space-y-1">
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground/80 leading-relaxed">
            {inputPreview}
          </pre>
          {resultText && (
            <pre
              className={cn(
                'max-h-32 overflow-auto whitespace-pre-wrap rounded-md p-2 text-[11px] leading-relaxed',
                result?.isError
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-muted/40 text-muted-foreground/80',
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
              className="mt-0.5 text-[10px] text-primary/80 hover:text-primary transition-colors disabled:opacity-60"
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
          <span className="text-muted-foreground/50">·</span>
          <span>{timestampText}</span>
        </div>
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed">
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
          <span className="text-muted-foreground/50">·</span>
          <span>{timestampText}</span>
          {message.usage && (
            <>
              <span className="text-muted-foreground/50">·</span>
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
          <MarkdownRenderer content={text} className="text-xs leading-relaxed [&_p]:my-1" />
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
        <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
          <Terminal className="h-3 w-3" />
          <span>System</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{timestampText}</span>
        </div>
        <div className="whitespace-pre-wrap text-[11px] text-muted-foreground leading-relaxed">
          {text}
        </div>
      </div>
    </div>
  );
});

SystemMessageCard.displayName = 'SystemMessageCard';

function CompactMarker() {
  return (
    <div className="flex items-center gap-2 py-2" data-testid="compact-marker">
      <div className="flex-1 border-t border-dashed border-amber-500/40" />
      <span className="rounded-full bg-amber-500/10 px-3 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
        Context compacted
      </span>
      <div className="flex-1 border-t border-dashed border-amber-500/40" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chunk-based rendering
// ---------------------------------------------------------------------------

interface ChunkRendererProps {
  sessionId?: string | null;
  chunk: SerializedChunk;
  isLive: boolean;
  isHot?: boolean;
  contextPct?: number;
  inputDelta?: number;
  stepHotspotThreshold?: number | null;
  isAiGroupExpanded?: boolean;
  onAiGroupToggle?: (chunkId: string) => void;
  onAiGroupLayoutChange?: () => void;
}

const ChunkRenderer = memo(function ChunkRenderer({
  sessionId,
  chunk,
  isLive,
  isHot,
  contextPct,
  inputDelta,
  stepHotspotThreshold,
  isAiGroupExpanded = false,
  onAiGroupToggle,
  onAiGroupLayoutChange,
}: ChunkRendererProps) {
  return (
    <div className="space-y-2" data-testid={`chunk-${chunk.type}`}>
      {chunk.type === 'ai' ? (
        chunk.semanticSteps ? (
          <AIGroupCard
            sessionId={sessionId}
            chunk={chunk as SerializedChunk & { type: 'ai' }}
            isExpanded={isAiGroupExpanded}
            isLive={isLive}
            isHot={isHot}
            contextPct={contextPct}
            inputDelta={inputDelta}
            stepHotspotThreshold={stepHotspotThreshold}
            onToggle={() => onAiGroupToggle?.(chunk.id)}
            onLayoutChange={onAiGroupLayoutChange}
          />
        ) : (
          chunk.messages.map((msg) => {
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
          })
        )
      ) : (
        chunk.messages.map((msg) => {
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
        })
      )}
    </div>
  );
});

ChunkRenderer.displayName = 'ChunkRenderer';

// ---------------------------------------------------------------------------
// Flat message rendering (fallback when no chunks)
// ---------------------------------------------------------------------------

function MessageRenderer({
  sessionId,
  message,
}: {
  sessionId?: string | null;
  message: SerializedMessage;
}) {
  if (message.isCompactSummary) return <CompactMarker />;
  switch (message.role) {
    case 'user':
      return <UserMessageCard message={message} />;
    case 'assistant':
      return <AIMessageCard sessionId={sessionId} message={message} />;
    case 'system':
      return <SystemMessageCard message={message} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Navigation helper
// ---------------------------------------------------------------------------

function findAdjacentIndex(
  indexes: number[],
  current: number,
  direction: 'next' | 'prev',
): number | null {
  if (direction === 'next') return indexes.find((i) => i > current) ?? null;
  for (let i = indexes.length - 1; i >= 0; i--) {
    if (indexes[i] < current) return indexes[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Message list container
// ---------------------------------------------------------------------------

interface SessionMessageListProps {
  sessionId?: string | null;
  messages: SerializedMessage[];
  chunks: SerializedChunk[];
  contextWindowTokens?: number;
  isLive: boolean;
}

const SessionMessageList = memo(function SessionMessageList({
  sessionId,
  messages,
  chunks,
  contextWindowTokens,
  isLive,
}: SessionMessageListProps) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [expandedAiGroups, setExpandedAiGroups] = useState<Map<string, boolean>>(() => new Map());
  const [hotspotFilterActive, setHotspotFilterActive] = useState(false);
  const autoExpandedRef = useRef<Set<string>>(new Set());
  const pendingScrollRef = useRef<{ chunkId: string; requestId: number } | null>(null);
  const scrollRequestCounterRef = useRef(0);
  const lastNavChunkIdRef = useRef<string | null>(null);
  const programmaticScrollTokenRef = useRef(0);
  const activeScrollTokenRef = useRef(0);
  const [scrollRequestId, setScrollRequestId] = useState(0);
  const {
    scrollContainerRef: scrollRef,
    bottomRef,
    handleScroll,
  } = useAutoScrollBottom({ enabled: isLive, triggerDep: messages.length });

  const handleScrollWithNavReset = useCallback(() => {
    handleScroll();
    if (activeScrollTokenRef.current === 0) {
      lastNavChunkIdRef.current = null;
    }
  }, [handleScroll]);

  const hasChunks = chunks.length > 0;

  // Hotspot detection (operates on raw chunks)
  const hotspotResult = useMemo(() => {
    if (!hasChunks) return null;
    return computeChunkHotspots(chunks, contextWindowTokens);
  }, [hasChunks, chunks, contextWindowTokens]);

  const hotChunkIds = useMemo(
    () => hotspotResult?.hotChunkIds ?? new Set<string>(),
    [hotspotResult],
  );

  // Step-level hotspot threshold (global, passed to AIGroupCard for per-card classification)
  const stepHotspotThreshold = useMemo(() => {
    if (!hasChunks) return null;
    return computeStepHotspotThreshold(chunks);
  }, [hasChunks, chunks]);

  // Input token deltas between consecutive AI chunks (computed from raw chunks)
  const inputDeltas = useMemo(() => {
    const deltas = new Map<string, number>();
    let prevInput: number | null = null;

    for (const chunk of chunks) {
      if (chunk.type !== 'ai') continue;
      const totalInput = getHeaderInputTotal(chunk);
      if (totalInput === null) continue;
      if (prevInput !== null && totalInput > prevInput) {
        deltas.set(chunk.id, totalInput - prevInput);
      }
      prevInput = totalInput;
    }

    return deltas;
  }, [chunks]);

  // Display chunks (filtered when hotspot filter active)
  const displayChunks = useMemo(() => {
    if (!hotspotFilterActive || hotChunkIds.size === 0) return chunks;
    return filterChunksForHotspot(chunks, hotChunkIds);
  }, [chunks, hotspotFilterActive, hotChunkIds]);

  const itemCount = hasChunks ? displayChunks.length : messages.length;
  const getItemKey = useCallback(
    (index: number) =>
      hasChunks
        ? (displayChunks[index]?.id ?? `chunk-${index}`)
        : (messages[index]?.id ?? `msg-${index}`),
    [hasChunks, displayChunks, messages],
  );

  const rowVirtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => scrollElement,
    estimateSize: () => 120,
    // Use stable ids to prevent unnecessary unmount/remount on updates.
    getItemKey,
    // Render nearby rows for smoother scroll.
    overscan: 5,
    // Provide deterministic initial viewport size for first render/SSR-like environments.
    initialRect: { width: 0, height: 600 },
    measureElement: (element) => {
      const height = element.getBoundingClientRect().height;
      return height > 0 ? height : 120;
    },
  });

  // NOTE: No manual measure() calls here — TanStack Virtual's ResizeObserver
  // (attached via ref={rowVirtualizer.measureElement}) detects row height changes
  // automatically. Calling measure() resets ALL cached sizes to estimateSize,
  // which causes items to overlap until each row's ResizeObserver fires again.

  const handleAiGroupToggle = useCallback((chunkId: string) => {
    setExpandedAiGroups((prev) => {
      const next = new Map(prev);
      next.set(chunkId, !(prev.get(chunkId) ?? false));
      return next;
    });
  }, []);

  // Reset expansion state on session switch
  useEffect(() => {
    autoExpandedRef.current = new Set();
    setExpandedAiGroups(new Map());
    setHotspotFilterActive(false);
    lastNavChunkIdRef.current = null;
  }, [sessionId]);

  // Auto-expand latest AI chunk for live sessions
  useEffect(() => {
    if (!isLive || displayChunks.length === 0) return;
    const lastChunk = displayChunks[displayChunks.length - 1];
    if (lastChunk?.type !== 'ai') return;
    if (autoExpandedRef.current.has(lastChunk.id)) return;
    autoExpandedRef.current.add(lastChunk.id);
    setExpandedAiGroups((prev) => {
      const next = new Map(prev);
      next.set(lastChunk.id, true);
      return next;
    });
  }, [isLive, displayChunks]);

  // Navigation: index maps for semantic chunk types
  const thinkingChunkIndexes = useMemo(() => {
    if (!hasChunks) return [];
    return displayChunks.reduce<number[]>((acc, chunk, i) => {
      if (chunk.type === 'ai' && chunk.semanticSteps?.some((s) => s.type === 'thinking')) {
        acc.push(i);
      }
      return acc;
    }, []);
  }, [hasChunks, displayChunks]);

  const responseChunkIndexes = useMemo(() => {
    if (!hasChunks) return [];
    return displayChunks.reduce<number[]>((acc, chunk, i) => {
      if (
        chunk.type === 'ai' &&
        chunk.semanticSteps?.some(
          (s) => s.type === 'output' && (s.content.outputText as string | undefined)?.trim(),
        )
      ) {
        acc.push(i);
      }
      return acc;
    }, []);
  }, [hasChunks, displayChunks]);

  const getCurrentVisibleIndex = useCallback(() => {
    const items = rowVirtualizer.getVirtualItems();
    if (items.length === 0) return 0;
    const scrollOffset = rowVirtualizer.scrollOffset ?? 0;
    for (const item of items) {
      if (item.start + item.size > scrollOffset) return item.index;
    }
    return items[items.length - 1].index;
  }, [rowVirtualizer]);

  const resolveNavBaseline = useCallback(() => {
    const storedId = lastNavChunkIdRef.current;
    if (storedId) {
      const idx = displayChunks.findIndex((c) => c.id === storedId);
      if (idx !== -1) return idx;
      lastNavChunkIdRef.current = null;
    }
    return getCurrentVisibleIndex();
  }, [displayChunks, getCurrentVisibleIndex]);

  const navigateToChunk = useCallback(
    (index: number, expandMode: 'preserve' | 'single_focus' = 'preserve') => {
      if (expandMode === 'single_focus' && hasChunks && displayChunks[index]?.type === 'ai') {
        const chunkId = displayChunks[index].id;
        // No-op guard: skip state update if target is already the only expanded group
        setExpandedAiGroups((prev) => {
          if (prev.size === 1 && prev.get(chunkId)) return prev;
          return new Map([[chunkId, true]]);
        });
        // Deferred scroll: store chunkId (not index), trigger independent signal
        // NO measure() — ResizeObserver handles height updates naturally
        scrollRequestCounterRef.current += 1;
        pendingScrollRef.current = { chunkId, requestId: scrollRequestCounterRef.current };
        setScrollRequestId(scrollRequestCounterRef.current);
      } else {
        const token = ++programmaticScrollTokenRef.current;
        activeScrollTokenRef.current = token;
        rowVirtualizer.scrollToIndex(index, { align: 'start' });
        requestAnimationFrame(() => {
          if (activeScrollTokenRef.current === token) activeScrollTokenRef.current = 0;
        });
      }
    },
    [rowVirtualizer, hasChunks, displayChunks],
  );

  // Deferred scroll: after React commit + ResizeObserver, resolve chunkId → index and scroll
  useEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending || pending.requestId !== scrollRequestId) return;
    pendingScrollRef.current = null;

    // Resolve chunkId → current index at scroll time (not capture time)
    const currentIndex = displayChunks.findIndex((c) => c.id === pending.chunkId);
    if (currentIndex === -1) return;

    const capturedRequestId = pending.requestId;
    let handle2: number;

    // Double-rAF: Frame N rAF1 fires → Layout → ResizeObserver updates heights.
    // Frame N+1 rAF2 fires → scrollToIndex with correct heights.
    const handle1 = requestAnimationFrame(() => {
      handle2 = requestAnimationFrame(() => {
        // Stale-request guard: skip if newer navigation superseded this one
        if (scrollRequestCounterRef.current !== capturedRequestId) return;
        const token = ++programmaticScrollTokenRef.current;
        activeScrollTokenRef.current = token;
        rowVirtualizer.scrollToIndex(currentIndex, { align: 'start' });
        requestAnimationFrame(() => {
          if (activeScrollTokenRef.current === token) activeScrollTokenRef.current = 0;
        });
      });
    });

    return () => {
      cancelAnimationFrame(handle1);
      cancelAnimationFrame(handle2);
    };
  }, [scrollRequestId, displayChunks, rowVirtualizer]);

  const handleNavTop = useCallback(() => {
    scrollElement?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [scrollElement]);

  const handleNavEnd = useCallback(() => {
    scrollElement?.scrollTo({ top: scrollElement.scrollHeight, behavior: 'smooth' });
  }, [scrollElement]);

  const handleNavPrevThinking = useMemo<(() => void) | null>(() => {
    if (thinkingChunkIndexes.length === 0) return null;
    return () => {
      const target = findAdjacentIndex(thinkingChunkIndexes, resolveNavBaseline(), 'prev');
      if (target !== null) {
        lastNavChunkIdRef.current = displayChunks[target].id;
        navigateToChunk(target, 'single_focus');
      }
    };
  }, [thinkingChunkIndexes, resolveNavBaseline, navigateToChunk, displayChunks]);

  const handleNavNextThinking = useMemo<(() => void) | null>(() => {
    if (thinkingChunkIndexes.length === 0) return null;
    return () => {
      const target = findAdjacentIndex(thinkingChunkIndexes, resolveNavBaseline(), 'next');
      if (target !== null) {
        lastNavChunkIdRef.current = displayChunks[target].id;
        navigateToChunk(target, 'single_focus');
      }
    };
  }, [thinkingChunkIndexes, resolveNavBaseline, navigateToChunk, displayChunks]);

  const handleNavNextResponse = useMemo<(() => void) | null>(() => {
    if (responseChunkIndexes.length === 0) return null;
    return () => {
      const target = findAdjacentIndex(responseChunkIndexes, resolveNavBaseline(), 'next');
      if (target !== null) {
        lastNavChunkIdRef.current = displayChunks[target].id;
        navigateToChunk(target, 'preserve');
      }
    };
  }, [responseChunkIndexes, resolveNavBaseline, navigateToChunk, displayChunks]);

  // Hotspot navigation
  const hotChunkIndexes = useMemo(() => {
    if (hotChunkIds.size === 0) return [];
    return displayChunks.reduce<number[]>((acc, chunk, i) => {
      if (chunk.type === 'ai' && hotChunkIds.has(chunk.id)) acc.push(i);
      return acc;
    }, []);
  }, [displayChunks, hotChunkIds]);

  const handleNavPrevHotspot = useMemo<(() => void) | null>(() => {
    if (hotChunkIndexes.length === 0) return null;
    return () => {
      const target = findAdjacentIndex(hotChunkIndexes, resolveNavBaseline(), 'prev');
      if (target !== null) {
        lastNavChunkIdRef.current = displayChunks[target].id;
        navigateToChunk(target, 'single_focus');
      }
    };
  }, [hotChunkIndexes, resolveNavBaseline, navigateToChunk, displayChunks]);

  const handleNavNextHotspot = useMemo<(() => void) | null>(() => {
    if (hotChunkIndexes.length === 0) return null;
    return () => {
      const target = findAdjacentIndex(hotChunkIndexes, resolveNavBaseline(), 'next');
      if (target !== null) {
        lastNavChunkIdRef.current = displayChunks[target].id;
        navigateToChunk(target, 'single_focus');
      }
    };
  }, [hotChunkIndexes, resolveNavBaseline, navigateToChunk, displayChunks]);

  const handleToggleHotspotFilter = useMemo<(() => void) | null>(() => {
    if (hotChunkIds.size === 0 && !hotspotFilterActive) return null;
    return () => {
      lastNavChunkIdRef.current = null;
      setHotspotFilterActive((prev) => !prev);
    };
  }, [hotChunkIds, hotspotFilterActive]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable
      ) {
        return;
      }
      if (e.key === 'Home' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleNavTop();
      } else if (e.key === 'End' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleNavEnd();
      } else if (e.key === 'ArrowUp' && e.altKey && !e.shiftKey) {
        e.preventDefault();
        handleNavPrevThinking?.();
      } else if (e.key === 'ArrowDown' && e.altKey && !e.shiftKey) {
        e.preventDefault();
        handleNavNextThinking?.();
      } else if (e.key === 'ArrowDown' && e.altKey && e.shiftKey) {
        e.preventDefault();
        handleNavNextResponse?.();
      }
    },
    [
      handleNavTop,
      handleNavEnd,
      handleNavPrevThinking,
      handleNavNextThinking,
      handleNavNextResponse,
    ],
  );

  const handleScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      (scrollRef as { current: HTMLDivElement | null }).current = node;
      setScrollElement(node);
    },
    [scrollRef],
  );
  const virtualItems = rowVirtualizer.getVirtualItems();
  const bootstrapCount = Math.min(itemCount, 20);
  const itemsToRender =
    virtualItems.length > 0
      ? virtualItems
      : Array.from({ length: bootstrapCount }, (_, index) => ({
          index,
          start: index * 120,
          size: 120,
        }));

  return (
    <div
      className="relative flex-1 min-h-0"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="region"
      aria-label="Session viewer"
    >
      <div
        ref={handleScrollContainerRef}
        onScroll={handleScrollWithNavReset}
        className="h-full overflow-auto"
        data-testid="session-viewer-scroll"
      >
        <div className="relative p-3" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {itemsToRender.map((virtualItem) => {
            const index = virtualItem.index;
            const key = getItemKey(index);
            const content = hasChunks ? (
              displayChunks[index] ? (
                <ChunkRenderer
                  sessionId={sessionId}
                  chunk={displayChunks[index]}
                  isLive={isLive}
                  isHot={hotChunkIds.has(displayChunks[index].id)}
                  contextPct={hotspotResult?.chunkStats.get(displayChunks[index].id)?.contextPct}
                  inputDelta={inputDeltas.get(displayChunks[index].id)}
                  stepHotspotThreshold={stepHotspotThreshold}
                  isAiGroupExpanded={expandedAiGroups.get(displayChunks[index].id) ?? false}
                  onAiGroupToggle={handleAiGroupToggle}
                />
              ) : null
            ) : messages[index] ? (
              <MessageRenderer sessionId={sessionId} message={messages[index]} />
            ) : null;

            if (!content) return null;

            return (
              <div
                key={key}
                ref={rowVirtualizer.measureElement}
                data-index={index}
                className="absolute left-0 top-0 w-full pb-3"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {content}
              </div>
            );
          })}
          <div
            ref={bottomRef}
            className="pointer-events-none absolute left-0"
            style={{
              top: `${rowVirtualizer.getTotalSize()}px`,
              width: 1,
              height: 1,
            }}
          />
        </div>
      </div>
      <SessionNavigationToolbar
        onTop={handleNavTop}
        onEnd={handleNavEnd}
        onPrevThinking={handleNavPrevThinking}
        onNextThinking={handleNavNextThinking}
        onNextResponse={handleNavNextResponse}
        onPrevHotspot={handleNavPrevHotspot}
        onNextHotspot={handleNavNextHotspot}
        onToggleHotspotFilter={handleToggleHotspotFilter}
        hotspotFilterActive={hotspotFilterActive}
        hotspotCount={hotChunkIds.size}
        hasChunks={hasChunks}
      />
    </div>
  );
});

SessionMessageList.displayName = 'SessionMessageList';

// ---------------------------------------------------------------------------
// Main Panel
// ---------------------------------------------------------------------------

export function SessionViewerPanel({
  sessionId,
  messages,
  chunks,
  metrics,
  isLive,
  isLoading,
  error,
  warnings,
}: SessionViewerPanelProps) {
  const [warningsDismissed, setWarningsDismissed] = useState(false);
  const warningsKey = useMemo(() => (warnings ?? []).slice().sort().join('|'), [warnings]);

  useEffect(() => {
    setWarningsDismissed(false);
  }, [sessionId, warningsKey]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        <p>Failed to load session: {error.message}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col" data-testid="session-viewer-loading">
        {/* Skeleton metrics bar */}
        <div className="flex items-center gap-3 border-b border-border/60 bg-muted/30 px-3 py-1.5">
          <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          <div className="h-3 w-10 animate-pulse rounded bg-muted" />
          <div className="h-3 w-12 animate-pulse rounded bg-muted" />
        </div>
        {/* Skeleton messages */}
        <div className="flex-1 space-y-3 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={cn('flex', i % 2 === 0 ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'h-12 animate-pulse rounded-lg bg-muted',
                  i % 2 === 0 ? 'w-3/5' : 'w-4/5',
                )}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col" data-testid="session-viewer-empty">
        {warnings && warnings.length > 0 && !warningsDismissed && (
          <div
            className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950"
            data-testid="session-warnings-banner"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {warnings.map((warning, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200"
                >
                  <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setWarningsDismissed(true)}
              className="flex-shrink-0 rounded p-0.5 text-amber-600 hover:bg-amber-100 hover:text-amber-800 dark:text-amber-400 dark:hover:bg-amber-900 dark:hover:text-amber-200"
              data-testid="session-warnings-dismiss"
              aria-label="Dismiss warnings"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          <p>No messages in this session yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="session-viewer-panel">
      {metrics && <SessionMetricsHeader metrics={metrics} />}
      {warnings && warnings.length > 0 && !warningsDismissed && (
        <div
          className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-800 dark:bg-amber-950"
          data-testid="session-warnings-banner"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {warnings.map((warning, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 text-xs text-amber-800 dark:text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                <span>{warning}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setWarningsDismissed(true)}
            className="flex-shrink-0 rounded p-0.5 text-amber-600 hover:bg-amber-100 hover:text-amber-800 dark:text-amber-400 dark:hover:bg-amber-900 dark:hover:text-amber-200"
            data-testid="session-warnings-dismiss"
            aria-label="Dismiss warnings"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <SessionMessageList
        sessionId={sessionId}
        messages={messages}
        chunks={chunks}
        contextWindowTokens={metrics?.contextWindowTokens}
        isLive={isLive}
      />
    </div>
  );
}
