/**
 * Regression tests: getCurrentVisibleIndex must anchor to the first VISIBLE
 * virtual item, not the first overscanned item returned by getVirtualItems().
 *
 * These tests mock @tanstack/react-virtual so we can control scrollOffset and
 * the virtual item list independently of JSDOM scroll limitations.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SerializedMessage, SerializedChunk } from '@/ui/hooks/useSessionTranscript';

// ---------------------------------------------------------------------------
// Mock @tanstack/react-virtual — must be defined before component import
// ---------------------------------------------------------------------------

const mockState = {
  scrollOffset: 0,
  scrollToIndex: jest.fn(),
};

jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (config: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () =>
      Array.from({ length: config.count }, (_, i) => ({
        index: i,
        start: i * 120,
        size: 120,
        end: (i + 1) * 120,
        key: config.getItemKey?.(i) ?? i,
        lane: 0,
      })),
    getTotalSize: () => config.count * 120,
    scrollToIndex: (...args: unknown[]) => mockState.scrollToIndex(...args),
    get scrollOffset() {
      return mockState.scrollOffset;
    },
    measureElement: () => {},
    measure: () => {},
  }),
}));

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchJsonOrThrow: jest.fn(),
}));

// Must import after mocks are defined (jest.mock is hoisted, but clarity matters)
import { SessionViewerPanel } from './SessionViewerPanel';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<SerializedMessage> = {}): SerializedMessage {
  return {
    id: 'msg-1',
    parentId: null,
    role: 'user',
    timestamp: '2026-02-24T12:00:00.000Z',
    content: [{ type: 'text', text: 'Hello' }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

function makeAiChunkWithThinking(id: string): SerializedChunk {
  return {
    id,
    type: 'ai',
    startTime: '2026-02-24T12:00:00.000Z',
    endTime: '2026-02-24T12:00:01.000Z',
    messages: [
      makeMessage({
        id: `${id}-msg`,
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: `Output from ${id}` }],
      }),
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
    semanticSteps: [
      {
        id: `${id}-thinking`,
        type: 'thinking',
        startTime: '2026-02-24T12:00:00.000Z',
        durationMs: 0,
        content: { thinkingText: 'Analyzing...' },
        context: 'main',
      },
      {
        id: `${id}-output`,
        type: 'output',
        startTime: '2026-02-24T12:00:01.000Z',
        durationMs: 0,
        content: { outputText: `Output from ${id}` },
        context: 'main',
      },
    ],
    turns: [],
  };
}

function makeUserChunk(id: string): SerializedChunk {
  return {
    id,
    type: 'user',
    startTime: '2026-02-24T12:00:00.000Z',
    endTime: '2026-02-24T12:00:01.000Z',
    messages: [
      makeMessage({
        id: `${id}-msg`,
        role: 'user',
        content: [{ type: 'text', text: `User message ${id}` }],
      }),
    ],
    metrics: {
      inputTokens: 50,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 50,
      messageCount: 1,
      durationMs: 500,
      costUsd: 0,
    },
  };
}

/**
 * 20 chunks where indices 3 and 15 are AI chunks with thinking steps.
 * All others are plain user chunks.
 *
 * With 120px estimated row height:
 *   index  0: start=   0, end= 120
 *   index  3: start= 360, end= 480  ← thinking chunk
 *   index  5: start= 600, end= 720
 *   index 15: start=1800, end=1920  ← thinking chunk
 *   index 16: start=1920, end=2040
 *
 * thinkingChunkIndexes = [3, 15]
 */
function build20Chunks(): SerializedChunk[] {
  return Array.from({ length: 20 }, (_, i) =>
    i === 3 || i === 15 ? makeAiChunkWithThinking(`chunk-${i}`) : makeUserChunk(`chunk-${i}`),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionViewerPanel – overscan navigation anchor regression', () => {
  const baseProps = {
    sessionId: 'session-overscan',
    messages: [makeMessage()],
    metrics: undefined,
    isLive: false,
    isLoading: false,
    error: null,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockState.scrollOffset = 0;
    mockState.scrollToIndex = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Flush the double-rAF used by navigateToChunk's single_focus mode. */
  function flushDoubleRaf() {
    jest.advanceTimersByTime(32);
  }

  it('Alt+↓ navigates to the next thinking chunk relative to visible position, not overscanned index 0', () => {
    const chunks = build20Chunks();

    // scrollOffset = 600 → first item where start+size > 600 is index 5 (720 > 600).
    // Items 0–4 are "overscanned" (off-screen above the viewport).
    // Old bug: getCurrentVisibleIndex() = items[0].index = 0
    //   → findAdjacentIndex([3,15], 0, 'next') = 3 (backward jump!)
    // Fix: getCurrentVisibleIndex() = 5
    //   → findAdjacentIndex([3,15], 5, 'next') = 15 (correct forward jump)
    mockState.scrollOffset = 600;

    render(<SessionViewerPanel {...baseProps} chunks={chunks} />);

    const region = screen.getByRole('region', { name: 'Session viewer' });
    fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });

    // Thinking nav uses single_focus mode which defers scrollToIndex via double-rAF
    flushDoubleRaf();

    expect(mockState.scrollToIndex).toHaveBeenCalledWith(15, { align: 'start' });
  });

  it('Alt+↑ navigates to the previous thinking chunk relative to visible position, not overscanned first item', () => {
    const chunks = build20Chunks();

    // scrollOffset = 1980 → first item where start+size > 1980 is index 16 (2040 > 1980).
    // Old bug: getCurrentVisibleIndex() = items[0].index = 0
    //   → findAdjacentIndex([3,15], 0, 'prev') = null (no-op — no thinking before 0)
    // Fix: getCurrentVisibleIndex() = 16
    //   → findAdjacentIndex([3,15], 16, 'prev') = 15 (correct backward jump)
    mockState.scrollOffset = 1980;

    render(<SessionViewerPanel {...baseProps} chunks={chunks} />);

    const region = screen.getByRole('region', { name: 'Session viewer' });
    fireEvent.keyDown(region, { key: 'ArrowUp', altKey: true });

    // Thinking nav uses single_focus mode which defers scrollToIndex via double-rAF
    flushDoubleRaf();

    expect(mockState.scrollToIndex).toHaveBeenCalledWith(15, { align: 'start' });
  });
});

