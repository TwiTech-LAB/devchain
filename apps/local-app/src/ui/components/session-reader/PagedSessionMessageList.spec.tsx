/**
 * Unit tests for PagedSessionMessageList WS-delta-driven index extension (4c.1).
 *
 * Layer: UI component unit — cheapest layer that proves the WS delta → index cache
 * extension behavior without requiring full backend integration.
 */
import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  PagedSessionMessageList,
  buildRetainedChunkIds,
  pruneChunkMap,
} from './PagedSessionMessageList';
import { transcriptQueryKeys } from '@/ui/hooks/useSessionTranscript';
import type { SerializedChunk } from '@/ui/hooks/useSessionTranscript';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import type { WsEnvelope } from '@/ui/lib/socket';
import type { TranscriptIndex } from '@/ui/lib/sessions';
import { fetchTranscriptChunks, fetchTranscriptIndex } from '@/ui/lib/sessions';

let mockVirtualStart = 0;
let mockVirtualEnd = 2;
let mockVirtualizerScrolling = false;

jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: jest.fn((options: { count: number }) => ({
    getVirtualItems: () => {
      if (options.count === 0) return [];
      const start = Math.min(mockVirtualStart, options.count - 1);
      const end = Math.min(mockVirtualEnd, options.count - 1);
      return Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => {
        const index = start + offset;
        return { index, start: index * 120, size: 120, key: index, lane: 0, end: 120 };
      });
    },
    getTotalSize: () => options.count * 120,
    measureElement: jest.fn(),
    get isScrolling() {
      return mockVirtualizerScrolling;
    },
  })),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchTranscriptIndex: jest.fn(),
  fetchTranscriptChunks: jest.fn(),
}));

jest.mock('@/ui/hooks/useAutoScrollBottom', () => ({
  useAutoScrollBottom: () => ({
    scrollContainerRef: { current: null },
    bottomRef: { current: null },
    handleScroll: jest.fn(),
  }),
}));

jest.mock('./SessionNavigationToolbar', () => ({
  SessionNavigationToolbar: () => null,
}));

const useAppSocketMock = useAppSocket as jest.MockedFunction<typeof useAppSocket>;
const fetchTranscriptChunksMock = fetchTranscriptChunks as jest.MockedFunction<
  typeof fetchTranscriptChunks
>;
const fetchTranscriptIndexMock = fetchTranscriptIndex as jest.MockedFunction<
  typeof fetchTranscriptIndex
>;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function captureWsHandler(): (envelope: WsEnvelope) => void {
  const lastCall = useAppSocketMock.mock.calls[useAppSocketMock.mock.calls.length - 1];
  const handlers = lastCall?.[0];
  if (!handlers?.message) throw new Error('useAppSocket not called or no message handler');
  return handlers.message as (envelope: WsEnvelope) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
}

function makeIndex(overrides: Partial<TranscriptIndex> = {}): TranscriptIndex {
  return {
    cursor: 'index-cursor',
    totals: { messageCount: 3, chunkCount: 3 },
    chunkIds: ['chunk-0', 'chunk-1', 'chunk-2'],
    latestOutputPreview: null,
    providerName: 'claude',
    isOngoing: true,
    ...overrides,
  };
}

function makeChunk(id: string, generation = id): SerializedChunk {
  return {
    id,
    type: 'user',
    startTime: '2026-01-01T10:00:00.000Z',
    endTime: '2026-01-01T10:00:00.000Z',
    messages: [],
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      messageCount: 0,
      durationMs: 0,
      costUsd: 0,
    },
    generation,
  } as SerializedChunk & { generation: string };
}

