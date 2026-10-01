/**
 * Fallback card components (ThinkingBlock, ToolCallBlock) are private functions
 * inside SessionViewerPanel.tsx. They render when a chunk carries messages but
 * no semanticSteps. We exercise them through the paged pipeline (index + chunk
 * pages) and assert collapse defaults via DOM queries.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SerializedChunk } from '@/ui/hooks/useSessionTranscript';
import { SessionViewerPanel } from '../SessionViewerPanel';
import { fetchTranscriptIndex } from '@/ui/lib/sessions';
import type { TranscriptIndex } from '@/ui/lib/sessions';

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
      return Array.from({ length: options.count }, (_, index) => ({
        index,
        start: index * 120,
        size: 120,
        key: index,
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

jest.mock('../SessionNavigationToolbar', () => ({
  SessionNavigationToolbar: () => null,
}));

const fetchTranscriptIndexMock = fetchTranscriptIndex as jest.MockedFunction<
  typeof fetchTranscriptIndex
>;

function makeFallbackChunk(
  chunkId: string,
  overrides: Partial<SerializedChunk> = {},
): SerializedChunk {
  return {
    id: chunkId,
    type: 'ai',
    startTime: '2026-02-24T12:00:00.000Z',
    endTime: '2026-02-24T12:00:01.000Z',
    messages: [
      {
        id: `${chunkId}-msg`,
        parentId: null,
        role: 'assistant',
        timestamp: '2026-02-24T12:00:00.000Z',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'AI response' }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
      },
    ],
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 150,
      messageCount: 1,
      durationMs: 1000,
      costUsd: 0.001,
    },
    ...overrides,
    // Deliberately no semanticSteps: forces the message-card fallback renderer.
    semanticSteps: undefined,
  } as SerializedChunk;
}

function makeIndexFor(chunks: SerializedChunk[]): TranscriptIndex {
  return {
    cursor: 'index-cursor',
    totals: { messageCount: chunks.length, chunkCount: chunks.length },
    chunkIds: chunks.map((chunk) => chunk.id),
    latestOutputPreview: null,
    providerName: 'claude-code',
    isOngoing: false,
    pages: [
      {
        cursor: chunks[0].id,
        size: chunks.length,
        response: {
          chunks,
          nextCursor: null,
          prevCursor: null,
          totalCount: chunks.length,
        },
      },
    ],
  };
}

function renderPanelWithChunks(chunks: SerializedChunk[]) {
  fetchTranscriptIndexMock.mockResolvedValue(makeIndexFor(chunks));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionViewerPanel sessionId="session-1" isLive={false} />
    </QueryClientProvider>,
  );
}

describe('Fallback cards — collapse defaults (chunk without semanticSteps, via paged panel)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('fallback ThinkingBlock starts collapsed', async () => {
    renderPanelWithChunks([
      makeFallbackChunk('chunk-thinking', {
        messages: [
          {
            id: 'msg-thinking',
            parentId: null,
            role: 'assistant',
            timestamp: '2026-02-24T12:00:00.000Z',
            content: [{ type: 'thinking', thinking: 'Deep reasoning here' }],
            toolCalls: [],
            toolResults: [],
            isMeta: false,
            isSidechain: false,
          },
        ],
      }),
    ]);

    await waitFor(() => {
      expect(screen.getByText('Thinking')).toBeInTheDocument();
    });

    const thinkingTrigger = screen.getByText('Thinking').closest('button');
    expect(thinkingTrigger).toHaveAttribute('data-state', 'closed');
  });

  it('fallback ToolCallBlock starts collapsed', async () => {
    renderPanelWithChunks([
      makeFallbackChunk('chunk-toolcall', {
        messages: [
          {
            id: 'msg-toolcall',
            parentId: null,
            role: 'assistant',
            timestamp: '2026-02-24T12:00:00.000Z',
            content: [{ type: 'text', text: 'Using tools' }],
            toolCalls: [
              {
                id: 'tc-1',
                name: 'Read',
                input: { file_path: '/foo.ts' },
                isTask: false,
              },
            ],
            toolResults: [],
            isMeta: false,
            isSidechain: false,
          },
        ],
      }),
    ]);

    await waitFor(() => {
      expect(screen.getByText('Read')).toBeInTheDocument();
    });

    const toolTrigger = screen.getByText('Read').closest('button');
    expect(toolTrigger).toHaveAttribute('data-state', 'closed');
  });

  it('fallback ThinkingBlock expands on trigger click', async () => {
    renderPanelWithChunks([
      makeFallbackChunk('chunk-thinking-2', {
        messages: [
          {
            id: 'msg-thinking-2',
            parentId: null,
            role: 'assistant',
            timestamp: '2026-02-24T12:00:00.000Z',
            content: [{ type: 'thinking', thinking: 'Some reasoning' }],
            toolCalls: [],
            toolResults: [],
            isMeta: false,
            isSidechain: false,
          },
        ],
      }),
    ]);

    const thinkingTrigger = (await screen.findByText('Thinking')).closest('button')!;
    fireEvent.click(thinkingTrigger);
    expect(thinkingTrigger).toHaveAttribute('data-state', 'open');
  });

  it('fallback ToolCallBlock expands on trigger click', async () => {
    renderPanelWithChunks([
      makeFallbackChunk('chunk-toolcall-2', {
        messages: [
          {
            id: 'msg-toolcall-2',
            parentId: null,
            role: 'assistant',
            timestamp: '2026-02-24T12:00:00.000Z',
            content: [{ type: 'text', text: 'Using tools' }],
            toolCalls: [
              {
                id: 'tc-2',
                name: 'Write',
                input: { file_path: '/bar.ts' },
                isTask: false,
              },
            ],
            toolResults: [],
            isMeta: false,
            isSidechain: false,
          },
        ],
      }),
    ]);

    const toolTrigger = (await screen.findByText('Write')).closest('button')!;
    fireEvent.click(toolTrigger);
    expect(toolTrigger).toHaveAttribute('data-state', 'open');
  });
});
