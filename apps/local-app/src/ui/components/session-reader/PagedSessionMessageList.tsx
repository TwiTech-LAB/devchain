import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { transcriptQueryKeys } from '@/ui/hooks/useSessionTranscript';
import type { SerializedChunk, WsTranscriptDeltaPayload } from '@/ui/hooks/useSessionTranscript';
import { fetchTranscriptIndex, fetchTranscriptChunks } from '@/ui/lib/sessions';
import type { TranscriptIndex } from '@/ui/lib/sessions';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAutoScrollBottom } from '@/ui/hooks/useAutoScrollBottom';
import { SessionNavigationToolbar } from './SessionNavigationToolbar';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

const CHUNK_PAGE_SIZE = 10;
const CHUNK_GC_TIME = 5 * 60 * 1000;

interface PagedSessionMessageListProps {
  sessionId: string;
  isLive: boolean;
  metrics?: UnifiedMetrics;
  ChunkRenderer: React.ComponentType<{
    sessionId?: string | null;
    chunk: SerializedChunk;
    isLive: boolean;
    isAiGroupExpanded?: boolean;
    onAiGroupToggle?: (chunkId: string) => void;
  }>;
}

export const PagedSessionMessageList = memo(function PagedSessionMessageList({
  sessionId,
  isLive,
  metrics: _metrics,
  ChunkRenderer,
}: PagedSessionMessageListProps) {
  const queryClient = useQueryClient();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [expandedAiGroups, setExpandedAiGroups] = useState<Map<string, boolean>>(() => new Map());
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chunksMapRef = useRef<Map<string, SerializedChunk>>(new Map());
  const [deltaSeq, setDeltaSeq] = useState(0);
  const apiFetch = useFetchFactory();

  const {
    scrollContainerRef: scrollRef,
    bottomRef,
    handleScroll,
  } = useAutoScrollBottom({
    enabled: isLive,
    triggerDep: 0,
  });

  // 1. Fetch index
  const {
    data: index,
    isLoading: indexLoading,
    error: indexError,
  } = useQuery({
    queryKey: transcriptQueryKeys.index(sessionId),
    queryFn: () => fetchTranscriptIndex(sessionId, '', apiFetch),
    enabled: !!sessionId,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && !data.isOngoing) return false;
      return 5_000;
    },
  });

  const chunkCount = index?.totals.chunkCount ?? 0;
  const chunkIds = index?.chunkIds ?? [];

  // 2. Virtualizer
  const getItemKey = useCallback((i: number) => chunkIds[i] ?? `placeholder-${i}`, [chunkIds]);

  const rowVirtualizer = useVirtualizer({
    count: chunkCount,
    getScrollElement: () => scrollElement,
    estimateSize: () => 120,
    getItemKey,
    overscan: 5,
    initialRect: { width: 0, height: 600 },
    measureElement: (element) => {
      const height = element.getBoundingClientRect().height;
      return height > 0 ? height : 120;
    },
  });

  // 3. Determine visible batch boundaries
  const virtualItems = rowVirtualizer.getVirtualItems();

  const batchKeys = useMemo(() => {
    if (virtualItems.length === 0 || chunkCount === 0) return [];
    const firstIdx = virtualItems[0].index;
    const lastIdx = virtualItems[virtualItems.length - 1].index;
    const batchStart = Math.floor(firstIdx / CHUNK_PAGE_SIZE) * CHUNK_PAGE_SIZE;
    const batchEnd = Math.min(
      Math.ceil((lastIdx + 1) / CHUNK_PAGE_SIZE) * CHUNK_PAGE_SIZE,
      chunkCount,
    );
    const keys: { startIdx: number; cursor: string | undefined; size: number }[] = [];
    for (let i = batchStart; i < batchEnd; i += CHUNK_PAGE_SIZE) {
      const size = Math.min(CHUNK_PAGE_SIZE, chunkCount - i);
      keys.push({
        startIdx: i,
        cursor: chunkIds[i],
        size,
      });
    }
    return keys;
  }, [virtualItems, chunkCount, chunkIds]);

  // 4. Fetch visible chunk batches
  const batchQueries = useQueries({
    queries: batchKeys.map((batch) => ({
      queryKey: transcriptQueryKeys.chunkPage(sessionId, batch.cursor ?? null, batch.size),
      queryFn: () =>
        fetchTranscriptChunks(sessionId, batch.cursor, batch.size, undefined, '', apiFetch),
      enabled: !!batch.cursor,
      staleTime: 30_000,
      gcTime: CHUNK_GC_TIME,
    })),
  });

  // 5. Build chunks map from fetched data + WS delta-injected chunks
  const chunksMap = useMemo(() => {
    const map = new Map<string, SerializedChunk>(chunksMapRef.current);
    for (const query of batchQueries) {
      if (query.data) {
        for (const chunk of query.data.chunks) {
          map.set(chunk.id, chunk);
        }
      }
    }
    chunksMapRef.current = map;
    return map;
  }, [batchQueries, deltaSeq]);

  // 6. WS subscription for real-time updates
  const invalidateAll = useCallback(() => {
    if (!sessionId) return;
    queryClient.invalidateQueries({
      queryKey: transcriptQueryKeys.index(sessionId),
    });
    queryClient.invalidateQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey[0] === 'transcript-chunk-page' &&
        query.queryKey[1] === sessionId,
    });
  }, [queryClient, sessionId]);

  useEffect(() => {
    return () => {
      if (invalidateTimerRef.current) {
        clearTimeout(invalidateTimerRef.current);
        invalidateTimerRef.current = null;
      }
    };
  }, []);

  const applyDeltaToIndex = useCallback(
    (payload: WsTranscriptDeltaPayload) => {
      if (!sessionId) return;

      const currentIndex = queryClient.getQueryData<TranscriptIndex>(
        transcriptQueryKeys.index(sessionId),
      );
      if (!currentIndex) {
        invalidateAll();
        return;
      }

      const { replaceFromChunkIndex, newChunkIds, totalChunkCount, metrics, deltaChunks } = payload;

      // Gap detection: replaceFromChunkIndex beyond current index means we missed events
      if (replaceFromChunkIndex > currentIndex.chunkIds.length) {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            msg: 'transcript.paged.gapDetected',
            sessionId,
            replaceFromChunkIndex,
            currentChunkCount: currentIndex.chunkIds.length,
          }),
        );
        invalidateAll();
        return;
      }

      // Extend index: keep stable prefix, append new chunk IDs
      const stableIds = currentIndex.chunkIds.slice(0, replaceFromChunkIndex);
      const extendedChunkIds = [...stableIds, ...newChunkIds];

      queryClient.setQueryData<TranscriptIndex>(transcriptQueryKeys.index(sessionId), {
        ...currentIndex,
        totals: {
          messageCount: metrics.messageCount,
          chunkCount: totalChunkCount,
        },
        chunkIds: extendedChunkIds,
        isOngoing: true,
      });

      // Inject delta chunks directly into chunk-page cache for immediate render
      if (deltaChunks.length > 0) {
        for (const chunk of deltaChunks as SerializedChunk[]) {
          chunksMapRef.current.set(chunk.id, chunk);
        }
        setDeltaSeq((s) => s + 1);
      }

      // Invalidate chunk pages covering the replaced region
      queryClient.invalidateQueries({
        predicate: (query) => {
          if (!Array.isArray(query.queryKey)) return false;
          if (query.queryKey[0] !== 'transcript-chunk-page') return false;
          if (query.queryKey[1] !== sessionId) return false;
          const cursor = query.queryKey[2] as string | null;
          if (!cursor) return false;
          const cursorIdx = currentIndex.chunkIds.indexOf(cursor);
          if (cursorIdx === -1) return false;
          const pageSize = (query.queryKey[3] as number) || CHUNK_PAGE_SIZE;
          return cursorIdx + pageSize > replaceFromChunkIndex;
        },
      });
    },
    [queryClient, sessionId, invalidateAll],
  );

  const handleMessage = useCallback(
    (envelope: WsEnvelope) => {
      if (!sessionId) return;
      if (envelope.topic !== `session/${sessionId}/transcript`) return;

      switch (envelope.type) {
        case 'discovered':
        case 'ended':
          if (invalidateTimerRef.current) {
            clearTimeout(invalidateTimerRef.current);
            invalidateTimerRef.current = null;
          }
          invalidateAll();
          break;
        case 'updated': {
          const payload = envelope.payload as WsTranscriptDeltaPayload | undefined;
          if (payload?.newChunkIds && payload.newChunkIds.length > 0) {
            applyDeltaToIndex(payload);
          } else {
            // Legacy fallback: no newChunkIds → full refetch
            invalidateAll();
          }
          break;
        }
      }
    },
    [invalidateAll, applyDeltaToIndex, sessionId],
  );

  const handlers = useMemo(() => ({ message: handleMessage }), [handleMessage]);
  useAppSocket(handlers, [sessionId]);

  // 7. Expansion toggles
  const handleAiGroupToggle = useCallback((chunkId: string) => {
    setExpandedAiGroups((prev) => {
      const next = new Map(prev);
      next.set(chunkId, !(prev.get(chunkId) ?? false));
      return next;
    });
  }, []);

  useEffect(() => {
    setExpandedAiGroups(new Map());
    chunksMapRef.current = new Map();
    setDeltaSeq(0);
  }, [sessionId]);

  // Auto-expand latest AI chunk for live sessions
  const autoExpandedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isLive || chunkIds.length === 0) return;
    const lastId = chunkIds[chunkIds.length - 1];
    const lastChunk = chunksMap.get(lastId);
    if (!lastChunk || lastChunk.type !== 'ai') return;
    if (autoExpandedRef.current.has(lastId)) return;
    autoExpandedRef.current.add(lastId);
    setExpandedAiGroups((prev) => {
      const next = new Map(prev);
      next.set(lastId, true);
      return next;
    });
  }, [isLive, chunkIds, chunksMap]);

  // 8. Navigation
  const handleNavTop = useCallback(() => {
    scrollElement?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [scrollElement]);

  const handleNavEnd = useCallback(() => {
    scrollElement?.scrollTo({ top: scrollElement.scrollHeight, behavior: 'smooth' });
  }, [scrollElement]);

  const handleScrollContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      (scrollRef as { current: HTMLDivElement | null }).current = node;
      setScrollElement(node);
    },
    [scrollRef],
  );

  if (indexLoading) {
    return (
      <div className="flex-1 space-y-3 p-4" data-testid="paged-session-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  if (indexError) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-destructive">
        <p>Failed to load session index: {(indexError as Error).message}</p>
      </div>
    );
  }

  if (chunkCount === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        <p>No messages in this session yet.</p>
      </div>
    );
  }

  const itemsToRender =
    virtualItems.length > 0
      ? virtualItems
      : Array.from({ length: Math.min(chunkCount, 20) }, (_, i) => ({
          index: i,
          start: i * 120,
          size: 120,
        }));

  return (
    <div className="relative flex-1 min-h-0" role="region" aria-label="Session viewer (paged)">
      <div
        ref={handleScrollContainerRef}
        onScroll={handleScroll}
        className="h-full overflow-auto"
        data-testid="paged-session-viewer-scroll"
      >
        <div className="relative p-3" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {itemsToRender.map((virtualItem) => {
            const idx = virtualItem.index;
            const chunkId = chunkIds[idx];
            const chunk = chunkId ? chunksMap.get(chunkId) : undefined;

            return (
              <div
                key={getItemKey(idx)}
                ref={rowVirtualizer.measureElement}
                data-index={idx}
                className="absolute left-0 top-0 w-full pb-3"
                style={{ transform: `translateY(${virtualItem.start}px)` }}
              >
                {chunk ? (
                  <ChunkRenderer
                    sessionId={sessionId}
                    chunk={chunk}
                    isLive={isLive}
                    isAiGroupExpanded={expandedAiGroups.get(chunkId) ?? false}
                    onAiGroupToggle={handleAiGroupToggle}
                  />
                ) : (
                  <div
                    className="h-16 animate-pulse rounded-lg bg-muted/40"
                    data-testid="chunk-skeleton"
                  />
                )}
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
        onPrevThinking={null}
        onNextThinking={null}
        onNextResponse={null}
        onPrevHotspot={null}
        onNextHotspot={null}
        onToggleHotspotFilter={null}
        hotspotFilterActive={false}
        hotspotCount={0}
        hasChunks={true}
      />
    </div>
  );
});
