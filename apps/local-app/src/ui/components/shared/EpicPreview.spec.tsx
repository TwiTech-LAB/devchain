import { render, screen } from '@testing-library/react';
import { EpicPreview } from './EpicPreview';

describe('EpicPreview merged attribution', () => {
  it('renders merged: tag as a source badge', () => {
    render(<EpicPreview tags={['merged:feature-auth', 'priority:high']} />);

    expect(screen.getByText('Merged from feature-auth')).toBeInTheDocument();
    expect(screen.getByText('priority:high')).toBeInTheDocument();
    expect(screen.queryByText('merged:feature-auth')).not.toBeInTheDocument();
  });

  it('renders regular tags unchanged when no merged-from tag exists', () => {
    render(<EpicPreview tags={['priority:high']} />);

    expect(screen.getByText('priority:high')).toBeInTheDocument();
    expect(screen.queryByText(/Merged from/i)).not.toBeInTheDocument();
  });
});
