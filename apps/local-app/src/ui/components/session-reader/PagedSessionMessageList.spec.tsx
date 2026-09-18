/**
 * Unit tests for PagedSessionMessageList WS-delta-driven index extension (4c.1).
 *
 * Layer: UI component unit — cheapest layer that proves the WS delta → index cache
 * extension behavior without requiring full backend integration.
 */
import React from 'react';
import { render, act, waitFor, fireEvent } from '@testing-library/react';
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

function combinedIndex(index = makeIndex(), generation = 'combined'): TranscriptIndex {
  return {
    ...index,
    pages: index.chunkIds.length
      ? [
          {
            cursor: index.chunkIds[0],
            size: index.chunkIds.length,
            response: {
              chunks: index.chunkIds.map((id) => makeChunk(id, generation)),
              nextCursor: null,
              prevCursor: null,
              totalCount: index.chunkIds.length,
            },
          },
        ]
      : [],
  };
}

function requireCanonicalRefresh(sessionId = 'session-1') {
  captureWsHandler()({
    topic: `session/${sessionId}/transcript`,
    type: 'updated',
    ts: Date.now(),
    payload: { kind: 'full-refetch-required', sessionId, sourceChangeKind: 'file-replacement' },
  });
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
    fetchTranscriptIndexMock.mockReset().mockResolvedValue(combinedIndex());
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

  afterEach(async () => {
    await act(async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
    });
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

  it('loads index and initial bodies with one combined request and keeps the index cache body-free', async () => {
    const view = renderPagedList(queryClient);
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-generation="combined"]')).toHaveLength(3),
    );
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1);
    expect(fetchTranscriptIndexMock).toHaveBeenCalledWith('session-1', '', expect.any(Function), {
      pageSize: 10,
      live: true,
      signal: expect.any(AbortSignal),
    });
    expect(fetchTranscriptChunksMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-1'))).not.toHaveProperty(
      'pages',
    );
    expect(
      queryClient.getQueryData(transcriptQueryKeys.chunkPage('session-1', 'chunk-0', 3)),
    ).toMatchObject({ totalCount: 3 });
  });

  it('renders coherent snapshots during continuous updates and coalesces one follow-up even with equal cursors', async () => {
    jest.useFakeTimers();
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), makeIndex());
    const first = deferred<TranscriptIndex>();
    const second = deferred<TranscriptIndex>();
    const third = deferred<TranscriptIndex>();
    fetchTranscriptIndexMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const view = renderPagedList(queryClient);
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-testid="chunk"]')).toHaveLength(3),
    );
    const pageReads = fetchTranscriptChunksMock.mock.calls.length;
    act(() => requireCanonicalRefresh());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    act(() => {
      for (let i = 0; i < 5; i++) requireCanonicalRefresh();
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(combinedIndex(makeIndex(), 'first'));
    });
    expect(view.container.querySelectorAll('[data-generation="first"]')).toHaveLength(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(2);
    act(() => {
      for (let i = 0; i < 5; i++) requireCanonicalRefresh();
    });
    await act(async () => {
      second.resolve(combinedIndex(makeIndex(), 'second'));
    });
    expect(view.container.querySelectorAll('[data-generation="second"]')).toHaveLength(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(3);
    await act(async () => {
      third.resolve(combinedIndex(makeIndex(), 'third'));
    });
    expect(view.container.querySelectorAll('[data-generation="third"]')).toHaveLength(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(3);
    expect(fetchTranscriptChunksMock).toHaveBeenCalledTimes(pageReads);
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-1'))).not.toHaveProperty(
      'pages',
    );
    view.unmount();
  });

  it('coalesces events during initial loading without cancelling the coherent response', async () => {
    jest.useFakeTimers();
    const initial = deferred<TranscriptIndex>();
    fetchTranscriptIndexMock
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(combinedIndex(makeIndex(), 'updated'));
    const view = renderPagedList(queryClient);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    act(() => {
      requireCanonicalRefresh();
      requireCanonicalRefresh();
    });
    await act(async () => {
      initial.resolve(combinedIndex(makeIndex(), 'initial'));
    });
    expect(view.container.querySelectorAll('[data-generation="initial"]')).toHaveLength(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(view.container.querySelectorAll('[data-generation="updated"]')).toHaveLength(3);
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(2);
    expect(fetchTranscriptChunksMock).not.toHaveBeenCalled();
    view.unmount();
  });

  it('commits a count-growing replacement atomically with one combined read', async () => {
    const oldIndex = makeIndex();
    const nextIndex = makeIndex({
      cursor: 'new',
      totals: { messageCount: 4, chunkCount: 4 },
      chunkIds: ['chunk-0', 'chunk-1', 'chunk-2', 'chunk-3'],
    });
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), oldIndex);
    queryClient.setQueryData(
      transcriptQueryKeys.chunkPage('session-1', 'chunk-0', 3),
      combinedIndex(oldIndex, 'old').pages![0].response,
    );
    const response = deferred<TranscriptIndex>();
    fetchTranscriptIndexMock.mockReturnValueOnce(response.promise);
    const view = renderPagedList(queryClient);
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-testid="chunk"]')).toHaveLength(3),
    );
    const observed: string[][] = [];
    const observer = new MutationObserver(() => {
      observed.push(
        [...view.container.querySelectorAll('[data-generation]')].map(
          (node) => node.getAttribute('data-generation')!,
        ),
      );
    });
    observer.observe(view.container, { childList: true, subtree: true, attributes: true });
    const pageReads = fetchTranscriptChunksMock.mock.calls.length;
    mockVirtualEnd = 3;
    act(() => requireCanonicalRefresh());
    await waitFor(() => expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-1'))).toBe(oldIndex);
    expect(view.container.querySelectorAll('[data-testid="chunk"]')).toHaveLength(3);
    await act(async () => {
      response.resolve(combinedIndex(nextIndex, 'new'));
    });
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-generation="new"]')).toHaveLength(4),
    );
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1);
    expect(fetchTranscriptChunksMock).toHaveBeenCalledTimes(pageReads);
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-1'))).toEqual(nextIndex);
    observer.disconnect();
    expect(observed.length).toBeGreaterThan(0);
    expect(
      observed.every((generations) => generations.length > 0 && new Set(generations).size === 1),
    ).toBe(true);
  });

  it('preserves the prior generation across transport failures and retries with bounded backoff', async () => {
    jest.useFakeTimers();
    const oldIndex = makeIndex();
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), oldIndex);
    fetchTranscriptIndexMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(combinedIndex(makeIndex(), 'recovered'));
    const view = renderPagedList(queryClient);
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-testid="chunk"]')).toHaveLength(3),
    );
    act(() => requireCanonicalRefresh());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(999);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-1'))).toBe(oldIndex);
    expect(view.container.querySelectorAll('[data-testid="chunk"]')).toHaveLength(3);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1999);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-1'))).toBe(oldIndex);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(3);
    expect(view.container.querySelectorAll('[data-generation="recovered"]')).toHaveLength(3);
    view.unmount();
  });

  it('aborts a disposed request and ignores its late response', async () => {
    const response = deferred<TranscriptIndex>();
    fetchTranscriptIndexMock.mockReturnValueOnce(response.promise);
    const view = renderPagedList(queryClient);
    await waitFor(() => expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1));
    const signal = fetchTranscriptIndexMock.mock.calls[0][3]!.signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      response.resolve(combinedIndex());
    });
    expect(
      queryClient.getQueryData(transcriptQueryKeys.chunkPage('session-1', 'chunk-0', 3)),
    ).toBeUndefined();
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-1'))).toBeUndefined();
  });

  it('ignores an old-session response after switching sessions', async () => {
    const old = deferred<TranscriptIndex>();
    fetchTranscriptIndexMock
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(combinedIndex(makeIndex(), 'new-session'));
    const view = renderPagedList(queryClient);
    await waitFor(() => expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1));
    const signal = fetchTranscriptIndexMock.mock.calls[0][3]!.signal!;
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <PagedSessionMessageList
          sessionId="session-2"
          isLive={true}
          ChunkRenderer={DummyChunkRenderer}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-generation="new-session"]')).toHaveLength(3),
    );
    await act(async () => {
      old.resolve(combinedIndex(makeIndex(), 'old-session'));
    });
    expect(signal.aborted).toBe(true);
    expect(view.container.querySelectorAll('[data-generation="old-session"]')).toHaveLength(0);
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-1'))).toBeUndefined();
    expect(queryClient.getQueryData(transcriptQueryKeys.index('session-2'))).not.toHaveProperty(
      'pages',
    );
  });

  it('bounds oversized visible windows and preserves lazy paging beyond the combined response', async () => {
    mockVirtualEnd = 179;
    const index = makeIndex({
      totals: { messageCount: 303, chunkCount: 303 },
      chunkIds: Array.from({ length: 303 }, (_, i) => `chunk-${i}`),
    });
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);
    const starts = [...Array.from({ length: 15 }, (_, i) => i * 10), 290, 300];
    fetchTranscriptIndexMock.mockResolvedValueOnce({
      ...index,
      pages: starts.map((start) => ({
        cursor: index.chunkIds[start],
        size: Math.min(10, 303 - start),
        response: {
          chunks: index.chunkIds.slice(start, start + 10).map((id) => makeChunk(id, 'combined')),
          nextCursor: index.chunkIds[start + 10] ?? null,
          prevCursor: index.chunkIds[start - 1] ?? null,
          totalCount: 303,
        },
      })),
    });
    const view = renderPagedList(queryClient);
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-testid="chunk"]')).toHaveLength(180),
    );
    fetchTranscriptChunksMock.mockClear();
    await act(async () => requireCanonicalRefresh());
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-generation="combined"]')).toHaveLength(150),
    );
    expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(1);
    expect(fetchTranscriptIndexMock.mock.calls[0][3]).toMatchObject({
      pageSize: 10,
      firstVirtualIndex: 0,
      lastVirtualIndex: 139,
      live: true,
    });
    await waitFor(() =>
      expect(fetchTranscriptChunksMock.mock.calls.map((call) => call[1])).toEqual([
        'chunk-150',
        'chunk-160',
        'chunk-170',
      ]),
    );
    expect(view.container.querySelectorAll('[data-testid="chunk"]')).toHaveLength(180);
  });

  it('sends the measured viewport and preserves scroll position and expansion across replacement', async () => {
    mockVirtualStart = 25;
    mockVirtualEnd = 32;
    const index = makeIndex({
      totals: { messageCount: 50, chunkCount: 50 },
      chunkIds: Array.from({ length: 50 }, (_, i) => `chunk-${i}`),
    });
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);
    const response = {
      ...index,
      pages: [10, 20, 30, 40].map((start) => ({
        cursor: index.chunkIds[start],
        size: 10,
        response: {
          chunks: index.chunkIds.slice(start, start + 10).map((id) => makeChunk(id, 'new')),
          nextCursor: index.chunkIds[start + 10] ?? null,
          prevCursor: index.chunkIds[start - 1] ?? null,
          totalCount: 50,
        },
      })),
    };
    fetchTranscriptIndexMock.mockResolvedValueOnce(response);
    const Renderer = ({
      chunk,
      isAiGroupExpanded,
      onAiGroupToggle,
    }: {
      chunk: SerializedChunk;
      isAiGroupExpanded?: boolean;
      onAiGroupToggle?: (id: string) => void;
    }) => (
      <button
        data-testid={chunk.id}
        aria-expanded={isAiGroupExpanded}
        onClick={() => onAiGroupToggle?.(chunk.id)}
      >
        {chunk.id}
      </button>
    );
    const view = render(
      <QueryClientProvider client={queryClient}>
        <PagedSessionMessageList sessionId="session-1" isLive={false} ChunkRenderer={Renderer} />
      </QueryClientProvider>,
    );
    const chunk = await view.findByTestId('chunk-25');
    fireEvent.click(chunk);
    const scroll = view.getByTestId('paged-session-viewer-scroll');
    scroll.scrollTop = 3000;
    await act(async () => requireCanonicalRefresh());
    expect(fetchTranscriptIndexMock.mock.calls[0][3]).toMatchObject({
      pageSize: 10,
      firstVirtualIndex: 25,
      lastVirtualIndex: 32,
      live: false,
    });
    expect(view.getByTestId('chunk-25')).toBe(chunk);
    expect(chunk).toHaveAttribute('aria-expanded', 'true');
    expect(scroll.scrollTop).toBe(3000);
  });

  it('caps retry backoff at five seconds and cancels it on session switch', async () => {
    jest.useFakeTimers();
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), makeIndex());
    fetchTranscriptIndexMock.mockRejectedValue(new Error('offline'));
    const view = renderPagedList(queryClient);
    await waitFor(() =>
      expect(view.container.querySelectorAll('[data-testid="chunk"]')).toHaveLength(3),
    );
    await act(async () => requireCanonicalRefresh());
    let requests = 1;
    for (const delay of [1000, 2000, 4000, 5000, 5000]) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(delay - 1);
      });
      expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(requests);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(fetchTranscriptIndexMock).toHaveBeenCalledTimes(++requests);
    }
    fetchTranscriptIndexMock.mockResolvedValueOnce(combinedIndex(makeIndex({ isOngoing: false })));
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <PagedSessionMessageList
          sessionId="session-2"
          isLive={false}
          ChunkRenderer={DummyChunkRenderer}
        />
      </QueryClientProvider>,
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10000);
    });
    expect(
      fetchTranscriptIndexMock.mock.calls.filter((call) => call[0] === 'session-1'),
    ).toHaveLength(requests);
    expect(
      fetchTranscriptIndexMock.mock.calls.filter((call) => call[0] === 'session-2'),
    ).toHaveLength(1);
    view.unmount();
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

  it('falls back to full refetch on gap detection (replaceFromChunkIndex > current length)', async () => {
    const index = makeIndex({
      totals: { messageCount: 2, chunkCount: 2 },
      chunkIds: ['chunk-0', 'chunk-1'],
    });
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);

    renderPagedList(queryClient);

    const handler = captureWsHandler();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
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

  it('falls back to full refetch when no newChunkIds in payload (legacy server)', async () => {
    const index = makeIndex();
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);

    renderPagedList(queryClient);

    const handler = captureWsHandler();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
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

  it('does full invalidation on discovered and ended events (no change to these)', async () => {
    const index = makeIndex();
    queryClient.setQueryData(transcriptQueryKeys.index('session-1'), index);

    renderPagedList(queryClient);

    const handler = captureWsHandler();
    const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');

    await act(async () => {
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
    fetchTranscriptIndexMock.mockReset().mockResolvedValue(combinedIndex());
    queryClient = createQueryClient();
  });

  afterEach(async () => {
    await act(async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
    });
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
