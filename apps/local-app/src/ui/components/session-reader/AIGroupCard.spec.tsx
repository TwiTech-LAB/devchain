import React from 'react';
import { render, screen } from '@testing-library/react';
import { AIGroupCard, type AIGroupCardProps } from './AIGroupCard';
import type { SerializedChunk, SerializedMessage } from '@/ui/hooks/useSessionTranscript';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<SerializedMessage> = {}): SerializedMessage {
  return {
    id: 'msg-1',
    parentId: null,
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    timestamp: '2026-02-24T12:00:00.000Z',
    content: [{ type: 'text', text: 'Hello' }],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
    usage: { input: 10_000, output: 2_000, cacheRead: 5_000, cacheCreation: 1_000 },
    ...overrides,
  };
}

function makeAiChunk(overrides: Partial<SerializedChunk> = {}): SerializedChunk & { type: 'ai' } {
  return {
    id: 'chunk-ai-1',
    type: 'ai',
    startTime: '2026-02-24T12:00:00.000Z',
    endTime: '2026-02-24T12:00:01.000Z',
    messages: [makeMessage()],
    metrics: {
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 5_000,
      cacheCreationTokens: 1_000,
      totalTokens: 18_000,
      messageCount: 1,
      durationMs: 1000,
      costUsd: 0.01,
    },
    semanticSteps: [
      {
        id: 'step-output',
        type: 'output',
        startTime: '2026-02-24T12:00:01.000Z',
        durationMs: 0,
        content: { outputText: 'Hello' },
        context: 'main',
      },
    ],
    turns: [],
    ...overrides,
  } as SerializedChunk & { type: 'ai' };
}

function renderCard(overrides: Partial<AIGroupCardProps> = {}) {
  const defaultProps: AIGroupCardProps = {
    chunk: makeAiChunk(),
    isExpanded: false,
    onToggle: jest.fn(),
    ...overrides,
  };
  return render(<AIGroupCard {...defaultProps} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AIGroupCard input delta rendering', () => {
  it('renders delta element with data-testid when inputDelta > 0', () => {
    renderCard({ inputDelta: 13_000 });

    const deltaEl = screen.getByTestId('ai-group-input-delta');
    expect(deltaEl).toBeInTheDocument();
    // formatTokensCompact(13000) → "13k"
    expect(deltaEl).toHaveTextContent('(+13k)');
  });

  it('does not render delta element when inputDelta is undefined', () => {
    renderCard({ inputDelta: undefined });

    expect(screen.queryByTestId('ai-group-input-delta')).not.toBeInTheDocument();
  });

  it('does not render delta element when inputDelta is 0', () => {
    renderCard({ inputDelta: 0 });

    expect(screen.queryByTestId('ai-group-input-delta')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Step-level hotspot rendering
// ---------------------------------------------------------------------------

describe('AIGroupCard step-level hotspot rendering', () => {
  function makeStepsChunk() {
    return makeAiChunk({
      semanticSteps: [
        {
          id: 'step-thinking',
          type: 'thinking',
          startTime: '2026-02-24T12:00:00.000Z',
          durationMs: 100,
          estimatedTokens: 100,
          content: { thinkingText: 'Normal thinking' },
          context: 'main',
        },
        {
          id: 'step-tc',
          type: 'tool_call',
          startTime: '2026-02-24T12:00:01.000Z',
          durationMs: 200,
          estimatedTokens: 800,
          content: {
            toolCallId: 'tc-1',
            toolName: 'Read',
            toolInput: { file_path: '/src/index.ts' },
          },
          context: 'main',
        },
        {
          id: 'step-tr',
          type: 'tool_result',
          startTime: '2026-02-24T12:00:02.000Z',
          durationMs: 0,
          estimatedTokens: 200,
          content: { toolCallId: 'tc-1', toolResultContent: 'file contents', isError: false },
          context: 'main',
        },
        {
          id: 'step-output',
          type: 'output',
          startTime: '2026-02-24T12:00:03.000Z',
          durationMs: 0,
          estimatedTokens: 50,
          content: { outputText: 'Here is the file.' },
          context: 'main',
        },
      ],
      turns: [],
    });
  }

  it('does not compute step hotspots when collapsed', () => {
    renderCard({
      chunk: makeStepsChunk(),
      isExpanded: false,
      stepHotspotThreshold: 500,
    });

    // Collapsed → no semantic step list → no step-level hotspot indicators
    expect(screen.queryByTestId('semantic-step-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-flame')).not.toBeInTheDocument();
  });

  it('computes and renders step hotspots when expanded with threshold', () => {
    // displayItems after buildDisplayItems: [thinking(100), tool(800+200=1000)]
    // threshold=500 → tool(1000) > 500 → hot
    renderCard({
      chunk: makeStepsChunk(),
      isExpanded: true,
      stepHotspotThreshold: 500,
    });

    expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();
    // Flame icon present on the hot tool step
    expect(screen.getByTestId('step-hotspot-flame')).toBeInTheDocument();
    expect(screen.getByTestId('step-hotspot-pct')).toBeInTheDocument();
  });
});