// ---------------------------------------------------------------------------
// displayChunks consistency: count, getItemKey, and render source alignment
// ---------------------------------------------------------------------------

describe('SessionViewerPanel – displayChunks consistency after hotspot filter', () => {
  const baseProps = {
    sessionId: 'session-consistency',
    messages: [makeMessage()],
    metrics: undefined,
    isLive: false,
    isLoading: false,
    error: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockState.scrollOffset = 0;
    mockState.scrollToIndex = jest.fn();
  });

  /**
   * Build chunks that trigger hotspot detection.
   * 10 user/ai pairs where AI chunk at index 9 (last pair) is a token outlier.
   * Tokens: [100, 200, 300, 400, 500, 600, 700, 800, 900, 10000]
   * With enough spread that the last one (10000) exceeds the IQR upper fence.
   */
  function buildFilterableChunks(): SerializedChunk[] {
    const tokenValues = [100, 200, 300, 400, 500, 600, 700, 800, 900, 10000];
    const result: SerializedChunk[] = [];
    for (let i = 0; i < tokenValues.length; i++) {
      result.push(makeUserChunk(`user-${i}`));
      result.push({
        ...makeAiChunkWithThinking(`ai-${i}`),
        metrics: {
          inputTokens: tokenValues[i] * 0.6,
          outputTokens: tokenValues[i] * 0.4,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: tokenValues[i],
          messageCount: 1,
          durationMs: 1000,
          costUsd: 0.001,
        },
      });
    }
    return result;
  }

  it('virtualizer count matches displayChunks length after filtering', () => {
    const chunks = buildFilterableChunks();
    // 20 chunks total (10 user + 10 AI)
    expect(chunks).toHaveLength(20);

    render(
      <SessionViewerPanel
        {...baseProps}
        chunks={chunks}
        metrics={{
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          totalContextConsumption: 0,
          compactionCount: 0,
          phaseBreakdowns: [],
          visibleContextTokens: 0,
          totalContextTokens: 0,
          contextWindowTokens: 200_000,
          costUsd: 0,
          primaryModel: 'claude-sonnet-4-6',
          durationMs: 0,
          messageCount: 0,
          isOngoing: false,
        }}
      />,
    );

    // Before filter: all 20 chunks rendered (virtualizer sees 20)
    // The mock virtualizer renders ALL items (no viewport clipping)
    const allItems = screen.getAllByTestId(/^(ai-group-card|user-message-card)$/);
    expect(allItems.length).toBe(20);

    // Toggle hotspot filter
    fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));

    // After filter: only hot AI chunk (ai-9) + its preceding user (user-9) = 2 chunks
    const filteredItems = screen.getAllByTestId(/^(ai-group-card|user-message-card)$/);
    expect(filteredItems.length).toBe(2);
  });

  it('getItemKey returns correct chunk id after filtering', () => {
    const chunks = buildFilterableChunks();
    render(
      <SessionViewerPanel
        {...baseProps}
        chunks={chunks}
        metrics={{
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
          totalContextConsumption: 0,
          compactionCount: 0,
          phaseBreakdowns: [],
          visibleContextTokens: 0,
          totalContextTokens: 0,
          contextWindowTokens: 200_000,
          costUsd: 0,
          primaryModel: 'claude-sonnet-4-6',
          durationMs: 0,
          messageCount: 0,
          isOngoing: false,
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('nav-toggle-hotspot-filter'));

    // After filtering, the rendered items should use displayChunks[i].id as key.
    // The virtualizer mock sets key from getItemKey. Verify data-index values are
    // sequential (0, 1) — not original indices (18, 19).
    const rows = screen.getByTestId('session-viewer-scroll').querySelectorAll('[data-index]');
    const indices = Array.from(rows).map((row) => Number(row.getAttribute('data-index')));
    expect(indices).toEqual([0, 1]);
  });
});
