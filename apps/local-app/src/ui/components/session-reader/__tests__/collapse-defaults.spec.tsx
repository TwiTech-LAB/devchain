import { fireEvent, render, screen } from '@testing-library/react';
import { ToolCallItem } from '../ToolCallItem';
import { ThinkingBlock } from '../ThinkingBlock';
import { SubagentItem } from '../SubagentItem';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';

jest.mock('@/ui/lib/sessions', () => ({
  fetchJsonOrThrow: jest.fn(),
}));

function makeStep(
  overrides: Partial<SerializedSemanticStep> & Pick<SerializedSemanticStep, 'id' | 'type'>,
): SerializedSemanticStep {
  return {
    id: overrides.id,
    type: overrides.type,
    startTime: '2026-02-24T12:00:00.000Z',
    durationMs: 500,
    content: {},
    context: 'main',
    ...overrides,
  };
}

describe('Collapse default state — ToolCallItem', () => {
  it('starts collapsed (trigger data-state=closed)', () => {
    const step = makeStep({
      id: 'tc-1',
      type: 'tool_call',
      content: { toolName: 'Read', toolInput: { file_path: '/foo.ts' }, toolCallId: 'call-1' },
      estimatedTokens: 100,
    });

    render(<ToolCallItem step={step} />);

    expect(screen.getByTestId('tool-call-trigger')).toHaveAttribute('data-state', 'closed');
    expect(screen.queryByTestId('tool-call-input')).not.toBeInTheDocument();
  });

  it('expands on trigger click', () => {
    const step = makeStep({
      id: 'tc-2',
      type: 'tool_call',
      content: { toolName: 'Read', toolInput: { file_path: '/bar.ts' }, toolCallId: 'call-2' },
      estimatedTokens: 100,
    });

    render(<ToolCallItem step={step} />);

    fireEvent.click(screen.getByTestId('tool-call-trigger'));
    expect(screen.getByTestId('tool-call-trigger')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('tool-call-input')).toBeVisible();
  });
});

describe('Collapse default state — ThinkingBlock', () => {
  it('starts collapsed (trigger data-state=closed)', () => {
    const step = makeStep({
      id: 'think-1',
      type: 'thinking',
      content: { thinkingText: 'Let me think about this...' },
      estimatedTokens: 50,
    });

    render(<ThinkingBlock step={step} />);

    expect(screen.getByTestId('thinking-block-trigger')).toHaveAttribute('data-state', 'closed');
    expect(screen.queryByTestId('thinking-block-content')).not.toBeInTheDocument();
  });

  it('expands on trigger click', () => {
    const step = makeStep({
      id: 'think-2',
      type: 'thinking',
      content: { thinkingText: 'reasoning text' },
      estimatedTokens: 50,
    });

    render(<ThinkingBlock step={step} />);

    fireEvent.click(screen.getByTestId('thinking-block-trigger'));
    expect(screen.getByTestId('thinking-block-trigger')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('thinking-block-content')).toBeVisible();
  });
});

describe('Collapse default state — SubagentItem', () => {
  it('starts collapsed (trigger data-state=closed)', () => {
    const step = makeStep({
      id: 'sub-1',
      type: 'subagent',
      content: { subagentDescription: 'Research task', sourceModel: 'claude-sonnet-4-6' },
      durationMs: 3000,
    });

    render(<SubagentItem step={step} />);

    expect(screen.getByTestId('subagent-trigger')).toHaveAttribute('data-state', 'closed');
    expect(screen.queryByTestId('subagent-details')).not.toBeInTheDocument();
  });

  it('expands on trigger click', () => {
    const step = makeStep({
      id: 'sub-2',
      type: 'subagent',
      content: { subagentDescription: 'Research task' },
      durationMs: 3000,
    });

    render(<SubagentItem step={step} />);

    fireEvent.click(screen.getByTestId('subagent-trigger'));
    expect(screen.getByTestId('subagent-trigger')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('subagent-details')).toBeVisible();
  });
});
