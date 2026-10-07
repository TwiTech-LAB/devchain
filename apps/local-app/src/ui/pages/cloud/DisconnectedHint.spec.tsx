import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DisconnectedHint } from './DisconnectedHint';

describe('DisconnectedHint', () => {
  it('calls onNavigateToAccount when button is clicked', async () => {
    const onNavigate = jest.fn();
    render(<DisconnectedHint onNavigateToAccount={onNavigate} />);

    await userEvent.click(screen.getByRole('button', { name: /Go to Account/i }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
