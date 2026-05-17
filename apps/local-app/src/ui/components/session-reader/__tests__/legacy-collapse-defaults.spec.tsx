/**
 * Legacy fallback components (ThinkingBlock, ToolCallBlock) are private functions
 * inside SessionViewerPanel.tsx. We test them by rendering SessionViewerPanel
 * with messages that trigger the legacy fallback path (no chunks / no semanticSteps)
 * and asserting collapse defaults via DOM queries.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import type { SerializedMessage, SerializedChunk } from '@/ui/hooks/useSessionTranscript';
import { SessionViewerPanel } from '../SessionViewerPanel';

// Legacy mode: explicitly mock paged flag to false (legacy full-transcript path)
jest.mock('@/ui/hooks/usePagedTranscript', () => ({
  usePagedTranscriptFlag: () => [false, jest.fn()],
  isPagedTranscriptEnabled: () => false,
}));

jest.mock('@/ui/components/shared/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

jest.mock('../SessionMetricsHeader', () => ({
  SessionMetricsHeader: () => <div data-testid="session-metrics-header" />,
}));

jest.mock('../SessionNavigationToolbar', () => ({
  SessionNavigationToolbar: () => <div data-testid="session-navigation-toolbar" />,
}));

jest.mock('../AIGroupCard', () => ({
  AIGroupCard: () => <div data-testid="ai-group-card" />,
}));

jest.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 120,
        size: 120,
        key: `item-${index}`,
      })),
    getTotalSize: () => count * 120,
    scrollToIndex: jest.fn(),
    scrollOffset: 0,
    measureElement: jest.fn(),
  }),
}));

function makeMessage(overrides: Partial<SerializedMessage> = {}): SerializedMessage {
  return {
    id: 'msg-1',
    parentId: null,
    role: 'assistant',
    timestamp: '2026-02-24T12:00:00.000Z',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text: 'AI response' }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

describe('Legacy fallback — collapse defaults (devchain.pagedTranscript=false, via SessionViewerPanel)', () => {
  const baseProps = {
    sessionId: 'session-1',
    isLive: false,
    isLoading: false,
    error: null,
    warnings: [],
  };

  it('legacy ThinkingBlock starts collapsed', () => {
    const messages: SerializedMessage[] = [
      makeMessage({
        id: 'msg-thinking',
        content: [{ type: 'thinking', thinking: 'Deep reasoning here' }],
      }),
    ];

    render(
      <SessionViewerPanel {...baseProps} messages={messages} chunks={[] as SerializedChunk[]} />,
    );

    // The legacy ThinkingBlock trigger should have data-state=closed
    const thinkingTrigger = screen.getByText('Thinking').closest('button');
    expect(thinkingTrigger).toHaveAttribute('data-state', 'closed');
  });

  it('legacy ToolCallBlock starts collapsed', () => {
    const messages: SerializedMessage[] = [
      makeMessage({
        id: 'msg-toolcall',
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
      }),
    ];

    render(
      <SessionViewerPanel {...baseProps} messages={messages} chunks={[] as SerializedChunk[]} />,
    );

    // The legacy ToolCallBlock trigger should have data-state=closed
    const toolTrigger = screen.getByText('Read').closest('button');
    expect(toolTrigger).toHaveAttribute('data-state', 'closed');
  });

  it('legacy ThinkingBlock expands on trigger click', () => {
    const messages: SerializedMessage[] = [
      makeMessage({
        id: 'msg-thinking-2',
        content: [{ type: 'thinking', thinking: 'Some reasoning' }],
      }),
    ];

    render(
      <SessionViewerPanel {...baseProps} messages={messages} chunks={[] as SerializedChunk[]} />,
    );

    const thinkingTrigger = screen.getByText('Thinking').closest('button')!;
    fireEvent.click(thinkingTrigger);
    expect(thinkingTrigger).toHaveAttribute('data-state', 'open');
  });

  it('legacy ToolCallBlock expands on trigger click', () => {
    const messages: SerializedMessage[] = [
      makeMessage({
        id: 'msg-toolcall-2',
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
      }),
    ];

    render(
      <SessionViewerPanel {...baseProps} messages={messages} chunks={[] as SerializedChunk[]} />,
    );

    const toolTrigger = screen.getByText('Write').closest('button')!;
    fireEvent.click(toolTrigger);
    expect(toolTrigger).toHaveAttribute('data-state', 'open');
  });
});
