import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProviderMismatchWarningModal } from './ProviderMismatchWarningModal';

describe('ProviderMismatchWarningModal', () => {
  const onNavigate = jest.fn();

  const warnings = [
    {
      type: 'provider_mismatch' as const,
      originalProvider: 'claude',
      substituteProvider: 'codex',
      agentNames: ['Agent A', 'Agent B'],
    },
  ];

  beforeEach(() => {
    onNavigate.mockClear();
  });

  it('renders warning content when open', () => {
    render(
      <ProviderMismatchWarningModal open={true} warnings={warnings} onNavigate={onNavigate} />,
    );

    expect(screen.getByText('Provider Mismatch Warning')).toBeInTheDocument();
    expect(screen.getByText('Missing: claude')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('Affected agents: Agent A, Agent B')).toBeInTheDocument();
  });

  it('does not render content when open is false', () => {
    render(
      <ProviderMismatchWarningModal open={false} warnings={warnings} onNavigate={onNavigate} />,
    );

    expect(screen.queryByText('Provider Mismatch Warning')).not.toBeInTheDocument();
  });

  it('calls onNavigate with /chat when Go to Chat is clicked', () => {
    render(
      <ProviderMismatchWarningModal open={true} warnings={warnings} onNavigate={onNavigate} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Go to Chat' }));

    expect(onNavigate).toHaveBeenCalledWith('/chat');
  });

  it('calls onNavigate with /board when Continue to Board is clicked', () => {
    render(
      <ProviderMismatchWarningModal open={true} warnings={warnings} onNavigate={onNavigate} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue to Board' }));

    expect(onNavigate).toHaveBeenCalledWith('/board');
  });

  it('renders multiple warnings', () => {
    render(
      <ProviderMismatchWarningModal
        open={true}
        warnings={[
          ...warnings,
          {
            type: 'provider_mismatch',
            originalProvider: 'gemini',
            substituteProvider: 'openai',
            agentNames: ['Agent C'],
          },
        ]}
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByText('Missing: claude')).toBeInTheDocument();
    expect(screen.getByText('Missing: gemini')).toBeInTheDocument();
    expect(screen.getByText('Affected agents: Agent C')).toBeInTheDocument();
  });
});
