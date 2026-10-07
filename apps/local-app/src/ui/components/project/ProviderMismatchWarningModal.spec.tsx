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

    expect(screen.getByText('Missing: claude')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('Affected agents: Agent A, Agent B')).toBeInTheDocument();
  });

  it.each([
    {
      label: 'calls onNavigate with /chat when Go to Chat is clicked',
      buttonName: 'Go to Chat',
      path: '/chat',
    },
    {
      label: 'calls onNavigate with /board when Continue to Board is clicked',
      buttonName: 'Continue to Board',
      path: '/board',
    },
  ] as const)('$label', ({ buttonName, path }) => {
    render(
      <ProviderMismatchWarningModal open={true} warnings={warnings} onNavigate={onNavigate} />,
    );

    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    expect(onNavigate).toHaveBeenCalledWith(path);
  });

  it('renders multiple warnings', () => {
    render(
      <ProviderMismatchWarningModal
        open={true}
        warnings={[
          ...warnings,
          {
            type: 'provider_mismatch',
            originalProvider: 'codex',
            substituteProvider: 'openai',
            agentNames: ['Agent C'],
          },
        ]}
        onNavigate={onNavigate}
      />,
    );

    expect(screen.getByText('Missing: claude')).toBeInTheDocument();
    expect(screen.getByText('Missing: codex')).toBeInTheDocument();
    expect(screen.getByText('Affected agents: Agent C')).toBeInTheDocument();
  });
});
