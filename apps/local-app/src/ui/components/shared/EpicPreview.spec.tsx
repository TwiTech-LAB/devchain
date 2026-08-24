import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EpicPreview } from './EpicPreview';

const toastMock = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}));

describe('EpicPreview merged attribution', () => {
  beforeEach(() => {
    toastMock.mockReset();
  });

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

  it('keeps tags on one compact row with full hover values and overflow names', () => {
    render(
      <EpicPreview
        tags={['Phase', 'Phase:20', 'Plan:EstimatedAgentTime', 'TimeTracking', 'Events']}
      />,
    );

    const tagRow = screen.getByRole('button', { name: 'Copy tag Phase' }).parentElement;
    expect(tagRow).toHaveClass('flex-nowrap', 'overflow-hidden');
    expect(
      screen.getByRole('button', { name: 'Copy tag Plan:EstimatedAgentTime' }),
    ).toHaveAttribute('title', 'Plan:EstimatedAgentTime');
    expect(screen.getByText('+2')).toHaveAttribute('title', 'TimeTracking, Events');
  });

  it('copies the full tag and confirms the action', async () => {
    const user = userEvent.setup();
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<EpicPreview tags={['Plan:EstimatedAgentTime']} />);

    await user.click(screen.getByRole('button', { name: 'Copy tag Plan:EstimatedAgentTime' }));

    expect(writeText).toHaveBeenCalledWith('Plan:EstimatedAgentTime');
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Tag copied',
        description: 'Plan:EstimatedAgentTime',
      }),
    );
  });
});
