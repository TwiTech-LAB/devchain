/**
 * Paged-only transcript regression tests.
 *
 * Layer: Component integration (render the production panel with the network
 * boundary mocked, localStorage controlled). Why this layer: proves the web UI
 * renders transcripts exclusively through the paged pipeline and never issues
 * a full-transcript request — including when a leftover browser localStorage
 * key `devchain.pagedTranscript='false'` from the removed rollback flag is
 * still set.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionViewerPanel } from '@/ui/components/session-reader/SessionViewerPanel';
import { SessionReadSlideOver } from '../SessionReadSlideOver';
import { useSessionTranscript } from '@/ui/hooks/useSessionTranscript';
import { fetchTranscriptIndex } from '@/ui/lib/sessions';
import type { TranscriptIndex } from '@/ui/lib/sessions';

jest.mock('@/ui/hooks/useSessionTranscript', () => ({
  ...jest.requireActual('@/ui/hooks/useSessionTranscript'),
  useSessionTranscript: jest.fn(),
}));

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchTranscriptIndex: jest.fn(),
  fetchTranscriptChunks: jest.fn(),
}));

jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: jest.fn((options: { count: number }) => ({
    getVirtualItems: () => {
      if (options.count === 0) return [];
      return Array.from({ length: Math.min(options.count, 3) }, (_, offset) => ({
        index: offset,
        start: offset * 120,
        size: 120,
        key: offset,
        lane: 0,
        end: 120,
      }));
    },
    getTotalSize: () => options.count * 120,
    measureElement: jest.fn(),
    isScrolling: false,
  })),
}));

jest.mock('@/ui/hooks/useAutoScrollBottom', () => ({
  useAutoScrollBottom: () => ({
    scrollContainerRef: { current: null },
    bottomRef: { current: null },
    handleScroll: jest.fn(),
  }),
}));

jest.mock('@/ui/components/session-reader/SessionNavigationToolbar', () => ({
  SessionNavigationToolbar: () => null,
}));

const mockUseSessionTranscript = useSessionTranscript as jest.MockedFunction<
  typeof useSessionTranscript
>;
const fetchTranscriptIndexMock = fetchTranscriptIndex as jest.MockedFunction<
  typeof fetchTranscriptIndex
>;

const fetchGuard = jest.fn();

function makeCombinedIndex(): TranscriptIndex {
  const chunkIds = ['chunk-0', 'chunk-1'];
  return {
    cursor: 'index-cursor',
    totals: { messageCount: 2, chunkCount: chunkIds.length },
    chunkIds,
    latestOutputPreview: null,
    providerName: 'claude',
    isOngoing: true,
    pages: [
      {
        cursor: chunkIds[0],
        size: chunkIds.length,
        response: {
          chunks: chunkIds.map((id) => ({
            id,
            type: 'user' as const,
            startTime: '2026-01-01T10:00:00.000Z',
            endTime: '2026-01-01T10:00:01.000Z',
            messages: [
              {
                id: `${id}-msg`,
                parentId: null,
                role: 'user' as const,
                timestamp: '2026-01-01T10:00:00.000Z',
                content: [{ type: 'text' as const, text: `Hello from ${id}` }],
                toolCalls: [],
                toolResults: [],
                isMeta: false,
                isSidechain: false,
              },
            ],
            metrics: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              totalTokens: 0,
              messageCount: 1,
              durationMs: 0,
              costUsd: 0,
            },
          })),
          nextCursor: null,
          prevCursor: null,
          totalCount: chunkIds.length,
        },
      },
    ],
  };
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <SessionViewerPanel sessionId="session-1" isLive={false} />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  fetchTranscriptIndexMock.mockResolvedValue(makeCombinedIndex());
  global.fetch = fetchGuard as unknown as typeof fetch;
});

afterEach(() => {
  localStorage.clear();
});

describe('Paged-only transcript regression (SessionViewerPanel)', () => {
  it.each([
    ['no localStorage key (fresh browser)', undefined],
    ["localStorage 'devchain.pagedTranscript=true'", 'true'],
    ["leftover localStorage 'devchain.pagedTranscript=false'", 'false'],
  ])('renders the paged pipeline with %s', async (_label, storedValue) => {
    if (storedValue !== undefined) {
      localStorage.setItem('devchain.pagedTranscript', storedValue);
    }

    renderPanel();

    expect(await screen.findByTestId('session-viewer-panel-paged')).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchTranscriptIndexMock).toHaveBeenCalledWith(
        'session-1',
        expect.any(Function),
        expect.objectContaining({ pageSize: expect.any(Number) }),
      );
    });
    expect(await screen.findByText('Hello from chunk-0')).toBeInTheDocument();

    // The full-transcript route must never be called.
    expect(fetchGuard).not.toHaveBeenCalled();
  });
});

describe('Paged-only transcript regression (SessionReadSlideOver)', () => {
  it('uses the summary-only hook regardless of a leftover rollback key', () => {
    mockUseSessionTranscript.mockReturnValue({
      metrics: undefined,
      isLive: false,
      refetch: jest.fn(),
    });
    localStorage.setItem('devchain.pagedTranscript', 'false');

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionReadSlideOver sessionId="session-1" onClose={jest.fn()} />
      </QueryClientProvider>,
    );

    // Called with sessionId only — no transcript-enable option exists anymore.
    expect(mockUseSessionTranscript).toHaveBeenCalledTimes(1);
    expect(mockUseSessionTranscript.mock.calls[0]).toHaveLength(1);
  });
});
