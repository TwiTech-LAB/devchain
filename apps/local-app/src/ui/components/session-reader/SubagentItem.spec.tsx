import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubagentItem } from './SubagentItem';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';

function makeStep(overrides: Partial<SerializedSemanticStep> = {}): SerializedSemanticStep {
  return {
    id: 'step-sub-1',
    type: 'subagent',
    startTime: '2026-02-24T12:00:00.000Z',
    durationMs: 5000,
    content: {
      subagentId: 'process-0',
      subagentDescription: 'Explore codebase for auth patterns',
      sourceModel: 'claude-sonnet-4-6',
    },
    tokens: { input: 2000, output: 1500 },
    context: 'main',
    ...overrides,
  };
}

describe('SubagentItem', () => {
  it('renders collapsed trigger with description', () => {
    render(<SubagentItem step={makeStep()} />);
    const trigger = screen.getByTestId('subagent-trigger');
    expect(trigger).toHaveTextContent('Explore codebase for auth patterns');
  });

  it('shows duration in trigger', () => {
    render(<SubagentItem step={makeStep()} />);
    expect(screen.getByText('5.0s')).toBeInTheDocument();
  });

  it('expands to show details on click', () => {
    render(<SubagentItem step={makeStep()} />);

    // Details hidden initially
    expect(screen.queryByTestId('subagent-details')).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByTestId('subagent-trigger'));
    const details = screen.getByTestId('subagent-details');
    expect(details).toBeInTheDocument();
    expect(details).toHaveTextContent('claude-sonnet-4-6');
    expect(details).toHaveTextContent('3.5k');
    expect(details).toHaveTextContent('5.0s');
  });

  it('shows model in details', () => {
    render(<SubagentItem step={makeStep()} />);
    fireEvent.click(screen.getByTestId('subagent-trigger'));
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet-4-6')).toBeInTheDocument();
  });

  it('shows token count in details', () => {
    render(<SubagentItem step={makeStep()} />);
    fireEvent.click(screen.getByTestId('subagent-trigger'));
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('3.5k')).toBeInTheDocument();
  });

  it('uses fallback description when none provided', () => {
    render(<SubagentItem step={makeStep({ content: { subagentId: 'p-0' } })} />);
    expect(screen.getByTestId('subagent-trigger')).toHaveTextContent('Subagent task');
  });

  it('hides model row when no model', () => {
    render(
      <SubagentItem
        step={makeStep({ content: { subagentDescription: 'Test', subagentId: 'p-0' } })}
      />,
    );
    fireEvent.click(screen.getByTestId('subagent-trigger'));
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
  });
});
