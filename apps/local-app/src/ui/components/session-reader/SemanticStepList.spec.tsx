import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SemanticStepList } from './SemanticStepList';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
import { TranscriptDisclosureProvider } from '@/ui/hooks/useTranscriptDisclosure';
import type { ToolGroupDisplayItem } from '@/ui/utils/ai-group-enhancer';
import { ToolGroupItem } from './ToolGroupItem';
import { installLayoutMock, type LayoutMock } from './__tests__/layout-mock';

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchJsonOrThrow: jest.fn(),
}));

const fetchJsonOrThrowMock = fetchJsonOrThrow as jest.MockedFunction<typeof fetchJsonOrThrow>;

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

function makeOrphanResult(
  content: Partial<SerializedSemanticStep['content']>,
): SerializedSemanticStep {
  return {
    id: 'step-orphan-1',
    type: 'tool_result',
    startTime: '2026-02-24T12:00:00.000Z',
    durationMs: 0,
    content: { toolCallId: 'tc-orphan', isError: false, ...content },
    context: 'main',
  };
}

describe('SemanticStepList — orphan tool result preview', () => {
  let layout: LayoutMock;
  beforeEach(() => {
    jest.clearAllMocks();
    layout = installLayoutMock();
  });
  afterEach(() => layout.restore());

  const block = () => screen.getByTestId('orphan-tool-result').parentElement!.parentElement!;

  it('clips at the cap with no scroller and shows no toggle for short text', () => {
    render(<SemanticStepList steps={[makeOrphanResult({ toolResultContent: 'short' })]} />);
    expect(block().className).toContain('overflow-y-clip');
    expect(block().style.maxHeight).toBe('128px');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('expands a long result in place', () => {
    render(<SemanticStepList steps={[makeOrphanResult({ toolResultContent: 'L'.repeat(500) })]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));
    expect(block().style.maxHeight).toBe('');
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
  });

  it('loads a server-truncated result through its "Show full" control', async () => {
    fetchJsonOrThrowMock.mockResolvedValue({
      sessionId: 'session-1',
      toolCallId: 'tc-orphan',
      content: 'prefix ORPHAN-SENTINEL-PAST-PREFIX',
      isError: false,
      fullLength: 4096,
    });
    render(
      <SemanticStepList
        sessionId="session-1"
        steps={[
          makeOrphanResult({ toolResultContent: 'prefix', isTruncated: true, fullLength: 4096 }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));

    expect(await screen.findByText(/ORPHAN-SENTINEL-PAST-PREFIX/)).toBeInTheDocument();
    expect(fetchJsonOrThrowMock).toHaveBeenCalledWith(
      '/api/sessions/session-1/transcript/tool-result/tc-orphan',
      { signal: expect.any(AbortSignal) },
      'Failed to fetch full tool result',
      expect.any(Function),
    );
  });
});

describe('ToolGroupItem — open state', () => {
  it('stays open after the row unmounts and mounts again', () => {
    const step = {
      id: 'step-read-1',
      type: 'tool_call',
      startTime: '2026-02-24T12:00:00.000Z',
      durationMs: 0,
      content: { toolName: 'Read', toolCallId: 'tc-r1' },
      context: 'main',
    } as SerializedSemanticStep;
    const group: ToolGroupDisplayItem = {
      type: 'tool-group',
      toolName: 'Read',
      count: 2,
      items: [
        { type: 'tool', step },
        { type: 'tool', step: { ...step, id: 'step-read-2' } },
      ],
      totalTokens: 0,
      totalDurationMs: 0,
      errorCount: 0,
    };
    const ui = (children: React.ReactNode) => (
      <TranscriptDisclosureProvider scope="s">{children}</TranscriptDisclosureProvider>
    );
    const { rerender } = render(ui(<ToolGroupItem chunkId="chunk-1" group={group} />));
    fireEvent.click(screen.getByTestId('tool-group-trigger'));

    rerender(ui(null));
    rerender(ui(<ToolGroupItem chunkId="chunk-1" group={group} />));

    expect(screen.getByTestId('tool-group-trigger')).toHaveAttribute('data-state', 'open');
    expect(
      within(screen.getByTestId('tool-group-wrapper')).getAllByTestId('tool-call-item'),
    ).toHaveLength(2);
  });
});
