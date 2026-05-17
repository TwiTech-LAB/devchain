import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DisconnectedHint } from './DisconnectedHint';

describe('DisconnectedHint', () => {
  it('renders Bell icon, body copy, and Go to Account button', () => {
    const onNavigate = jest.fn();
    render(<DisconnectedHint onNavigateToAccount={onNavigate} />);

    expect(
      screen.getByText('Sign in to DevChain Cloud to manage notifications.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go to Account/i })).toBeInTheDocument();
  });

  it('calls onNavigateToAccount when button is clicked', async () => {
    const onNavigate = jest.fn();
    render(<DisconnectedHint onNavigateToAccount={onNavigate} />);

    await userEvent.click(screen.getByRole('button', { name: /Go to Account/i }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
