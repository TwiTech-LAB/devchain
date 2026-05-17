/**
 * Unit tests for PagedSessionMessageList WS-delta-driven index extension (4c.1).
 *
 * Layer: UI component unit — cheapest layer that proves the WS delta → index cache
 * extension behavior without requiring full backend integration.
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PagedSessionMessageList } from './PagedSessionMessageList';
import { transcriptQueryKeys } from '@/ui/hooks/useSessionTranscript';
import type { SerializedChunk } from '@/ui/hooks/useSessionTranscript';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import type { WsEnvelope } from '@/ui/lib/socket';
import type { TranscriptIndex } from '@/ui/lib/sessions';

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
    totals: { messageCount: 3, chunkCount: 3 },
    chunkIds: ['chunk-0', 'chunk-1', 'chunk-2'],
    latestOutputPreview: null,
    providerName: 'claude',
    isOngoing: true,
    ...overrides,
  };
}

function makeChunk(id: string): SerializedChunk {
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
  } as SerializedChunk;
}

const DummyChunkRenderer = () => <div data-testid="chunk" />;

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
