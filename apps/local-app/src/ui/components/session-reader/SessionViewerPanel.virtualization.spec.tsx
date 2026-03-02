import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { SerializedMessage } from '@/ui/hooks/useSessionTranscript';
import { SessionViewerPanel } from './SessionViewerPanel';

const measureMock = jest.fn();
const useVirtualizerMock = jest.fn();

jest.mock('@/ui/hooks/useAutoScrollBottom', () => ({
  useAutoScrollBottom: jest.fn(() => ({
    scrollContainerRef: { current: null },
    bottomRef: { current: null },
    handleScroll: jest.fn(),
  })),
}));

jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (...args: unknown[]) => useVirtualizerMock(...args),
}));

function makeMessage(overrides: Partial<SerializedMessage> = {}): SerializedMessage {
  return {
    id: 'msg-1',
    parentId: null,
    role: 'assistant',
    timestamp: '2026-02-24T12:00:00.000Z',
    content: [{ type: 'text', text: 'hello' }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

const originalRequestAnimationFrame = global.requestAnimationFrame;

describe('SessionViewerPanel virtualization behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useVirtualizerMock.mockImplementation(() => ({
      getVirtualItems: () => [{ index: 0, start: 0, size: 120 }],
      getTotalSize: () => 120,
      measureElement: jest.fn(),
      measure: measureMock,
    }));
    global.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
  });

  afterAll(() => {
    if (originalRequestAnimationFrame) {
      global.requestAnimationFrame = originalRequestAnimationFrame;
      return;
    }
    delete (global as { requestAnimationFrame?: typeof requestAnimationFrame })
      .requestAnimationFrame;
  });

  it('does not call measure() on collapsible toggles (ResizeObserver handles re-measurement)', () => {
    const messages = [
      makeMessage({
        content: [
          { type: 'thinking', thinking: 'private chain-of-thought' },
          { type: 'text', text: 'final answer' },
        ],
      }),
    ];

    render(
      <SessionViewerPanel
        messages={messages}
        chunks={[]}
        metrics={undefined}
        isLive={true}
        isLoading={false}
        error={null}
      />,
    );

    fireEvent.click(screen.getByText('Thinking'));
    expect(measureMock).not.toHaveBeenCalled();
  });

  it('uses stable message ids as virtualization keys across updates', () => {
    const initialMessages = [
      makeMessage({ id: 'msg-1', role: 'user', content: [{ type: 'text', text: 'one' }] }),
      makeMessage({ id: 'msg-2', role: 'assistant', content: [{ type: 'text', text: 'two' }] }),
    ];

    const { rerender } = render(
      <SessionViewerPanel
        messages={initialMessages}
        chunks={[]}
        metrics={undefined}
        isLive={false}
        isLoading={false}
        error={null}
      />,
    );

    const initialOptions = useVirtualizerMock.mock.calls[0][0] as {
      getItemKey: (index: number) => string;
    };
    expect(initialOptions.getItemKey(0)).toBe('msg-1');
    expect(initialOptions.getItemKey(1)).toBe('msg-2');

    const updatedMessages = [
      ...initialMessages,
      makeMessage({ id: 'msg-3', role: 'assistant', content: [{ type: 'text', text: 'three' }] }),
    ];

    rerender(
      <SessionViewerPanel
        messages={updatedMessages}
        chunks={[]}
        metrics={undefined}
        isLive={false}
        isLoading={false}
        error={null}
      />,
    );

    const lastCallIndex = useVirtualizerMock.mock.calls.length - 1;
    const updatedOptions = useVirtualizerMock.mock.calls[lastCallIndex][0] as {
      getItemKey: (index: number) => string;
    };

    expect(updatedOptions.getItemKey(0)).toBe('msg-1');
    expect(updatedOptions.getItemKey(1)).toBe('msg-2');
    expect(updatedOptions.getItemKey(2)).toBe('msg-3');
  });

  it('does not call measure() on AIGroup expand (ResizeObserver handles re-measurement)', () => {
    const chunks = [
      {
        id: 'chunk-ai-1',
        type: 'ai' as const,
        startTime: '2026-02-24T12:00:00.000Z',
        endTime: '2026-02-24T12:00:02.000Z',
        messages: [
          makeMessage({
            id: 'msg-ai',
            role: 'assistant',
            content: [{ type: 'text', text: 'Chunk output' }],
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
            id: 'step-output',
            type: 'output' as const,
            startTime: '2026-02-24T12:00:01.000Z',
            durationMs: 0,
            content: { outputText: 'Chunk output' },
            context: 'main' as const,
          },
        ],
        turns: [],
      },
    ];

    render(
      <SessionViewerPanel
        messages={[
          makeMessage({
            id: 'm-flat',
            role: 'assistant',
            content: [{ type: 'text', text: 'flat' }],
          }),
        ]}
        chunks={chunks}
        metrics={undefined}
        isLive={false}
        isLoading={false}
        error={null}
      />,
    );

    fireEvent.click(screen.getByTestId('ai-group-header'));
    expect(measureMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Focus mode navigation — measure/scroll ordering & prev thinking
  // -------------------------------------------------------------------------

  describe('focus mode navigation', () => {
    const mockScrollToIndex = jest.fn();
    let mockScrollOffset = 0;

    function makeAiChunk(id: string) {
      return {
        id,
        type: 'ai' as const,
        startTime: '2026-02-24T12:00:00.000Z',
        endTime: '2026-02-24T12:00:01.000Z',
        messages: [
          makeMessage({
            id: `${id}-msg`,
            role: 'assistant',
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
            type: 'thinking' as const,
            startTime: '2026-02-24T12:00:00.000Z',
            durationMs: 0,
            content: { thinkingText: 'Analyzing' },
            context: 'main' as const,
          },
          {
            id: `${id}-output`,
            type: 'output' as const,
            startTime: '2026-02-24T12:00:01.000Z',
            durationMs: 0,
            content: { outputText: `Output from ${id}` },
            context: 'main' as const,
          },
        ],
        turns: [],
      };
    }

    function makeUserChunk(id: string) {
      return {
        id,
        type: 'user' as const,
        startTime: '2026-02-24T12:00:00.000Z',
        endTime: '2026-02-24T12:00:01.000Z',
        messages: [
          makeMessage({
            id: `${id}-msg`,
            role: 'user',
            content: [{ type: 'text', text: `User ${id}` }],
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

    const focusChunks = [
      makeAiChunk('chunk-ai-0'),
      makeUserChunk('user-1'),
      makeAiChunk('chunk-ai-2'),
      makeUserChunk('user-3'),
      makeAiChunk('chunk-ai-4'),
    ];

    const focusBaseProps = {
      messages: [
        makeMessage({ id: 'm-flat', role: 'user', content: [{ type: 'text', text: 'flat' }] }),
      ],
      metrics: undefined,
      isLive: false,
      isLoading: false,
      error: null,
    };

    beforeEach(() => {
      mockScrollOffset = 0;
      mockScrollToIndex.mockClear();
      measureMock.mockClear();
      const items = Array.from({ length: 5 }, (_, i) => ({
        index: i,
        start: i * 120,
        size: 120,
        end: (i + 1) * 120,
        key: `chunk-key-${i}`,
        lane: 0,
      }));
      useVirtualizerMock.mockImplementation(() => ({
        getVirtualItems: () => items,
        getTotalSize: () => 5 * 120,
        measureElement: jest.fn(),
        measure: measureMock,
        scrollToIndex: mockScrollToIndex,
        get scrollOffset() {
          return mockScrollOffset;
        },
      }));
    });

    it('does not call measure() during focus navigation (deferred scroll only)', () => {
      render(<SessionViewerPanel {...focusBaseProps} chunks={focusChunks} />);

      const region = screen.getByRole('region', { name: 'Session viewer' });
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });

      // measure() must NOT be called — ResizeObserver handles height updates
      expect(measureMock).not.toHaveBeenCalled();
      // scrollToIndex called via deferred useEffect + rAF (index 2 = next thinking after 0)
      expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
    });

    it('scrolls to correct forward chunk after focus-mode collapse', () => {
      // scrollOffset=360 → visible index = 3 (user-3)
      // thinkingChunkIndexes = [0,2,4], findAdjacentIndex([0,2,4], 3, 'next') → 4
      mockScrollOffset = 360;

      render(<SessionViewerPanel {...focusBaseProps} chunks={focusChunks} />);

      const region = screen.getByRole('region', { name: 'Session viewer' });
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });

      expect(mockScrollToIndex).toHaveBeenCalledWith(4, { align: 'start' });
    });

    it('"prev thinking" collapses previous target and expands new target — exactly one expanded', () => {
      render(<SessionViewerPanel {...focusBaseProps} chunks={focusChunks} />);

      // Manually expand chunk-ai-4
      const headers = screen.getAllByTestId('ai-group-header');
      fireEvent.click(headers[2]);
      expect(screen.queryAllByTestId('semantic-step-list')).toHaveLength(1);

      // Scroll past chunk-ai-4 so prev thinking from visible finds it
      mockScrollOffset = 480;

      const region = screen.getByRole('region', { name: 'Session viewer' });
      fireEvent.keyDown(region, { key: 'ArrowUp', altKey: true });

      // Should navigate to chunk-ai-2 (prev thinking from visible index 4)
      expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });

      // chunk-ai-4 collapsed, chunk-ai-2 expanded — exactly one
      const cards = screen.getAllByTestId('ai-group-card');
      expect(screen.queryAllByTestId('semantic-step-list')).toHaveLength(1);
      expect(within(cards[1]).queryByTestId('semantic-step-list')).not.toBeNull();
      expect(within(cards[2]).queryByTestId('semantic-step-list')).toBeNull();
    });

    it('repeated Alt+↓ targets monotonically increasing thinking chunks (non-uniform heights)', () => {
      const extendedChunks = [
        makeAiChunk('chunk-ai-0'),
        makeUserChunk('user-1'),
        makeAiChunk('chunk-ai-2'),
        makeUserChunk('user-3'),
        makeAiChunk('chunk-ai-4'),
        makeUserChunk('user-5'),
        makeAiChunk('chunk-ai-6'),
      ];

      function computeVirtualItems(heights: number[]) {
        let start = 0;
        return heights.map((h, i) => {
          const item = {
            index: i,
            start,
            size: h,
            end: start + h,
            key: `chunk-key-${i}`,
            lane: 0,
          };
          start += h;
          return item;
        });
      }

      // Non-uniform: expanded AI = 500px, collapsed AI = 120px, user = 80px
      // Initial: all collapsed
      let items = computeVirtualItems([120, 80, 120, 80, 120, 80, 120]);

      useVirtualizerMock.mockImplementation(() => ({
        getVirtualItems: () => items,
        getTotalSize: () => (items.length > 0 ? items[items.length - 1].end : 0),
        measureElement: jest.fn(),
        measure: measureMock,
        scrollToIndex: mockScrollToIndex,
        get scrollOffset() {
          return mockScrollOffset;
        },
      }));

      render(<SessionViewerPanel {...focusBaseProps} chunks={extendedChunks} />);

      const region = screen.getByRole('region', { name: 'Session viewer' });

      // Jump 1: scrollOffset=0 → visible=0 → next thinking = 2
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
      expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
      mockScrollToIndex.mockClear();

      // Simulate scroll completing: chunk-ai-2 expanded (500px), rest collapsed
      items = computeVirtualItems([120, 80, 500, 80, 120, 80, 120]);
      mockScrollOffset = 200; // start of chunk-ai-2

      // Jump 2: visible=2 → next thinking = 4
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
      expect(mockScrollToIndex).toHaveBeenCalledWith(4, { align: 'start' });
      mockScrollToIndex.mockClear();

      // Simulate scroll completing: chunk-ai-4 expanded (500px), rest collapsed
      items = computeVirtualItems([120, 80, 120, 80, 500, 80, 120]);
      mockScrollOffset = 400; // start of chunk-ai-4

      // Jump 3: visible=4 → next thinking = 6
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
      expect(mockScrollToIndex).toHaveBeenCalledWith(6, { align: 'start' });

      // measure() NEVER called during any navigation
      expect(measureMock).not.toHaveBeenCalled();
    });

    it('advances past last nav target on repeated next-thinking (nav baseline tracking)', () => {
      render(<SessionViewerPanel {...focusBaseProps} chunks={focusChunks} />);

      const region = screen.getByRole('region', { name: 'Session viewer' });

      // Jump 1: navigate to chunk-ai-2 (scrollOffset=0, visible=0, next=2)
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
      expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
      mockScrollToIndex.mockClear();

      // Simulate: user scrolls back to before chunk-ai-2
      mockScrollOffset = 120; // at user-1 (index 1)

      // Jump 2: nav baseline is chunk-ai-2 (last target), next thinking after 2 = 4
      // Even though scrollOffset puts visible at index 1, the ref-based baseline
      // correctly advances past the previous target
      fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
      expect(mockScrollToIndex).toHaveBeenCalledWith(4, { align: 'start' });
    });

    describe('navigation baseline regression', () => {
      const extendedChunks = [
        makeAiChunk('chunk-ai-0'),
        makeUserChunk('user-1'),
        makeAiChunk('chunk-ai-2'),
        makeUserChunk('user-3'),
        makeAiChunk('chunk-ai-4'),
        makeUserChunk('user-5'),
        makeAiChunk('chunk-ai-6'),
      ];

      function use7ItemMock() {
        const items = Array.from({ length: 7 }, (_, i) => ({
          index: i,
          start: i * 120,
          size: 120,
          end: (i + 1) * 120,
          key: `chunk-key-${i}`,
          lane: 0,
        }));
        useVirtualizerMock.mockImplementation(() => ({
          getVirtualItems: () => items,
          getTotalSize: () => 7 * 120,
          measureElement: jest.fn(),
          measure: measureMock,
          scrollToIndex: mockScrollToIndex,
          get scrollOffset() {
            return mockScrollOffset;
          },
        }));
      }

      it('sequential thinking navigation advances despite stale scrollOffset (3 jumps)', () => {
        use7ItemMock();
        render(<SessionViewerPanel {...focusBaseProps} chunks={extendedChunks} />);
        const region = screen.getByRole('region', { name: 'Session viewer' });

        // Jump 1: visible=0, next thinking=2
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
        mockScrollToIndex.mockClear();

        // Simulate overshoot — getCurrentVisibleIndex fallback would return 6 (last item)
        mockScrollOffset = 9999;

        // Jump 2: ref='chunk-ai-2' → baseline=2, next thinking=4
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(4, { align: 'start' });
        mockScrollToIndex.mockClear();

        // Jump 3: ref='chunk-ai-4' → baseline=4, next thinking=6
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(6, { align: 'start' });
      });

      it('response navigation works after thinking navigation with stale scrollOffset', () => {
        use7ItemMock();
        render(<SessionViewerPanel {...focusBaseProps} chunks={extendedChunks} />);
        const region = screen.getByRole('region', { name: 'Session viewer' });

        // Thinking nav → chunk-ai-2
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
        mockScrollToIndex.mockClear();

        // Stale scrollOffset (overshoot)
        mockScrollOffset = 9999;

        // Response nav (Alt+Shift+↓) → baseline from ref=2, next response=4
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true, shiftKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(4, { align: 'start' });
      });

      it('cross-type navigation resolves baseline from last nav target', () => {
        use7ItemMock();
        render(<SessionViewerPanel {...focusBaseProps} chunks={extendedChunks} />);
        const region = screen.getByRole('region', { name: 'Session viewer' });

        // Thinking → chunk-ai-2
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
        mockScrollToIndex.mockClear();

        mockScrollOffset = 9999;

        // Response → chunk-ai-4 (baseline from ref=2, next response after 2=4)
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true, shiftKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(4, { align: 'start' });
        mockScrollToIndex.mockClear();

        // Thinking → chunk-ai-6 (baseline from ref=4, next thinking after 4=6)
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(6, { align: 'start' });
      });

      it('displayChunks churn clears stale ref (falls back to viewport)', () => {
        use7ItemMock();
        const { rerender } = render(
          <SessionViewerPanel {...focusBaseProps} chunks={extendedChunks} />,
        );
        const region = screen.getByRole('region', { name: 'Session viewer' });

        // Navigate to chunk-ai-6 via 3 thinking jumps
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true }); // → 2
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true }); // → 4
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true }); // → 6
        mockScrollToIndex.mockClear();

        // Rerender with focusChunks (5 items — chunk-ai-6 absent)
        const items5 = Array.from({ length: 5 }, (_, i) => ({
          index: i,
          start: i * 120,
          size: 120,
          end: (i + 1) * 120,
          key: `chunk-key-${i}`,
          lane: 0,
        }));
        useVirtualizerMock.mockImplementation(() => ({
          getVirtualItems: () => items5,
          getTotalSize: () => 5 * 120,
          measureElement: jest.fn(),
          measure: measureMock,
          scrollToIndex: mockScrollToIndex,
          get scrollOffset() {
            return mockScrollOffset;
          },
        }));
        mockScrollOffset = 0;

        rerender(<SessionViewerPanel {...focusBaseProps} chunks={focusChunks} />);

        // Navigate → ref self-clears ('chunk-ai-6' not in focusChunks)
        // Falls back to getCurrentVisibleIndex (scrollOffset=0 → visible=0, next thinking=2)
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
      });

      it('manual scroll clears nav ref (next navigation uses viewport baseline)', () => {
        render(<SessionViewerPanel {...focusBaseProps} chunks={focusChunks} />);
        const region = screen.getByRole('region', { name: 'Session viewer' });

        // Navigate to chunk-ai-2
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
        mockScrollToIndex.mockClear();

        // Manual scroll — clears nav ref (token is 0 after sync rAF cleared it)
        const scrollContainer = screen.getByTestId('session-viewer-scroll');
        fireEvent.scroll(scrollContainer);

        // Navigate with scrollOffset=0 → viewport baseline (visible=0, next=2)
        // NOT 4 (which would happen if ref 'chunk-ai-2' was still set)
        mockScrollOffset = 0;
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
        expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
      });
    });

    describe('double-rAF timing regression', () => {
      let rafQueue: Array<{ id: number; cb: FrameRequestCallback }>;
      let rafNextId: number;
      const originalCaf = global.cancelAnimationFrame;

      function flushOneFrame() {
        const pending = rafQueue.splice(0, rafQueue.length);
        for (const { cb } of pending) {
          cb(0);
        }
      }

      beforeEach(() => {
        rafQueue = [];
        rafNextId = 1;

        global.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
          const id = rafNextId++;
          rafQueue.push({ id, cb });
          return id;
        }) as typeof requestAnimationFrame;

        global.cancelAnimationFrame = ((id: number): void => {
          const idx = rafQueue.findIndex((e) => e.id === id);
          if (idx !== -1) rafQueue.splice(idx, 1);
        }) as typeof cancelAnimationFrame;
      });

      afterAll(() => {
        global.cancelAnimationFrame = originalCaf;
      });

      it('scrollToIndex fires only after second rAF frame (not first)', () => {
        render(<SessionViewerPanel {...focusBaseProps} chunks={focusChunks} />);
        const region = screen.getByRole('region', { name: 'Session viewer' });

        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });

        // Frame 1: outer rAF fires, queues inner rAF — scrollToIndex NOT yet called
        flushOneFrame();
        expect(mockScrollToIndex).not.toHaveBeenCalled();

        // Frame 2: inner rAF fires — scrollToIndex called with correct index
        flushOneFrame();
        expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'start' });
      });

      it('rapid navigation cancels earlier scroll (only last target fires)', () => {
        render(<SessionViewerPanel {...focusBaseProps} chunks={focusChunks} />);
        const region = screen.getByRole('region', { name: 'Session viewer' });

        // First Alt+↓: targets chunk-ai-2 (visible=0, next thinking=2)
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });

        // Before any rAF fires, change scroll offset and navigate again
        mockScrollOffset = 360; // visible=3, next thinking=4
        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });

        // Flush two frames for the surviving navigation's double-rAF
        flushOneFrame();
        flushOneFrame();

        // Only chunk-ai-4 scrolls — chunk-ai-2's rAF was cancelled by effect cleanup
        expect(mockScrollToIndex).toHaveBeenCalledTimes(1);
        expect(mockScrollToIndex).toHaveBeenCalledWith(4, { align: 'start' });
      });

      it('effect cleanup cancels rAF handles on unmount (no leaked callbacks)', () => {
        const { unmount } = render(<SessionViewerPanel {...focusBaseProps} chunks={focusChunks} />);
        const region = screen.getByRole('region', { name: 'Session viewer' });

        fireEvent.keyDown(region, { key: 'ArrowDown', altKey: true });
        expect(rafQueue.length).toBeGreaterThan(0);

        unmount();
        expect(rafQueue).toHaveLength(0);

        // Flushing after cleanup is safe — no callbacks to fire
        expect(() => flushOneFrame()).not.toThrow();
        expect(mockScrollToIndex).not.toHaveBeenCalled();
      });
    });
  });
});
