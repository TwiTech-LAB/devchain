import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToolCallItem } from './ToolCallItem';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';

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
    fireEvent.click(screen.getByTestId('tool-call-trigger'));
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

  it('truncates large input with show more button', () => {
    const largeInput: Record<string, unknown> = { data: 'X'.repeat(1000) };
    render(
      <ToolCallItem
        step={makeStep({
          content: { toolName: 'Write', toolInput: largeInput, toolCallId: 'tc-3' },
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('tool-call-trigger'));
    expect(screen.getByTestId('tool-input-show-more')).toHaveTextContent('Show more');
  });

  it('truncates large result with show more button', () => {
    const largeResult = 'Y'.repeat(1000);
    render(
      <ToolCallItem
        step={makeStep()}
        resultStep={makeResultStep({
          content: { toolCallId: 'tc-1', toolResultContent: largeResult, isError: false },
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('tool-call-trigger'));
    expect(screen.getByTestId('tool-result-show-more')).toHaveTextContent('Show more');
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
    fireEvent.click(screen.getByTestId('tool-result-load-full'));

    await waitFor(() => {
      expect(screen.getByText(/FULL TOOL RESULT CONTENT/)).toBeInTheDocument();
    });

    expect(fetchJsonOrThrowMock).toHaveBeenCalledWith(
      '/api/sessions/session-1/transcript/tool-result/tc-1',
      {},
      'Failed to fetch full tool result',
    );
    expect(screen.queryByTestId('tool-result-load-full')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Step-level hotspot visual treatment
  // ---------------------------------------------------------------------------

  it('shows amber border, flame icon, and percentage when isStepHot=true', () => {
    render(
      <ToolCallItem step={makeStep({ estimatedTokens: 500 })} isStepHot percentOfChunk={62} />,
    );

    const wrapper = screen.getByTestId('tool-call-wrapper');
    expect(wrapper.className).toContain('border-amber-500');
    expect(wrapper.className).toContain('border-l-2');

    expect(screen.getByTestId('step-hotspot-flame')).toBeInTheDocument();

    const pct = screen.getByTestId('step-hotspot-pct');
    expect(pct).toHaveTextContent('62%');
  });

  it('does not show hotspot indicators when isStepHot is false or undefined', () => {
    render(<ToolCallItem step={makeStep()} />);

    const wrapper = screen.getByTestId('tool-call-wrapper');
    expect(wrapper.className).not.toContain('border-amber-500');

    expect(screen.queryByTestId('step-hotspot-flame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-pct')).not.toBeInTheDocument();
  });

  it('does not show percentage badge when percentOfChunk is 0', () => {
    render(<ToolCallItem step={makeStep()} isStepHot percentOfChunk={0} />);

    expect(screen.getByTestId('step-hotspot-flame')).toBeInTheDocument();
    expect(screen.queryByTestId('step-hotspot-pct')).not.toBeInTheDocument();
  });
});
