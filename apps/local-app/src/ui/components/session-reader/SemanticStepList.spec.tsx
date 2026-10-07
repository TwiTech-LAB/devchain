import React from 'react';
import { render, screen } from '@testing-library/react';
import { SemanticStepList } from './SemanticStepList';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';

jest.mock('@/ui/components/shared/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, className }: { content: string; className?: string }) => (
    <div data-testid="markdown-renderer" data-class={className}>
      {content}
    </div>
  ),
}));

jest.mock('./ThinkingBlock', () => ({
  ThinkingBlock: ({ step }: { step: { id: string } }) => (
    <div data-testid="thinking-block">{step.id}</div>
  ),
}));

jest.mock('./ToolCallItem', () => ({
  ToolCallItem: ({ step }: { step: { id: string } }) => (
    <div data-testid="tool-call-item">{step.id}</div>
  ),
}));

jest.mock('./SubagentItem', () => ({
  SubagentItem: ({ step }: { step: { id: string } }) => (
    <div data-testid="subagent-item">{step.id}</div>
  ),
}));

function makeOutputStep(text: string): SerializedSemanticStep {
  return {
    id: 'step-output-1',
    type: 'output',
    startTime: '2026-02-24T12:00:00.000Z',
    durationMs: 0,
    content: { outputText: text },
    context: 'main',
  };
}

describe('SemanticStepList — output prose-band treatment (T2)', () => {
  it('MarkdownRenderer invoked with text-sm (not text-xs)', () => {
    const steps = [makeOutputStep('Prose content')];
    render(<SemanticStepList steps={steps} />);

    const renderer = screen.getByTestId('markdown-renderer');
    expect(renderer).toHaveTextContent('Prose content');
    expect(renderer.getAttribute('data-class')).toContain('text-sm');
    expect(renderer.getAttribute('data-class')).not.toContain('text-xs');
  });

  it('empty output step renders nothing', () => {
    const steps = [makeOutputStep('   ')];
    const { container } = render(<SemanticStepList steps={steps} />);

    expect(container.querySelectorAll('[data-testid="markdown-renderer"]')).toHaveLength(0);
  });
});
