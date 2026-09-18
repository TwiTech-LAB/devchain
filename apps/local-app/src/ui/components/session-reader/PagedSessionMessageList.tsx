import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { transcriptQueryKeys } from '@/ui/hooks/useSessionTranscript';
import type {
  SerializedChunk,
  WsTranscriptDeltaPayload,
  WsTranscriptUpdatedPayload,
} from '@/ui/hooks/useSessionTranscript';
import { fetchTranscriptIndex, fetchTranscriptChunks } from '@/ui/lib/sessions';
import type {
  TranscriptIndex,
  TranscriptIndexPage,
  TranscriptIndexRequest,
} from '@/ui/lib/sessions';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import type { WsEnvelope } from '@/ui/lib/socket';
import { useAutoScrollBottom } from '@/ui/hooks/useAutoScrollBottom';
import { SessionNavigationToolbar } from './SessionNavigationToolbar';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';

const CHUNK_PAGE_SIZE = 10;
const CHUNK_GC_TIME = 5 * 60 * 1000;
const CHUNK_RETENTION_HYSTERESIS = CHUNK_PAGE_SIZE;
const LIVE_TAIL_RETENTION = CHUNK_PAGE_SIZE;
const ESTIMATED_CHUNK_HEIGHT = 120;
// Reserve six pages for padding, alignment, and the live tail within the 200-body API limit.
const MAX_CANONICAL_VISIBLE_CHUNKS = 200 - 6 * CHUNK_PAGE_SIZE;
const INITIAL_CANONICAL_RETRY_MS = 1_000;
const MAX_CANONICAL_RETRY_MS = 5_000;

interface CanonicalRecoverySnapshot {
  sessionId: string;
  index: TranscriptIndex;
  chunks: Map<string, SerializedChunk>;
}

export function buildRetainedChunkIds(
  chunkIds: string[],
  firstVirtualIndex: number | undefined,
  lastVirtualIndex: number | undefined,
  isLive: boolean,
): Set<string> | null {
  if (firstVirtualIndex === undefined || lastVirtualIndex === undefined) return null;

  const retained = new Set<string>();
  const windowStart = Math.max(0, firstVirtualIndex - CHUNK_RETENTION_HYSTERESIS);
  const windowEnd = Math.min(chunkIds.length, lastVirtualIndex + CHUNK_RETENTION_HYSTERESIS + 1);
  for (let index = windowStart; index < windowEnd; index += 1) {
    retained.add(chunkIds[index]);
  }

  if (isLive) {
    const tailStart = Math.max(0, chunkIds.length - LIVE_TAIL_RETENTION);
    for (let index = tailStart; index < chunkIds.length; index += 1) {
      retained.add(chunkIds[index]);
    }
  }
  return retained;
}

