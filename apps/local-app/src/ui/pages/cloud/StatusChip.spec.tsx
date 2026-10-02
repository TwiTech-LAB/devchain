import { render, screen } from '@testing-library/react';
import { StatusChip } from './StatusChip';

// Component spec: the tone-to-DOM contract (spinner presence, label as a direct
// child) is fully observable in jsdom.

describe('StatusChip', () => {
  it('spins next to the label while work runs', () => {
    render(<StatusChip tone="running">Starting…</StatusChip>);

    const label = screen.getByText('Starting…');
    const spinner = label.querySelector('svg');
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    expect(spinner).toHaveClass('h-3', 'w-3');
  });

  it.each(['ok', 'warn', 'error', 'neutral', 'info'] as const)(
    'the %s tone shows no spinner',
    (tone) => {
      render(<StatusChip tone={tone}>Done</StatusChip>);

      expect(screen.getByText('Done').querySelector('svg')).toBeNull();
    },
  );
});
