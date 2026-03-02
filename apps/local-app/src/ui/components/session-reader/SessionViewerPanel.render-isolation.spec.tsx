import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SerializedMessage, SerializedChunk } from '@/ui/hooks/useSessionTranscript';
import type { UnifiedMetrics } from '@/modules/session-reader/dtos/unified-session.types';
import { SessionViewerPanel } from './SessionViewerPanel';

const useAutoScrollBottomMock = jest.fn(() => ({
  scrollContainerRef: { current: null },
  bottomRef: { current: null },
  handleScroll: jest.fn(),
}));

jest.mock('@/ui/hooks/useAutoScrollBottom', () => ({
  useAutoScrollBottom: (...args: unknown[]) => useAutoScrollBottomMock(...args),
}));

function makeMetrics(overrides: Partial<UnifiedMetrics> = {}): UnifiedMetrics {
  return {
    inputTokens: 1200,
    outputTokens: 800,
    cacheReadTokens: 300,
    cacheCreationTokens: 100,
    totalTokens: 2400,
    totalContextConsumption: 500,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 50_000,
    totalContextTokens: 0,
    contextWindowTokens: 200_000,
    costUsd: 0.035,
    primaryModel: 'claude-sonnet-4-6',
    durationMs: 15_000,
    messageCount: 6,
    isOngoing: false,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<SerializedMessage> = {}): SerializedMessage {
  return {
    id: 'msg-1',
    parentId: null,
    role: 'assistant',
    timestamp: '2026-02-24T12:00:00.000Z',
    content: [{ type: 'text', text: 'Hello world' }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    ...overrides,
  };
}

describe('SessionViewerPanel render isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not rerun message-list auto-scroll hook when only metrics change', () => {
    const messages: SerializedMessage[] = [makeMessage()];
    const chunks: SerializedChunk[] = [];

    const { rerender } = render(
      <SessionViewerPanel
        messages={messages}
        chunks={chunks}
        metrics={makeMetrics({ totalTokens: 2400 })}
        isLive={true}
        isLoading={false}
        error={null}
      />,
    );

    const initialHookCalls = useAutoScrollBottomMock.mock.calls.length;
    expect(initialHookCalls).toBeGreaterThan(0);

    rerender(
      <SessionViewerPanel
        messages={messages}
        chunks={chunks}
        metrics={makeMetrics({ totalTokens: 3600 })}
        isLive={true}
        isLoading={false}
        error={null}
      />,
    );

    expect(useAutoScrollBottomMock).toHaveBeenCalledTimes(initialHookCalls);
  });

  it('passes live state + message count to auto-scroll hook for ongoing sessions', () => {
    const messages: SerializedMessage[] = [
      makeMessage({ id: 'msg-1', role: 'user' }),
      makeMessage({ id: 'msg-2', role: 'assistant' }),
      makeMessage({ id: 'msg-3', role: 'assistant' }),
    ];

    render(
      <SessionViewerPanel
        messages={messages}
        chunks={[]}
        metrics={makeMetrics()}
        isLive={true}
        isLoading={false}
        error={null}
      />,
    );

    expect(useAutoScrollBottomMock).toHaveBeenCalledWith({
      enabled: true,
      triggerDep: 3,
    });
  });

  it('keeps expanded tool-call state when only metrics update', () => {
    const messages: SerializedMessage[] = [
      makeMessage({
        id: 'ai-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        toolCalls: [{ id: 'tc-1', name: 'Read', input: { file_path: '/src/a.ts' }, isTask: false }],
        toolResults: [{ toolCallId: 'tc-1', content: 'tool output', isError: false }],
      }),
    ];

    const { rerender } = render(
      <SessionViewerPanel
        messages={messages}
        chunks={[]}
        metrics={makeMetrics({ totalTokens: 2400 })}
        isLive={true}
        isLoading={false}
        error={null}
      />,
    );

    fireEvent.click(screen.getByText('Read'));
    expect(screen.getByText(/tool output/)).toBeInTheDocument();

    rerender(
      <SessionViewerPanel
        messages={messages}
        chunks={[]}
        metrics={makeMetrics({ totalTokens: 3600 })}
        isLive={true}
        isLoading={false}
        error={null}
      />,
    );

    expect(screen.getByText(/tool output/)).toBeInTheDocument();
  });

  it('keeps AIGroup expansion state when only metrics update', () => {
    const messages: SerializedMessage[] = [makeMessage({ id: 'msg-base', role: 'assistant' })];
    const chunks: SerializedChunk[] = [
      {
        id: 'chunk-ai-1',
        type: 'ai',
        startTime: '2026-02-24T12:00:00.000Z',
        endTime: '2026-02-24T12:00:03.000Z',
        messages: [
          makeMessage({
            id: 'a1',
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
            id: 'step-thinking',
            type: 'thinking',
            startTime: '2026-02-24T12:00:00.000Z',
            durationMs: 0,
            content: { thinkingText: 'Analyzing request' },
            context: 'main',
          },
          {
            id: 'step-output',
            type: 'output',
            startTime: '2026-02-24T12:00:01.000Z',
            durationMs: 0,
            content: { outputText: 'Chunk output' },
            context: 'main',
          },
        ],
        turns: [],
      },
    ];

    const { rerender } = render(
      <SessionViewerPanel
        messages={messages}
        chunks={chunks}
        metrics={makeMetrics({ totalTokens: 2400 })}
        isLive={false}
        isLoading={false}
        error={null}
      />,
    );

    fireEvent.click(screen.getByTestId('ai-group-header'));
    expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();

    rerender(
      <SessionViewerPanel
        messages={messages}
        chunks={chunks}
        metrics={makeMetrics({ totalTokens: 3600 })}
        isLive={false}
        isLoading={false}
        error={null}
      />,
    );

    expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();
  });
});