export function pruneChunkMap(
  chunks: Map<string, SerializedChunk>,
  retainedChunkIds: ReadonlySet<string>,
): boolean {
  let changed = false;
  for (const chunkId of chunks.keys()) {
    if (retainedChunkIds.has(chunkId)) continue;
    chunks.delete(chunkId);
    changed = true;
  }
  return changed;
}

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
  const canonicalRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retentionFrameRef = useRef<number | null>(null);
  const chunksMapRef = useRef<Map<string, SerializedChunk>>(new Map());
  const [deltaSeq, setDeltaSeq] = useState(0);
  const canonicalRecoveryRef = useRef({
    epoch: 0,
    inFlight: false,
    dirty: false,
    retryDelayMs: INITIAL_CANONICAL_RETRY_MS,
  });
  const canonicalRecoveryRequestRef = useRef<() => void>(() => undefined);
  const recoverySnapshotRef = useRef<CanonicalRecoverySnapshot | null>(null);
  const [recoverySnapshot, setRecoverySnapshot] = useState<CanonicalRecoverySnapshot | null>(null);
  const [canonicalGeneration, setCanonicalGeneration] = useState<{
    sessionId: string;
    epoch: number;
    index: TranscriptIndex;
    chunks: Map<string, SerializedChunk>;
    pages: TranscriptIndexPage[];
  } | null>(null);
  const activeSessionRef = useRef(sessionId);
  if (activeSessionRef.current !== sessionId) {
    activeSessionRef.current = sessionId;
    chunksMapRef.current = new Map();
  }
  const viewportRef = useRef<{
    sessionId: string;
    first?: number;
    last?: number;
  }>({ sessionId });
  const apiFetch = useFetchFactory();

  const scheduleCanonicalRetry = useCallback(() => {
    if (canonicalRetryTimerRef.current) clearTimeout(canonicalRetryTimerRef.current);
    const retryDelayMs = canonicalRecoveryRef.current.retryDelayMs;
    canonicalRecoveryRef.current.retryDelayMs = Math.min(retryDelayMs * 2, MAX_CANONICAL_RETRY_MS);
    canonicalRetryTimerRef.current = setTimeout(() => {
      canonicalRetryTimerRef.current = null;
      canonicalRecoveryRequestRef.current();
    }, retryDelayMs);
  }, []);

  useLayoutEffect(() => {
    recoverySnapshotRef.current = null;
    canonicalRecoveryRef.current = {
      epoch: canonicalRecoveryRef.current.epoch + 1,
      inFlight: false,
      dirty: false,
      retryDelayMs: INITIAL_CANONICAL_RETRY_MS,
    };
    setRecoverySnapshot(null);
    setCanonicalGeneration(null);
    setExpandedAiGroups(new Map());
    chunksMapRef.current = new Map();
    setDeltaSeq(0);
    return () => {
      canonicalRecoveryRef.current.epoch += 1;
      canonicalRecoveryRef.current.inFlight = false;
      recoverySnapshotRef.current = null;
      if (canonicalRetryTimerRef.current) {
        clearTimeout(canonicalRetryTimerRef.current);
        canonicalRetryTimerRef.current = null;
      }
      void queryClient.cancelQueries({
        queryKey: transcriptQueryKeys.index(sessionId),
        exact: true,
      });
    };
  }, [queryClient, sessionId]);

  const loadCanonicalIndex = useCallback(
    async (signal: AbortSignal): Promise<TranscriptIndex> => {
      const epoch = ++canonicalRecoveryRef.current.epoch;
      canonicalRecoveryRef.current.inFlight = true;
      canonicalRecoveryRef.current.dirty = false;
      const isStale = () =>
        signal.aborted ||
        activeSessionRef.current !== sessionId ||
        canonicalRecoveryRef.current.epoch !== epoch;
      const currentIndex = queryClient.getQueryData<TranscriptIndex>(
        transcriptQueryKeys.index(sessionId),
      );
      if (currentIndex && !recoverySnapshotRef.current) {
        const snapshot = { sessionId, index: currentIndex, chunks: new Map(chunksMapRef.current) };
        recoverySnapshotRef.current = snapshot;
        setRecoverySnapshot(snapshot);
      }
      try {
        await queryClient.cancelQueries({
          predicate: (query) =>
            query.queryKey[0] === 'transcript-chunk-page' && query.queryKey[1] === sessionId,
        });
        if (isStale()) throw new DOMException('Transcript request cancelled', 'AbortError');
        const viewport = viewportRef.current;
        const window: TranscriptIndexRequest = { pageSize: CHUNK_PAGE_SIZE, live: isLive, signal };
        if (
          viewport.sessionId === sessionId &&
          viewport.first !== undefined &&
          viewport.last !== undefined
        ) {
          window.firstVirtualIndex = viewport.first;
          window.lastVirtualIndex = Math.min(
            Math.max(viewport.first, viewport.last),
            viewport.first + MAX_CANONICAL_VISIBLE_CHUNKS - 1,
          );
        }
        const { pages, ...nextIndex } = await fetchTranscriptIndex(sessionId, '', apiFetch, window);
        if (isStale()) throw new DOMException('Transcript request cancelled', 'AbortError');
        if (!pages) throw new Error('Combined transcript response is missing pages');
        const chunks = new Map<string, SerializedChunk>();
        for (const page of pages) {
          for (const chunk of page.response.chunks) chunks.set(chunk.id, chunk);
        }
        setCanonicalGeneration({ sessionId, epoch, index: nextIndex, chunks, pages });
        return nextIndex;
      } catch (error) {
        if (!isStale()) {
          canonicalRecoveryRef.current.inFlight = false;
          scheduleCanonicalRetry();
        }
        throw error;
      }
    },
    [apiFetch, isLive, queryClient, scheduleCanonicalRetry, sessionId],
  );

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
    data: queriedIndex,
    isLoading: indexLoading,
    error: indexError,
  } = useQuery({
    queryKey: transcriptQueryKeys.index(sessionId),
    queryFn: ({ signal }) => loadCanonicalIndex(signal),
    retry: false,
    enabled: !!sessionId && recoverySnapshot === null,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && !data.isOngoing) return false;
      return 5_000;
    },
  });

  const exposedCanonicalGeneration =
    canonicalGeneration?.sessionId === sessionId &&
    canonicalGeneration.epoch === canonicalRecoveryRef.current.epoch
      ? canonicalGeneration
      : null;
  const exposedRecoverySnapshot =
    recoverySnapshot?.sessionId === sessionId ? recoverySnapshot : null;
  const index = exposedCanonicalGeneration?.index ?? exposedRecoverySnapshot?.index ?? queriedIndex;

  const chunkCount = index?.totals.chunkCount ?? 0;
  // The index intentionally contains every chunk ID: these small routing entries let the
  // virtualizer seek anywhere without another index protocol. Only chunk bodies are windowed.
  const chunkIds = index?.chunkIds ?? [];

  // 2. Virtualizer
  const getItemKey = useCallback((i: number) => chunkIds[i] ?? `placeholder-${i}`, [chunkIds]);

  const rowVirtualizer = useVirtualizer({
    count: chunkCount,
    getScrollElement: () => scrollElement,
    estimateSize: () => ESTIMATED_CHUNK_HEIGHT,
    getItemKey,
    overscan: 5,
    initialRect: { width: 0, height: 600 },
    measureElement: (element) => {
      const height = element.getBoundingClientRect().height;
      return height > 0 ? height : ESTIMATED_CHUNK_HEIGHT;
    },
  });

  // 3. Determine visible batch boundaries
  const virtualItems = rowVirtualizer.getVirtualItems();
  const firstVirtualIndex = virtualItems.at(0)?.index;
  const lastVirtualIndex = virtualItems.at(-1)?.index;
  viewportRef.current = { sessionId, first: firstVirtualIndex, last: lastVirtualIndex };
  const retainedChunkIds = useMemo(
    () => buildRetainedChunkIds(chunkIds, firstVirtualIndex, lastVirtualIndex, isLive),
    [chunkIds, firstVirtualIndex, lastVirtualIndex, isLive],
  );

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
      enabled: !!batch.cursor && recoverySnapshot === null,
      staleTime: 30_000,
      gcTime: CHUNK_GC_TIME,
    })),
  });

  // 5. Build chunks map from fetched data + WS delta-injected chunks
  const chunksMap = useMemo(() => {
    if (exposedCanonicalGeneration) return exposedCanonicalGeneration.chunks;
    if (exposedRecoverySnapshot) return exposedRecoverySnapshot.chunks;
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
  }, [batchQueries, deltaSeq, exposedCanonicalGeneration, exposedRecoverySnapshot]);

  useEffect(() => {
    if (!retainedChunkIds) return;
    let cancelled = false;

    const pruneAfterScrollSettles = () => {
      retentionFrameRef.current = requestAnimationFrame(() => {
        retentionFrameRef.current = null;
        if (cancelled) return;
        if (rowVirtualizer.isScrolling) {
          pruneAfterScrollSettles();
          return;
        }
        if (pruneChunkMap(chunksMapRef.current, retainedChunkIds)) {
          setDeltaSeq((sequence) => sequence + 1);
        }
      });
    };

    pruneAfterScrollSettles();
    return () => {
      cancelled = true;
      if (retentionFrameRef.current !== null) {
        cancelAnimationFrame(retentionFrameRef.current);
        retentionFrameRef.current = null;
      }
    };
  }, [retainedChunkIds, rowVirtualizer]);

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
      if (canonicalRecoveryRef.current.inFlight) {
        canonicalRecoveryRef.current.dirty = true;
        return;
      }

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
        cursor: payload.cursor,
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

  const requestCanonicalGeneration = useCallback(() => {
    if (!sessionId) return;
    if (canonicalRecoveryRef.current.inFlight) {
      canonicalRecoveryRef.current.dirty = true;
      return;
    }
    if (canonicalRetryTimerRef.current) {
      clearTimeout(canonicalRetryTimerRef.current);
      canonicalRetryTimerRef.current = null;
    }
    void queryClient
      .fetchQuery({
        queryKey: transcriptQueryKeys.index(sessionId),
        queryFn: ({ signal }) => loadCanonicalIndex(signal),
        staleTime: 0,
      })
      .catch(() => undefined);
  }, [loadCanonicalIndex, queryClient, sessionId]);
  canonicalRecoveryRequestRef.current = requestCanonicalGeneration;

  useLayoutEffect(() => {
    if (!exposedCanonicalGeneration) return;
    const generation = exposedCanonicalGeneration;
    const pendingRefresh = canonicalRecoveryRef.current.dirty;
    chunksMapRef.current = generation.chunks;
    queryClient.setQueryData(transcriptQueryKeys.index(sessionId), generation.index);
    queryClient.removeQueries({
      predicate: (query) =>
        query.queryKey[0] === 'transcript-chunk-page' && query.queryKey[1] === sessionId,
    });
    for (const page of generation.pages) {
      queryClient.setQueryData(
        transcriptQueryKeys.chunkPage(sessionId, page.cursor, page.size),
        page.response,
      );
    }
    if (canonicalRetryTimerRef.current) {
      clearTimeout(canonicalRetryTimerRef.current);
      canonicalRetryTimerRef.current = null;
    }
    recoverySnapshotRef.current = null;
    canonicalRecoveryRef.current.inFlight = false;
    canonicalRecoveryRef.current.dirty = false;
    canonicalRecoveryRef.current.retryDelayMs = INITIAL_CANONICAL_RETRY_MS;
    setRecoverySnapshot(null);
    setDeltaSeq((sequence) => sequence + 1);
    setCanonicalGeneration(null);
    // A coherent response is renderable even if an event requires another refresh.
    if (pendingRefresh) scheduleCanonicalRetry();
  }, [exposedCanonicalGeneration, queryClient, scheduleCanonicalRetry, sessionId]);

  const handleMessage = useCallback(
    (envelope: WsEnvelope) => {
      if (!sessionId) return;
      if (envelope.topic !== `session/${sessionId}/transcript`) return;

      switch (envelope.type) {
        case 'discovered':
        case 'ended':
          if (recoverySnapshotRef.current || canonicalRecoveryRef.current.inFlight) {
            requestCanonicalGeneration();
            break;
          }
          if (invalidateTimerRef.current) {
            clearTimeout(invalidateTimerRef.current);
            invalidateTimerRef.current = null;
          }
          invalidateAll();
          break;
        case 'updated': {
          const payload = envelope.payload as WsTranscriptUpdatedPayload | undefined;
          if (recoverySnapshotRef.current || canonicalRecoveryRef.current.inFlight) {
            requestCanonicalGeneration();
          } else if (payload?.kind === 'full-refetch-required') {
            requestCanonicalGeneration();
          } else if (
            payload?.kind === 'delta' &&
            payload.newChunkIds &&
            payload.newChunkIds.length > 0
          ) {
            applyDeltaToIndex(payload);
          } else {
            // Legacy fallback: no newChunkIds → full refetch
            invalidateAll();
          }
          break;
        }
      }
    },
    [invalidateAll, applyDeltaToIndex, requestCanonicalGeneration, sessionId],
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

  if (indexError && !index) {
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
          start: i * ESTIMATED_CHUNK_HEIGHT,
          size: ESTIMATED_CHUNK_HEIGHT,
        }));

  return (
    <div
      className="relative flex-1 min-h-0"
      role="region"
      aria-label="Session viewer (paged)"
      data-retained-chunks={chunksMap.size}
    >
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
                style={{
                  transform: `translateY(${virtualItem.start}px)`,
                  minHeight: `${virtualItem.size}px`,
                }}
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
                    className="h-full min-h-16 animate-pulse rounded-lg bg-muted/40"
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
