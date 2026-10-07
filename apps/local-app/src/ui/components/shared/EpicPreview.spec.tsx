import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EpicPreview } from './EpicPreview';

const toastMock = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}));

describe('EpicPreview tags', () => {
  beforeEach(() => {
    toastMock.mockReset();
  });

  it('renders a merged: tag as an ordinary copyable tag chip, not a special badge', () => {
    render(<EpicPreview tags={['merged:feature-auth', 'priority:high']} />);

    expect(
      screen.getByRole('button', { name: 'Copy tag merged:feature-auth' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy tag priority:high' })).toBeInTheDocument();
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
