import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LastOutputDisplay } from '../LastOutputDisplay';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
import { installLayoutMock } from './layout-mock';
import { TranscriptDisclosureProvider } from '@/ui/hooks/useTranscriptDisclosure';
import type { LastOutput } from '@/ui/utils/ai-group-enhancer';

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchJsonOrThrow: jest.fn(),
}));

const fetchJsonOrThrowMock = fetchJsonOrThrow as jest.MockedFunction<typeof fetchJsonOrThrow>;

jest.mock('@/ui/components/shared/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, className }: { content: string; className?: string }) => (
    <div className={className} data-testid="markdown-renderer">
      {content}
    </div>
  ),
}));

describe('LastOutputDisplay', () => {
  it('renders markdown content for the latest output', () => {
    render(
      <LastOutputDisplay
        lastOutput={{
          type: 'text',
          text: '**Final** answer',
          timestamp: new Date('2026-02-24T12:00:03.000Z'),
          stepId: 'output-1',
        }}
      />,
    );

    expect(screen.getByTestId('last-output-display')).toBeInTheDocument();
    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('**Final** answer');
  });

  it('copies the raw output text with its original line breaks', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const text = 'First paragraph\nsame paragraph\n\n```sh\n  echo "hi"\n```';
    render(
      <LastOutputDisplay
        lastOutput={{
          type: 'text',
          text,
          timestamp: new Date('2026-02-24T12:00:03.000Z'),
          stepId: 'output-1',
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
  });

  it('shows placeholder for null output when session is live', () => {
    const { rerender } = render(<LastOutputDisplay lastOutput={null} isLive={true} />);

    expect(screen.getByTestId('last-output-placeholder')).toHaveTextContent('No output yet');

    rerender(<LastOutputDisplay lastOutput={null} isLive={false} />);
    expect(screen.queryByTestId('last-output-placeholder')).not.toBeInTheDocument();
  });
});

describe('LastOutputDisplay — full result', () => {
  it('loads a truncated latest tool result through its "Show full" control', async () => {
    const layout = installLayoutMock();
    const body = {
      sessionId: 'session-1',
      toolCallId: 'tc-9',
      content: 'prefix LATEST-SENTINEL-PAST-PREFIX',
      isError: false,
      fullLength: 4096,
    };
    fetchJsonOrThrowMock
      .mockResolvedValueOnce({ ...body, content: 'prefix capped', isComplete: false })
      .mockResolvedValueOnce({ ...body, isComplete: true });
    try {
      render(
        <LastOutputDisplay
          sessionId="session-1"
          chunkId="chunk-1"
          lastOutput={{
            type: 'tool_result',
            text: 'prefix',
            timestamp: new Date('2026-02-24T12:00:03.000Z'),
            stepId: 'step-3',
            toolCallId: 'tc-9',
            isTruncated: true,
            fullLength: 4096,
          }}
        />,
      );

      // An incomplete response is an error, not the full body; collapsing allows a retry.
      fireEvent.click(screen.getByRole('button', { name: 'Show full' }));
      expect(await screen.findByTestId('tool-result-load-error')).toHaveTextContent(
        'The full result (4,096 characters) is no longer available from its source.',
      );
      expect(screen.getByTestId('markdown-renderer')).toHaveTextContent(/^prefix$/);
      fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
      fireEvent.click(screen.getByRole('button', { name: 'Show full' }));

      await waitFor(() =>
        expect(screen.getByTestId('markdown-renderer')).toHaveTextContent(
          'LATEST-SENTINEL-PAST-PREFIX',
        ),
      );
      expect(fetchJsonOrThrowMock).toHaveBeenCalledWith(
        '/api/sessions/session-1/transcript/tool-result/tc-9',
        { signal: expect.any(AbortSignal) },
        'Failed to fetch full tool result',
        expect.any(Function),
      );
      expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
    } finally {
      layout.restore();
    }
  });

  it('shows no toggle for a short, complete output', () => {
    render(
      <LastOutputDisplay
        lastOutput={{
          type: 'text',
          text: 'short',
          timestamp: new Date('2026-02-24T12:00:03.000Z'),
          stepId: 'step-3',
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: /^show/i })).toBeNull();
  });
});

describe('LastOutputDisplay — a live row that stays mounted', () => {
  const at = new Date('2026-02-24T12:00:03.000Z');
  const resultA: LastOutput = {
    type: 'tool_result',
    text: 'prefix A',
    timestamp: at,
    stepId: 'step-a',
    toolCallId: 'tc-a',
    isTruncated: true,
    fullLength: 4096,
  };
  const outputB: LastOutput = {
    type: 'text',
    text: 'later output B',
    timestamp: at,
    stepId: 'step-b',
  };
  const resultC: LastOutput = {
    ...resultA,
    text: 'prefix C',
    stepId: 'step-c',
    toolCallId: 'tc-c',
  };

  function fullBody(toolCallId: string, content: string) {
    return { sessionId: 'session-1', toolCallId, content, isError: false, fullLength: 4096 };
  }

  function renderRow(lastOutput: LastOutput) {
    return (
      <TranscriptDisclosureProvider scope="session-1">
        <LastOutputDisplay sessionId="session-1" chunkId="chunk-live" lastOutput={lastOutput} />
      </TranscriptDisclosureProvider>
    );
  }

  let layout: ReturnType<typeof installLayoutMock>;
  beforeEach(() => {
    jest.clearAllMocks();
    layout = installLayoutMock();
  });
  afterEach(() => layout.restore());

  it('renders and copies the later output, then fetches the next truncated result', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    fetchJsonOrThrowMock
      .mockResolvedValueOnce(fullBody('tc-a', 'prefix A FULL-A-SENTINEL'))
      .mockResolvedValueOnce(fullBody('tc-c', 'prefix C FULL-C-SENTINEL'));
    const { rerender } = render(renderRow(resultA));
    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));
    await waitFor(() =>
      expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('FULL-A-SENTINEL'),
    );

    rerender(renderRow(outputB));

    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent(/^later output B$/);
    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('later output B'));

    rerender(renderRow(resultC));
    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent(/^prefix C$/);
    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));

    await waitFor(() =>
      expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('FULL-C-SENTINEL'),
    );
    expect(fetchJsonOrThrowMock).toHaveBeenCalledTimes(2);
    expect(fetchJsonOrThrowMock).toHaveBeenLastCalledWith(
      '/api/sessions/session-1/transcript/tool-result/tc-c',
      { signal: expect.any(AbortSignal) },
      'Failed to fetch full tool result',
      expect.any(Function),
    );
  });

  it('ignores a late response for an earlier result', async () => {
    let resolveA: (value: unknown) => void = () => {};
    fetchJsonOrThrowMock
      .mockImplementationOnce(() => new Promise((resolve) => (resolveA = resolve)) as never)
      .mockResolvedValueOnce(fullBody('tc-c', 'prefix C FULL-C-SENTINEL'));
    const { rerender } = render(renderRow(resultA));
    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));
    expect(screen.getByTestId('tool-result-loading')).toBeInTheDocument();

    rerender(renderRow(resultC));
    expect(screen.queryByTestId('tool-result-loading')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));
    await waitFor(() =>
      expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('FULL-C-SENTINEL'),
    );

    await act(async () => resolveA(fullBody('tc-a', 'prefix A FULL-A-SENTINEL')));

    expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('FULL-C-SENTINEL');
    expect(screen.getByTestId('markdown-renderer')).not.toHaveTextContent('FULL-A-SENTINEL');
  });
});
