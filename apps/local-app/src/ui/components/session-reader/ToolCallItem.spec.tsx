import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ToolCallItem } from './ToolCallItem';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
import { renderWithMode } from './__tests__/test-utils';
import { installLayoutMock, type LayoutMock } from './__tests__/layout-mock';
import { TranscriptDisclosureProvider } from '@/ui/hooks/useTranscriptDisclosure';

/** The block (ClampedContent root) around a `<pre>` found by its test id. */
function blockOf(testId: string): HTMLElement {
  return screen.getByTestId(testId).parentElement!.parentElement!.parentElement!;
}

jest.mock('@/ui/lib/sessions', () => ({
  ...jest.requireActual('@/ui/lib/sessions'),
  fetchJsonOrThrow: jest.fn(),
}));

const fetchJsonOrThrowMock = fetchJsonOrThrow as jest.MockedFunction<typeof fetchJsonOrThrow>;

function makeStep(overrides: Partial<SerializedSemanticStep> = {}): SerializedSemanticStep {
  return {
    id: 'step-tc-1',
    type: 'tool_call',
    startTime: '2026-02-24T12:00:00.000Z',
    durationMs: 0,
    estimatedTokens: 0,
    content: {
      toolName: 'Read',
      toolInput: { file_path: '/src/index.ts' },
      toolCallId: 'tc-1',
    },
    context: 'main',
    ...overrides,
  };
}

function makeResultStep(overrides: Partial<SerializedSemanticStep> = {}): SerializedSemanticStep {
  return {
    id: 'step-tr-1',
    type: 'tool_result',
    startTime: '2026-02-24T12:00:01.000Z',
    durationMs: 0,
    estimatedTokens: 0,
    content: {
      toolCallId: 'tc-1',
      toolResultContent: 'file contents here',
      isError: false,
    },
    context: 'main',
    ...overrides,
  };
}

