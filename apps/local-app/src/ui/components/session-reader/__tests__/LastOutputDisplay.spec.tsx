import { render, screen } from '@testing-library/react';
import { LastOutputDisplay } from '../LastOutputDisplay';

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

  it('shows placeholder for null output when session is live', () => {
    const { rerender } = render(<LastOutputDisplay lastOutput={null} isLive={true} />);

    expect(screen.getByTestId('last-output-placeholder')).toHaveTextContent('No output yet');

    rerender(<LastOutputDisplay lastOutput={null} isLive={false} />);
    expect(screen.queryByTestId('last-output-placeholder')).not.toBeInTheDocument();
  });
});
