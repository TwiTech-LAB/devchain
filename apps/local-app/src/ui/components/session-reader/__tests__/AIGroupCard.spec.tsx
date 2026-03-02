import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type {
  SerializedChunk,
  SerializedMessage,
  SerializedSemanticStep,
} from '@/ui/hooks/useSessionTranscript';
import * as enhancer from '@/ui/utils/ai-group-enhancer';
import { AIGroupCard } from '../AIGroupCard';

jest.mock('@/ui/components/shared/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, className }: { content: string; className?: string }) => (
    <div className={className} data-testid="markdown-renderer">
      {content}
    </div>
  ),
}));

const lastOutputDisplaySpy = jest.fn();

jest.mock('../LastOutputDisplay', () => ({
  LastOutputDisplay: (props: {
    lastOutput: { text: string } | null;
    isLive?: boolean;
    hideTimestamp?: boolean;
  }) => {
    lastOutputDisplaySpy(props);
    if (!props.lastOutput) {
      if (!props.isLive) return null;
      return <div data-testid="last-output-placeholder">No output yet</div>;
    }
    return (
      <div data-testid="last-output-display">
        <div data-testid="last-output-content">{props.lastOutput.text}</div>
      </div>
    );
  },
}));

jest.mock('../SemanticStepList', () => ({
  SemanticStepList: ({
    steps,
  }: {
    steps: Array<{ id: string; type: string; content: { outputText?: string } }>;
  }) => (
    <div data-testid="semantic-step-list">
      {steps.map((step) => (
        <div key={step.id} data-testid={`semantic-step-${step.id}`}>
          {step.type === 'output' ? step.content.outputText : step.id}
        </div>
      ))}
    </div>
  ),
}));

function makeMessage(overrides: Partial<SerializedMessage> = {}): SerializedMessage {
  return {
    id: 'a1',
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

function makeStep(
  overrides: Partial<SerializedSemanticStep> & Pick<SerializedSemanticStep, 'id' | 'type'>,
): SerializedSemanticStep {
  return {
    id: overrides.id,
    type: overrides.type,
    startTime: '2026-02-24T12:00:00.000Z',
    durationMs: 0,
    content: {},
    context: 'main',
    ...overrides,
  };
}

function makeChunk(
  overrides: Partial<SerializedChunk & { type: 'ai' }> = {},
): SerializedChunk & { type: 'ai' } {
  return {
    id: 'chunk-ai',
    type: 'ai',
    startTime: '2026-02-24T12:00:00.000Z',
    endTime: '2026-02-24T12:00:05.000Z',
    messages: [makeMessage()],
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      totalTokens: 165,
      messageCount: 1,
      durationMs: 5000,
      costUsd: 0,
    },
    semanticSteps: [
      makeStep({
        id: 'thinking-1',
        type: 'thinking',
        content: { thinkingText: 'thinking' },
      }),
      makeStep({
        id: 'output-last',
        type: 'output',
        content: { outputText: 'Final answer' },
      }),
    ],
    turns: [],
    ...overrides,
  };
}

describe('AIGroupCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders collapsed by default with header and last output only', () => {
    const chunk = makeChunk();

    render(<AIGroupCard chunk={chunk} isExpanded={false} onToggle={jest.fn()} />);

    expect(screen.getByTestId('ai-group-card')).toBeInTheDocument();
    expect(screen.getByTestId('ai-group-header')).toBeInTheDocument();
    expect(screen.getByTestId('last-output-display')).toBeInTheDocument();
    expect(screen.queryByTestId('semantic-step-list')).not.toBeInTheDocument();
    expect(screen.getByText('Final answer')).toBeInTheDocument();
  });

  it('toggles expanded content and calls onLayoutChange on header click', () => {
    const chunk = makeChunk();
    const onLayoutChange = jest.fn();

    function Harness() {
      const [isExpanded, setIsExpanded] = React.useState(false);

      return (
        <AIGroupCard
          chunk={chunk}
          isExpanded={isExpanded}
          onToggle={() => setIsExpanded((prev) => !prev)}
          onLayoutChange={onLayoutChange}
        />
      );
    }

    render(<Harness />);

    expect(screen.queryByTestId('semantic-step-list')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('ai-group-header'));
    expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();
    expect(onLayoutChange).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('ai-group-header'));
    expect(screen.queryByTestId('semantic-step-list')).not.toBeInTheDocument();
    expect(onLayoutChange).toHaveBeenCalledTimes(2);
  });

  it('does not rerender when props references are unchanged (React.memo)', () => {
    const chunk = makeChunk();
    const onToggle = jest.fn();
    const onLayoutChange = jest.fn();
    const findLastOutputSpy = jest.spyOn(enhancer, 'findLastOutput');

    const { rerender } = render(
      <AIGroupCard
        sessionId="session-1"
        chunk={chunk}
        isExpanded={false}
        onToggle={onToggle}
        onLayoutChange={onLayoutChange}
      />,
    );
    const initialRenderCalls = findLastOutputSpy.mock.calls.length;

    rerender(
      <AIGroupCard
        sessionId="session-1"
        chunk={chunk}
        isExpanded={false}
        onToggle={onToggle}
        onLayoutChange={onLayoutChange}
      />,
    );

    expect(findLastOutputSpy.mock.calls.length).toBe(initialRenderCalls);
  });

  it('does not duplicate the last output in expanded semantic steps', () => {
    const chunk = makeChunk({
      semanticSteps: [
        makeStep({
          id: 'thinking-1',
          type: 'thinking',
          content: { thinkingText: 'thinking' },
        }),
        makeStep({
          id: 'output-last',
          type: 'output',
          content: { outputText: 'Final answer' },
        }),
      ],
    });

    render(<AIGroupCard chunk={chunk} isExpanded={true} onToggle={jest.fn()} />);

    expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();
    expect(screen.queryByTestId('semantic-step-output-last')).not.toBeInTheDocument();
    expect(screen.getAllByText('Final answer')).toHaveLength(1);
  });

  it('passes hideTimestamp to LastOutputDisplay', () => {
    const chunk = makeChunk();
    lastOutputDisplaySpy.mockClear();

    render(<AIGroupCard chunk={chunk} isExpanded={false} onToggle={jest.fn()} />);

    const call = lastOutputDisplaySpy.mock.calls.find(
      (args: unknown[]) => (args[0] as { hideTimestamp?: boolean }).hideTimestamp !== undefined,
    );
    expect(call).toBeDefined();
    expect((call![0] as { hideTimestamp: boolean }).hideTimestamp).toBe(true);
  });

  it('renders LastOutputDisplay in both collapsed and expanded states (guard)', () => {
    const chunk = makeChunk();

    function Harness() {
      const [isExpanded, setIsExpanded] = React.useState(false);
      return (
        <AIGroupCard
          chunk={chunk}
          isExpanded={isExpanded}
          onToggle={() => setIsExpanded((prev) => !prev)}
        />
      );
    }

    render(<Harness />);

    // Collapsed: LastOutputDisplay is present
    expect(screen.getByTestId('last-output-display')).toBeInTheDocument();

    // Expand
    fireEvent.click(screen.getByTestId('ai-group-header'));

    // Expanded: LastOutputDisplay is still present
    expect(screen.getByTestId('last-output-display')).toBeInTheDocument();
  });
});