const DummyChunkRenderer = ({ chunk }: { chunk: SerializedChunk }) => (
  <div
    data-testid="chunk"
    data-chunk-id={chunk.id}
    data-generation={(chunk as SerializedChunk & { generation?: string }).generation}
  />
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPagedList(queryClient: QueryClient, sessionId = 'session-1') {
  return render(
    <QueryClientProvider client={queryClient}>
      <PagedSessionMessageList
        sessionId={sessionId}
        isLive={true}
        ChunkRenderer={DummyChunkRenderer}
      />
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PagedSessionMessageList WS delta index extension', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVirtualStart = 0;
    mockVirtualEnd = 2;
    mockVirtualizerScrolling = false;
    fetchTranscriptIndexMock.mockResolvedValue(makeIndex());
    fetchTranscriptChunksMock.mockImplementation(async (_sessionId, cursor, limit = 10) => {
      const start = Number(cursor?.match(/(\d+)$/)?.[1] ?? 0);
      return {
        chunks: Array.from({ length: limit }, (_, offset) => makeChunk(`chunk-${start + offset}`)),
        nextCursor: null,
        prevCursor: null,
        totalCount: start + limit,
      };
    });
    queryClient = createQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('extends paged index via setQueryData on WS updated with newChunkIds (no full refetch)', () => {
    const index = makeIndex();
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);

    renderPagedList(queryClient);

    const handler = captureWsHandler();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'delta',
          sessionId: 'session-1',
          cursor: 'cursor-new',
          prevCursor: 'cursor-old',
          replaceFromChunkIndex: 2,
          newChunkIds: ['chunk-2', 'chunk-3'],
          totalChunkCount: 4,
          deltaChunks: [makeChunk('chunk-2'), makeChunk('chunk-3')],
          deltaMessages: [],
          metrics: {
            totalTokens: 500,
            inputTokens: 300,
            outputTokens: 200,
            costUsd: 0.05,
            messageCount: 5,
          },
          newMessageCount: 2,
        },
      });
    });

    const updatedIndex = queryClient.getQueryData<TranscriptIndex>(
      transcriptQueryKeys.index('session-1'),
    );

    expect(updatedIndex).toBeDefined();
    expect(updatedIndex!.chunkIds).toEqual(['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3']);
    expect(updatedIndex!.totals.chunkCount).toBe(4);
    expect(updatedIndex!.totals.messageCount).toBe(5);
    expect(updatedIndex!.cursor).toBe('cursor-new');
    expect(updatedIndex!.isOngoing).toBe(true);

    // Should NOT have invalidated the index query (delta extension, no full refetch)
    const indexInvalidations = invalidateSpy.mock.calls.filter((call) => {
      const opts = call[0] as { queryKey?: readonly unknown[] };
      return (
        opts.queryKey && opts.queryKey[0] === 'transcript-index' && opts.queryKey[1] === 'session-1'
      );
    });
    expect(indexInvalidations).toHaveLength(0);
  });

  it('rejects dirty identical-shape pages and atomically commits only the latest cursor generation', async () => {
    const index = makeIndex();
    const candidateIndex = makeIndex({ cursor: 'candidate-cursor' });
    const latestIndex = makeIndex({ cursor: 'latest-cursor' });
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);
    let recovery = false;
    let recoveryPageCalls = 0;
    const page = deferred<Awaited<ReturnType<typeof fetchTranscriptChunks>>>();
    fetchTranscriptChunksMock.mockImplementation(async (_sessionId, cursor, limit = 10) => {
      if (recovery) {
        recoveryPageCalls += 1;
        if (recoveryPageCalls === 1) return page.promise;
        return {
          chunks: latestIndex.chunkIds.map((id) => makeChunk(id, 'latest')),
          nextCursor: null,
          prevCursor: null,
          totalCount: 3,
        };
      }
      const start = Number(cursor?.match(/(\d+)$/)?.[1] ?? 0);
      return {
        chunks: Array.from({ length: limit }, (_, offset) =>
          makeChunk(`chunk-${start + offset}`, 'old'),
        ),
        nextCursor: null,
        prevCursor: null,
        totalCount: 3,
      };
    });
    fetchTranscriptIndexMock
      .mockResolvedValueOnce(candidateIndex)
      .mockResolvedValueOnce(latestIndex)
      .mockResolvedValueOnce(latestIndex);
    const view = renderPagedList(queryClient);
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-generation="old"]')).toHaveLength(3);
    });

    const observed: string[] = [];
    const observer = new MutationObserver(() => {
      observed.push(
        [...view.container.querySelectorAll('[data-generation]')]
          .map((node) => node.getAttribute('data-generation'))
          .join(','),
      );
    });
    observer.observe(view.container, { childList: true, subtree: true, attributes: true });

    const handler = captureWsHandler();
    recovery = true;
    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'full-refetch-required',
          sessionId: 'session-1',
          sourceChangeKind: 'file-replacement',
        },
      });
    });

    await waitFor(() => expect(fetchTranscriptIndexMock).toHaveBeenCalled());
    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'full-refetch-required',
          sessionId: 'session-1',
          sourceChangeKind: 'same-file-rewrite',
        },
      });
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'delta',
          sessionId: 'session-1',
          cursor: 'ignored-cursor',
          prevCursor: 'old-cursor',
          replaceFromChunkIndex: 0,
          newChunkIds: index.chunkIds,
          totalChunkCount: 3,
          deltaChunks: index.chunkIds.map((id) => makeChunk(id, 'delta')),
          deltaMessages: [],
          metrics: {
            totalTokens: 3,
            inputTokens: 3,
            outputTokens: 0,
            costUsd: 0,
            messageCount: 3,
          },
          newMessageCount: 0,
        },
      });
    });
    expect(view.container.querySelectorAll('[data-generation="old"]')).toHaveLength(3);

    await act(async () => {
      page.resolve({
        chunks: candidateIndex.chunkIds.map((id) => makeChunk(id, 'stale')),
        nextCursor: null,
        prevCursor: null,
        totalCount: 3,
      });
    });
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-generation="latest"]')).toHaveLength(3);
    });
    observer.disconnect();
    expect(view.container.querySelectorAll('[data-generation="stale"]')).toHaveLength(0);
    expect(view.container.querySelectorAll('[data-generation="delta"]')).toHaveLength(0);
    expect(
      queryClient.getQueryData<TranscriptIndex>(transcriptQueryKeys.index('session-1'))?.cursor,
    ).toBe('latest-cursor');
    expect(
      observed.every(
        (value) =>
          !value.includes('stale') &&
          !value.includes('delta') &&
          !value.includes('old,latest') &&
          !value.includes('latest,old'),
      ),
    ).toBe(true);
  });

  it('stages a count-growing replacement before exposing its new index and pages', async () => {
    const oldIndex = makeIndex();
    const nextIndex = makeIndex({
      cursor: 'growing-cursor',
      totals: { messageCount: 4, chunkCount: 4 },
      chunkIds: ['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3'],
    });
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), oldIndex);
    let recovery = false;
    const page = deferred<Awaited<ReturnType<typeof fetchTranscriptChunks>>>();
    fetchTranscriptChunksMock.mockImplementation(async (_sessionId, cursor, limit = 10) => {
      if (recovery) return page.promise;
      const start = Number(cursor?.match(/(\d+)$/)?.[1] ?? 0);
      return {
        chunks: Array.from({ length: limit }, (_, offset) =>
          makeChunk(`chunk-${start + offset}`, 'old'),
        ),
        nextCursor: null,
        prevCursor: null,
        totalCount: 3,
      };
    });
    fetchTranscriptIndexMock.mockResolvedValue(nextIndex);
    const view = renderPagedList(queryClient);
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-generation="old"]')).toHaveLength(3);
    });

    recovery = true;
    mockVirtualEnd = 3;
    const handler = captureWsHandler();
    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'full-refetch-required',
          sessionId: 'session-1',
          sourceChangeKind: 'same-file-rewrite',
        },
      });
    });

    expect(view.container.querySelectorAll('[data-generation="old"]')).toHaveLength(3);
    await act(async () => {
      page.resolve({
        chunks: nextIndex.chunkIds.map((id) => makeChunk(id, 'new-growing')),
        nextCursor: null,
        prevCursor: null,
        totalCount: 4,
      });
    });
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-generation="new-growing"]')).toHaveLength(4);
    });
  });

  it('keeps the old paged index and map when canonical page staging fails', async () => {
    const index = makeIndex();
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);
    let recovery = false;
    const page = deferred<Awaited<ReturnType<typeof fetchTranscriptChunks>>>();
    fetchTranscriptChunksMock.mockImplementation(async (_sessionId, cursor, limit = 10) => {
      if (recovery) return page.promise;
      const start = Number(cursor?.match(/(\d+)$/)?.[1] ?? 0);
      return {
        chunks: Array.from({ length: limit }, (_, offset) =>
          makeChunk(`chunk-${start + offset}`, 'old'),
        ),
        nextCursor: null,
        prevCursor: null,
        totalCount: 3,
      };
    });
    fetchTranscriptIndexMock.mockResolvedValue(index);
    const view = renderPagedList(queryClient);
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-generation="old"]')).toHaveLength(3);
    });

    recovery = true;
    const handler = captureWsHandler();
    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'full-refetch-required',
          sessionId: 'session-1',
          sourceChangeKind: 'file-replacement',
        },
      });
    });
    await act(async () => {
      page.reject(new Error('page failed'));
    });
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-generation="old"]')).toHaveLength(3);
    });
    expect(queryClient.getQueryData<TranscriptIndex>(transcriptQueryKeys.index('session-1'))).toBe(
      index,
    );
  });

  it('keeps the old generation shielded across failed attempts and a bounded retry', async () => {
    jest.useFakeTimers();
    const oldIndex = makeIndex({ cursor: 'old-cursor' });
    const candidateOne = makeIndex({ cursor: 'candidate-one' });
    const candidateTwo = makeIndex({ cursor: 'candidate-two' });
    const latestIndex = makeIndex({ cursor: 'latest-cursor' });
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), oldIndex);

    let recovery = false;
    let recoveryPageCalls = 0;
    const firstPage = deferred<Awaited<ReturnType<typeof fetchTranscriptChunks>>>();
    const secondPage = deferred<Awaited<ReturnType<typeof fetchTranscriptChunks>>>();
    const retryIndex = deferred<TranscriptIndex>();
    fetchTranscriptChunksMock.mockImplementation(async (_sessionId, cursor, limit = 10) => {
      if (recovery) {
        recoveryPageCalls += 1;
        if (recoveryPageCalls === 1) return firstPage.promise;
        if (recoveryPageCalls === 2) return secondPage.promise;
        return {
          chunks: latestIndex.chunkIds.map((id) => makeChunk(id, 'latest')),
          nextCursor: null,
          prevCursor: null,
          totalCount: latestIndex.chunkIds.length,
        };
      }
      const start = Number(cursor?.match(/(\d+)$/)?.[1] ?? 0);
      return {
        chunks: Array.from({ length: limit }, (_, offset) =>
          makeChunk(`chunk-${start + offset}`, 'old'),
        ),
        nextCursor: null,
        prevCursor: null,
        totalCount: oldIndex.chunkIds.length,
      };
    });
    fetchTranscriptIndexMock
      .mockResolvedValueOnce(candidateOne)
      .mockResolvedValueOnce(candidateTwo)
      .mockImplementationOnce(() => retryIndex.promise)
      .mockResolvedValueOnce(latestIndex);

    const view = renderPagedList(queryClient);
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-generation="old"]')).toHaveLength(3);
    });

    const observed: string[] = [];
    const observer = new MutationObserver(() => {
      observed.push(
        [...view.container.querySelectorAll('[data-generation]')]
          .map((node) => node.getAttribute('data-generation'))
          .join(','),
      );
    });
    observer.observe(view.container, { childList: true, subtree: true, attributes: true });

    recovery = true;
    const handler = captureWsHandler();
    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'full-refetch-required',
          sessionId: 'session-1',
          sourceChangeKind: 'file-replacement',
        },
      });
    });
    await waitFor(() => expect(recoveryPageCalls).toBe(1));

    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'discovered',
        ts: Date.now(),
        payload: { sessionId: 'session-1' },
      });
    });
    await act(async () => {
      firstPage.resolve({
        chunks: candidateOne.chunkIds.map((id) => makeChunk(id, 'candidate-one')),
        nextCursor: null,
        prevCursor: null,
        totalCount: candidateOne.chunkIds.length,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(recoveryPageCalls).toBe(2));

    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'ended',
        ts: Date.now(),
        payload: { sessionId: 'session-1' },
      });
    });
    await act(async () => {
      secondPage.resolve({
        chunks: candidateTwo.chunkIds.map((id) => makeChunk(id, 'candidate-two')),
        nextCursor: null,
        prevCursor: null,
        totalCount: candidateTwo.chunkIds.length,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(2);
    expect(view.container.querySelectorAll('[data-generation="old"]')).toHaveLength(3);
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-1'))).toBe(oldIndex);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(4_100);
    });
    expect(view.container.querySelectorAll('[data-generation="old"]')).toHaveLength(3);
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-1'))).toBe(oldIndex);
    expect(
      queryClient
        .getQueryData<
          Awaited<ReturnType<typeof fetchTranscriptChunks>>
        >(transcriptQueryKeys.chunkPage('session-1', 'chunk-0', 3))
        ?.chunks.map((chunk) => (chunk as SerializedChunk & { generation?: string }).generation),
    ).toEqual(['old', 'old', 'old']);

    await act(async () => {
      retryIndex.resolve(latestIndex);
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-generation="latest"]')).toHaveLength(3);
    });

    observer.disconnect();
    expect(
      observed.every(
        (value) =>
          !value.includes('candidate-one') &&
          !value.includes('candidate-two') &&
          !value.includes('old,latest') &&
          !value.includes('latest,old'),
      ),
    ).toBe(true);
    expect(
      queryClient.getQueryData<TranscriptIndex>(transcriptQueryKeys.index('session-1'))?.cursor,
    ).toBe('latest-cursor');
    expect(
      queryClient
        .getQueryData<
          Awaited<ReturnType<typeof fetchTranscriptChunks>>
        >(transcriptQueryKeys.chunkPage('session-1', 'chunk-0', 3))
        ?.chunks.map((chunk) => (chunk as SerializedChunk & { generation?: string }).generation),
    ).toEqual(['latest', 'latest', 'latest']);

    view.unmount();
    jest.useRealTimers();
  });

  it('cancels a scheduled canonical retry when the paged session is disposed', async () => {
    jest.useFakeTimers();
    const oldIndex = makeIndex({ cursor: 'old-cursor' });
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), oldIndex);
    fetchTranscriptIndexMock.mockRejectedValue(new Error('index unavailable'));

    const view = renderPagedList(queryClient);
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-testid="chunk"]')).toHaveLength(3);
    });

    const handler = captureWsHandler();
    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'full-refetch-required',
          sessionId: 'session-1',
          sourceChangeKind: 'file-replacement',
        },
      });
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1);

    view.unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('falls back to full refetch on gap detection (replaceFromChunkIndex > current length)', () => {
    const index = makeIndex({
      totals: { messageCount: 2, chunkCount: 2 },
      chunkIds: ['chunk-0', 'chunk-1'],
    });
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);

    renderPagedList(queryClient);

    const handler = captureWsHandler();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'delta',
          sessionId: 'session-1',
          cursor: 'cursor-new',
          prevCursor: 'cursor-old',
          replaceFromChunkIndex: 5,
          newChunkIds: ['chunk-5', 'chunk-6'],
          totalChunkCount: 7,
          deltaChunks: [],
          deltaMessages: [],
          metrics: {
            totalTokens: 500,
            inputTokens: 300,
            outputTokens: 200,
            costUsd: 0.05,
            messageCount: 10,
          },
          newMessageCount: 3,
        },
      });
    });

    // Gap detected → should invalidate the index (full refetch)
    const indexInvalidations = invalidateSpy.mock.calls.filter((call) => {
      const opts = call[0] as { queryKey?: readonly unknown[] };
      return (
        opts.queryKey && opts.queryKey[0] === 'transcript-index' && opts.queryKey[1] === 'session-1'
      );
    });
    expect(indexInvalidations.length).toBeGreaterThan(0);
  });

  it('falls back to full refetch when no newChunkIds in payload (legacy server)', () => {
    const index = makeIndex();
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);

    renderPagedList(queryClient);

    const handler = captureWsHandler();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'delta',
          sessionId: 'session-1',
          cursor: 'cursor-new',
          prevCursor: 'cursor-old',
          replaceFromChunkIndex: 2,
          deltaChunks: [],
          deltaMessages: [],
          metrics: {
            totalTokens: 500,
            inputTokens: 300,
            outputTokens: 200,
            costUsd: 0.05,
            messageCount: 5,
          },
          newMessageCount: 2,
        },
      });
    });

    // No newChunkIds → should invalidate the index (full refetch fallback)
    const indexInvalidations = invalidateSpy.mock.calls.filter((call) => {
      const opts = call[0] as { queryKey?: readonly unknown[] };
      return (
        opts.queryKey && opts.queryKey[0] === 'transcript-index' && opts.queryKey[1] === 'session-1'
      );
    });
    expect(indexInvalidations.length).toBeGreaterThan(0);
  });

  it('does full invalidation on discovered and ended events (no change to these)', () => {
    const index = makeIndex();
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);

    renderPagedList(queryClient);

    const handler = captureWsHandler();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'discovered',
        ts: Date.now(),
        payload: { sessionId: 'session-1' },
      });
    });

    const indexInvalidations = invalidateSpy.mock.calls.filter((call) => {
      const opts = call[0] as { queryKey?: readonly unknown[] };
      return (
        opts.queryKey && opts.queryKey[0] === 'transcript-index' && opts.queryKey[1] === 'session-1'
      );
    });
    expect(indexInvalidations.length).toBeGreaterThan(0);
  });

  it('ignores WS events for other sessions', () => {
    const index = makeIndex();
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);

    renderPagedList(queryClient);

    const handler = captureWsHandler();

    act(() => {
      handler({
        topic: 'session/other-session/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'delta',
          sessionId: 'other-session',
          newChunkIds: ['chunk-99'],
          replaceFromChunkIndex: 0,
          totalChunkCount: 1,
          deltaChunks: [],
          deltaMessages: [],
          metrics: {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            messageCount: 0,
          },
          newMessageCount: 0,
        },
      });
    });

    // Original index should be unchanged
    const unchangedIndex = queryClient.getQueryData<TranscriptIndex>(
      transcriptQueryKeys.index('session-1'),
    );
    expect(unchangedIndex!.chunkIds).toEqual(['chunk-0', 'chunk-1', 'chunk-2']);
  });
});

