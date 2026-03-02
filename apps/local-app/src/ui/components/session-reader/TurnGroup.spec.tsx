import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SerializedTurn } from '@/ui/hooks/useSessionTranscript';
import {
  formatDuration,
  formatTimestamp,
  formatTokensCompact as formatTokens,
} from '@/ui/utils/session-reader-formatters';
import { TurnGroup } from './TurnGroup';

function makeTurn(overrides: Partial<SerializedTurn> = {}): SerializedTurn {
  return {
    id: 'turn-a1',
    assistantMessageId: 'a1',
    model: 'claude-sonnet-4-6',
    timestamp: '2026-02-24T12:00:00.000Z',
    steps: [
      {
        id: 'step-output-1',
        type: 'output',
        startTime: '2026-02-24T12:00:00.000Z',
        durationMs: 0,
        content: { outputText: 'Final answer from turn' },
        context: 'main',
      },
    ],
    summary: {
      thinkingCount: 1,
      toolCallCount: 0,
      subagentCount: 0,
      outputCount: 2,
    },
    tokens: { input: 1200, output: 400, cached: 100 },
    durationMs: 1500,
    ...overrides,
  };
}

describe('TurnGroup (deprecated legacy component)', () => {
  it('still renders legacy turn header metadata with non-zero counts only', () => {
    const turn = makeTurn();
    render(<TurnGroup turn={turn} />);

    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
    expect(screen.getByText('1 thinking, 2 outputs')).toBeInTheDocument();
    expect(screen.queryByText(/0 tool calls/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 subagents/)).not.toBeInTheDocument();
    expect(screen.getByText(formatTokens(1700))).toBeInTheDocument();
    expect(screen.getByText(formatDuration(1500))).toBeInTheDocument();
    expect(screen.getByText(formatTimestamp(turn.timestamp))).toBeInTheDocument();
  });

  it('still renders semantic steps through shared SemanticStepList when expanded', () => {
    const turn = makeTurn();
    render(<TurnGroup turn={turn} />);

    expect(screen.queryByText('Final answer from turn')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('turn-group-trigger'));

    expect(screen.getByTestId('semantic-step-list')).toBeInTheDocument();
    expect(screen.getByText('Final answer from turn')).toBeInTheDocument();
  });
});