describe('ToolCallItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders collapsed trigger with one-liner summary', () => {
    render(<ToolCallItem step={makeStep()} />);
    const trigger = screen.getByTestId('tool-call-trigger');
    expect(trigger).toHaveTextContent('Read: /src/index.ts');
  });

  it('shows duration in trigger', () => {
    render(<ToolCallItem step={makeStep({ durationMs: 1500 })} />);
    expect(screen.getByTestId('tool-call-duration')).toHaveTextContent('1.5s');
  });

  it('shows Layers icon for Task tool', () => {
    render(
      <ToolCallItem
        step={makeStep({
          content: { toolName: 'Task', toolInput: { prompt: 'Search code' }, toolCallId: 'tc-2' },
        })}
      />,
    );
    expect(screen.getByTestId('tool-call-trigger')).toHaveTextContent('Task');
  });

  it('shows error indicator when result has isError', () => {
    render(
      <ToolCallItem
        step={makeStep()}
        resultStep={makeResultStep({
          content: { toolCallId: 'tc-1', toolResultContent: 'Error!', isError: true },
        })}
      />,
    );
    // AlertTriangle icon is present — check via the trigger containing error styling
    const trigger = screen.getByTestId('tool-call-trigger');
    expect(trigger.querySelector('svg.text-destructive')).toBeTruthy();
  });

  it('expands to show tool input and result', () => {
    render(<ToolCallItem step={makeStep()} resultStep={makeResultStep()} />);

    // Content hidden initially
    expect(screen.queryByTestId('tool-call-input')).not.toBeInTheDocument();

    // Click to expand
    expect(screen.getByTestId('tool-call-trigger')).toHaveAttribute('data-state', 'closed');
    fireEvent.click(screen.getByTestId('tool-call-trigger'));
    expect(screen.getByTestId('tool-call-trigger')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('tool-call-input')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-result')).toBeInTheDocument();
    expect(screen.getByText(/file contents here/)).toBeInTheDocument();
  });

  it('shows error styling on result when isError', () => {
    render(
      <ToolCallItem
        step={makeStep()}
        resultStep={makeResultStep({
          content: { toolCallId: 'tc-1', toolResultContent: 'Command failed', isError: true },
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('tool-call-trigger'));
    const result = screen.getByTestId('tool-call-result');
    expect(result).toHaveClass('bg-destructive/10');
  });

  describe('preview boxes', () => {
    let layout: LayoutMock;
    beforeEach(() => {
      layout = installLayoutMock();
    });
    afterEach(() => layout.restore());

    it('input: one "Show full" reveals the full text past the character cap', () => {
      const largeInput: Record<string, unknown> = { data: 'X'.repeat(1000) + 'INPUT-END' };
      render(
        <ToolCallItem
          step={makeStep({
            content: { toolName: 'Write', toolInput: largeInput, toolCallId: 'tc-3' },
          })}
        />,
      );

      fireEvent.click(screen.getByTestId('tool-call-trigger'));
      expect(screen.getByTestId('tool-call-input')).not.toHaveTextContent('INPUT-END');
      const toggles = within(blockOf('tool-call-input')).getAllByRole('button');
      expect(toggles).toHaveLength(1);

      fireEvent.click(toggles[0]);

      expect(screen.getByTestId('tool-call-input')).toHaveTextContent('INPUT-END');
      expect(toggles[0]).toHaveTextContent('Show less');
    });

    it('result: one "Show full" reveals the full text past the character cap', () => {
      const largeResult = 'Y'.repeat(1000) + 'RESULT-END';
      render(
        <ToolCallItem
          step={makeStep()}
          resultStep={makeResultStep({
            content: { toolCallId: 'tc-1', toolResultContent: largeResult, isError: false },
          })}
        />,
      );

      fireEvent.click(screen.getByTestId('tool-call-trigger'));
      const result = screen.getByTestId('tool-call-result');
      expect(result).not.toHaveTextContent('RESULT-END');
      expect(result.parentElement!.parentElement!.style.maxHeight).toBe('256px');

      fireEvent.click(
        within(blockOf('tool-call-result')).getByRole('button', { name: 'Show full' }),
      );

      expect(result).toHaveTextContent('RESULT-END');
      expect(within(blockOf('tool-call-result')).getByRole('button')).toHaveTextContent(
        'Show less',
      );
    });

    it('short input and result show no toggle', () => {
      render(<ToolCallItem step={makeStep()} resultStep={makeResultStep()} />);
      fireEvent.click(screen.getByTestId('tool-call-trigger'));
      expect(screen.queryByRole('button', { name: /^show (full|less)$/i })).toBeNull();
    });

    it('keeps the section open and refetches an expanded full result after a remount', async () => {
      fetchJsonOrThrowMock.mockResolvedValue({
        sessionId: 'session-1',
        toolCallId: 'tc-1',
        content: 'PREFIX…SENTINEL-PAST-PREFIX',
        isError: false,
        fullLength: 4096,
      });
      const item = (
        <ToolCallItem
          sessionId="session-1"
          chunkId="chunk-1"
          step={makeStep()}
          resultStep={makeResultStep({
            content: {
              toolCallId: 'tc-1',
              toolResultContent: 'PREFIX…',
              isTruncated: true,
              fullLength: 4096,
              isError: false,
            },
          })}
        />
      );
      const ui = (children: React.ReactNode) => (
        <TranscriptDisclosureProvider scope="session-1">{children}</TranscriptDisclosureProvider>
      );
      const { rerender } = render(ui(item));
      fireEvent.click(screen.getByTestId('tool-call-trigger'));
      fireEvent.click(screen.getByRole('button', { name: 'Show full result (4.0 KB)' }));
      await screen.findByText(/SENTINEL-PAST-PREFIX/);

      rerender(ui(null));
      rerender(ui(item));

      expect(screen.getByTestId('tool-call-trigger')).toHaveAttribute('data-state', 'open');
      await screen.findByText(/SENTINEL-PAST-PREFIX/);
      expect(fetchJsonOrThrowMock).toHaveBeenCalledTimes(2);
    });
  });

  it('renders one-liner with command for Bash tool', () => {
    render(
      <ToolCallItem
        step={makeStep({
          content: { toolName: 'Bash', toolInput: { command: 'npm test' }, toolCallId: 'tc-4' },
        })}
      />,
    );
    expect(screen.getByTestId('tool-call-trigger')).toHaveTextContent('Bash: npm test');
  });

  it('renders one-liner with pattern for Grep tool', () => {
    render(
      <ToolCallItem
        step={makeStep({
          content: { toolName: 'Grep', toolInput: { pattern: 'TODO' }, toolCallId: 'tc-5' },
        })}
      />,
    );
    expect(screen.getByTestId('tool-call-trigger')).toHaveTextContent('Grep: TODO');
  });

  it('shows token badge combining tool call and tool result estimates', () => {
    render(
      <ToolCallItem
        step={makeStep({ estimatedTokens: 900 })}
        resultStep={makeResultStep({ estimatedTokens: 700 })}
      />,
    );

    expect(screen.getByTestId('tool-call-token-estimate')).toHaveTextContent('~1,600');
  });

  it('computes duration from step/result timestamps and shows green dot', () => {
    render(
      <ToolCallItem
        step={makeStep({ startTime: '2026-02-24T12:00:00.000Z', durationMs: 0 })}
        resultStep={makeResultStep({ startTime: '2026-02-24T12:00:02.250Z' })}
      />,
    );

    expect(screen.getByTestId('tool-call-duration-dot')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-duration')).toHaveTextContent('2.3s');
  });

  it('clamps negative timestamp diff to 0 and hides duration', () => {
    render(
      <ToolCallItem
        step={makeStep({ startTime: '2026-02-24T12:00:05.000Z', durationMs: 0 })}
        resultStep={makeResultStep({ startTime: '2026-02-24T12:00:01.000Z' })}
      />,
    );

    expect(screen.queryByTestId('tool-call-duration-dot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-call-duration')).not.toBeInTheDocument();
  });

  it('shows only step token estimate when result step is missing', () => {
    render(<ToolCallItem step={makeStep({ estimatedTokens: 1250, durationMs: 0 })} />);

    expect(screen.getByTestId('tool-call-token-estimate')).toHaveTextContent('~1,250');
    expect(screen.queryByTestId('tool-call-duration')).not.toBeInTheDocument();
  });

  it('renders one-liner with description param', () => {
    render(
      <ToolCallItem
        step={makeStep({
          content: {
            toolName: 'Task',
            toolInput: { description: 'Review integration plan for release' },
            toolCallId: 'tc-desc',
          },
        })}
      />,
    );

    expect(screen.getByTestId('tool-call-trigger')).toHaveTextContent(
      'Task: Review integration plan for release',
    );
  });

  it('uses generic fallback with first non-sensitive string param', () => {
    render(
      <ToolCallItem
        step={makeStep({
          content: {
            toolName: 'McpTool',
            toolInput: {
              apiKey: 'secret-key',
              sessionId: 'session-secret',
              note: 'scan source project',
            },
            toolCallId: 'tc-generic',
          },
        })}
      />,
    );

    expect(screen.getByTestId('tool-call-trigger')).toHaveTextContent(
      'McpTool: scan source project',
    );
  });

  it('does not leak sensitive params in one-liner preview', () => {
    render(
      <ToolCallItem
        step={makeStep({
          content: {
            toolName: 'SecretTool',
            toolInput: {
              token: 'abcd',
              apiKey: 'efgh',
              password: 'ijkl',
              session_id: 'hidden',
            },
            toolCallId: 'tc-sensitive',
          },
        })}
      />,
    );

    const trigger = screen.getByTestId('tool-call-trigger');
    expect(trigger).toHaveTextContent('SecretTool');
    expect(trigger).not.toHaveTextContent('abcd');
    expect(trigger).not.toHaveTextContent('efgh');
    expect(trigger).not.toHaveTextContent('ijkl');
    expect(trigger).not.toHaveTextContent('hidden');
  });

  it('loads full server-truncated result on demand', async () => {
    fetchJsonOrThrowMock.mockResolvedValue({
      sessionId: 'session-1',
      toolCallId: 'tc-1',
      content: 'FULL TOOL RESULT CONTENT',
      isError: false,
      fullLength: 4096,
    });

    render(
      <ToolCallItem
        sessionId="session-1"
        step={makeStep()}
        resultStep={makeResultStep({
          content: {
            toolCallId: 'tc-1',
            toolResultContent: 'TRUNCATED CONTENT…',
            isTruncated: true,
            fullLength: 4096,
            isError: false,
          },
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('tool-call-trigger'));
    // A cut result has one control: the toggle, labelled with what it downloads.
    expect(screen.getAllByRole('button', { name: /^Show full/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show full result (4.0 KB)' }));

    await waitFor(() => {
      expect(screen.getByText(/FULL TOOL RESULT CONTENT/)).toBeInTheDocument();
    });
    // The fetched result opens expanded.
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();

    expect(fetchJsonOrThrowMock).toHaveBeenCalledWith(
      '/api/sessions/session-1/transcript/tool-result/tc-1',
      { signal: expect.any(AbortSignal) },
      'Failed to fetch full tool result',
      expect.any(Function),
    );
    expect(screen.queryByRole('button', { name: /Show full/ })).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Step-level hotspot visual treatment
  // ---------------------------------------------------------------------------

  it('shows warning border, flame icon, and percentage when isStepHot=true (diagnostic mode)', () => {
    renderWithMode(
      <ToolCallItem step={makeStep({ estimatedTokens: 500 })} isStepHot percentOfChunk={62} />,
      'diagnostic',
    );

    const wrapper = screen.getByTestId('tool-call-wrapper');
    expect(wrapper).toHaveClass('border-status-warn');
    expect(wrapper.className).toContain('border-l-2');

    expect(screen.getByTestId('step-hotspot-flame')).toBeInTheDocument();

    const pct = screen.getByTestId('step-hotspot-pct');
    expect(pct).toHaveTextContent('62%');
  });

  it('hides hotspot indicators in Reader mode even when isStepHot=true', () => {
    render(
      <ToolCallItem step={makeStep({ estimatedTokens: 500 })} isStepHot percentOfChunk={62} />,
    );

    expect(screen.queryByTestId('step-hotspot-flame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-pct')).not.toBeInTheDocument();
  });

  it('does not show hotspot indicators when isStepHot is false or undefined', () => {
    render(<ToolCallItem step={makeStep()} />);

    const wrapper = screen.getByTestId('tool-call-wrapper');
    expect(wrapper.className).not.toMatch(/border-status-warn/);

    expect(screen.queryByTestId('step-hotspot-flame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-pct')).not.toBeInTheDocument();
  });

  it('does not show percentage badge when percentOfChunk is 0 (diagnostic mode)', () => {
    renderWithMode(<ToolCallItem step={makeStep()} isStepHot percentOfChunk={0} />, 'diagnostic');

    expect(screen.getByTestId('step-hotspot-flame')).toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-pct')).not.toBeInTheDocument();
  });
});