describe('paged transcript chunk retention', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVirtualStart = 0;
    mockVirtualEnd = 4;
    mockVirtualizerScrolling = false;
    fetchTranscriptIndexMock.mockResolvedValue(makeIndex());
    queryClient = createQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('keeps delta bodies bounded across long-running scroll-window cycles', () => {
    const chunkIds: string[] = [];
    const chunks = new Map<string, SerializedChunk>();

    for (let delta = 0; delta < 500; delta += 1) {
      const chunkId = `chunk-${delta}`;
      chunkIds.push(chunkId);
      chunks.set(chunkId, makeChunk(chunkId));
      const first = Math.max(0, delta - ((delta * 7) % 40));
      const retained = buildRetainedChunkIds(chunkIds, first, first + 5, true)!;
      pruneChunkMap(chunks, retained);

      expect(chunks.size).toBeLessThanOrEqual(36);
      expect(chunks.has(chunkId)).toBe(true);
    }
  });

  it('defers eviction until the virtualizer reports settled scrolling', async () => {
    const chunkIds = Array.from({ length: 30 }, (_, index) => `chunk-${index}`);
    queryClient.setQueryData(
      transcriptQueryKeys.index('session-1'),
      makeIndex({
        totals: { messageCount: 30, chunkCount: 30 },
        chunkIds,
      }),
    );
    fetchTranscriptChunksMock.mockResolvedValue({
      chunks: chunkIds.slice(0, 10).map(makeChunk),
      nextCursor: null,
      prevCursor: null,
      totalCount: 30,
    });

    const view = renderPagedList(queryClient);
    await waitFor(() => {
      expect(view.container.querySelector('[data-chunk-id="chunk-0"]')).not.toBeNull();
    });
    const handler = captureWsHandler();
    const deltaIds = Array.from({ length: 40 }, (_, offset) => `chunk-${30 + offset}`);
    mockVirtualizerScrolling = true;
    act(() => {
      handler({
        topic: 'session/session-1/transcript',
        type: 'updated',
        ts: Date.now(),
        payload: {
          kind: 'delta',
          sessionId: 'session-1',
          cursor: 'cursor-69',
          prevCursor: 'cursor-29',
          replaceFromChunkIndex: 30,
          newChunkIds: deltaIds,
          totalChunkCount: 70,
          deltaChunks: deltaIds.map(makeChunk),
          deltaMessages: [],
          metrics: {
            totalTokens: 70,
            inputTokens: 70,
            outputTokens: 0,
            costUsd: 0,
            messageCount: 70,
          },
          newMessageCount: 40,
        },
      });
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(Number(view.getByRole('region').dataset.retainedChunks)).toBeGreaterThan(25);

    mockVirtualizerScrolling = false;
    await waitFor(() => {
      expect(Number(view.getByRole('region').dataset.retainedChunks)).toBeLessThanOrEqual(25);
    });
  });

  it('preserves live deltas, evicts settled windows, and refetches old pages in order', async () => {
    const initialChunkIds = Array.from({ length: 30 }, (_, index) => `chunk-${index}`);
    queryClient.setQueryData(
      transcriptQueryKeys.index('session-1'),
      makeIndex({
        totals: { messageCount: 30, chunkCount: 30 },
        chunkIds: initialChunkIds,
      }),
    );

    let holdPageZero = false;
    let resolvePageZero:
      | ((value: Awaited<ReturnType<typeof fetchTranscriptChunks>>) => void)
      | undefined;
    fetchTranscriptChunksMock.mockImplementation((_sessionId, cursor, limit = 10) => {
      const start = Number(cursor?.match(/(\d+)$/)?.[1] ?? 0);
      const response = {
        chunks: Array.from({ length: limit }, (_, offset) => makeChunk(`chunk-${start + offset}`)),
        nextCursor: null,
        prevCursor: null,
        totalCount: 90,
      };
      if (holdPageZero && start === 0) {
        return new Promise((resolve) => {
          resolvePageZero = resolve;
        });
      }
      return Promise.resolve(response);
    });

    const view = renderPagedList(queryClient);
    let renderRevision = 0;
    await waitFor(() => {
      expect(view.container.querySelector('[data-chunk-id="chunk-0"]')).not.toBeNull();
    });
    const handler = captureWsHandler();

    act(() => {
      for (let delta = 0; delta < 60; delta += 1) {
        const index = 30 + delta;
        handler({
          topic: 'session/session-1/transcript',
          type: 'updated',
          ts: Date.now(),
          payload: {
            kind: 'delta',
            sessionId: 'session-1',
            cursor: `cursor-${index}`,
            prevCursor: `cursor-${index - 1}`,
            replaceFromChunkIndex: index,
            newChunkIds: [`chunk-${index}`],
            totalChunkCount: index + 1,
            deltaChunks: [makeChunk(`chunk-${index}`)],
            deltaMessages: [],
            metrics: {
              totalTokens: index,
              inputTokens: index,
              outputTokens: 0,
              costUsd: 0,
              messageCount: index + 1,
            },
            newMessageCount: 1,
          },
        });
      }
    });

    await waitFor(() => {
      const retained = Number(view.getByRole('region').dataset.retainedChunks);
      expect(retained).toBeLessThanOrEqual(25);
    });

    mockVirtualStart = 40;
    mockVirtualEnd = 44;
    act(() => {
      queryClient.setQueryData<TranscriptIndex>(
        transcriptQueryKeys.index('session-1'),
        (current) =>
          current
            ? {
                ...current,
                chunkIds: [...current.chunkIds],
                latestOutputPreview: `scroll-${(renderRevision += 1)}`,
              }
            : current,
      );
    });
    await waitFor(() => {
      expect(view.container.querySelector('[data-chunk-id="chunk-40"]')).not.toBeNull();
    });
    await waitFor(() => {
      const retained = Number(view.getByRole('region').dataset.retainedChunks);
      expect(retained).toBeLessThanOrEqual(35);
    });

    mockVirtualStart = 85;
    mockVirtualEnd = 89;
    act(() => {
      queryClient.setQueryData<TranscriptIndex>(
        transcriptQueryKeys.index('session-1'),
        (current) =>
          current
            ? {
                ...current,
                chunkIds: [...current.chunkIds],
                latestOutputPreview: `scroll-${(renderRevision += 1)}`,
              }
            : current,
      );
    });
    await waitFor(() => {
      const renderedIds = [...view.container.querySelectorAll('[data-chunk-id]')].map((node) =>
        node.getAttribute('data-chunk-id'),
      );
      expect(renderedIds).toEqual(['chunk-85', 'chunk-86', 'chunk-87', 'chunk-88', 'chunk-89']);
    });

    await waitFor(() => {
      expect(Number(view.getByRole('region').dataset.retainedChunks)).toBeLessThanOrEqual(25);
    });
    holdPageZero = true;
    queryClient.removeQueries({
      queryKey: transcriptQueryKeys.chunkPage('session-1', 'chunk-0', 10),
      exact: true,
    });
    mockVirtualStart = 0;
    mockVirtualEnd = 4;
    act(() => {
      queryClient.setQueryData<TranscriptIndex>(
        transcriptQueryKeys.index('session-1'),
        (current) =>
          current
            ? {
                ...current,
                chunkIds: [...current.chunkIds],
                latestOutputPreview: `scroll-${(renderRevision += 1)}`,
              }
            : current,
      );
    });

    await waitFor(() => {
      const skeleton = view.getAllByTestId('chunk-skeleton')[0];
      expect(skeleton.parentElement?.style.minHeight).toBe('120px');
    });
    expect(
      fetchTranscriptChunksMock.mock.calls.filter(([, cursor]) => cursor === 'chunk-0'),
    ).toHaveLength(2);

    act(() => {
      resolvePageZero?.({
        chunks: Array.from({ length: 10 }, (_, index) => makeChunk(`chunk-${index}`)),
        nextCursor: null,
        prevCursor: null,
        totalCount: 90,
      });
    });
    await waitFor(() => {
      const renderedIds = [...view.container.querySelectorAll('[data-chunk-id]')].map((node) =>
        node.getAttribute('data-chunk-id'),
      );
      expect(renderedIds).toEqual(['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3', 'chunk-4']);
    });
  });
});
