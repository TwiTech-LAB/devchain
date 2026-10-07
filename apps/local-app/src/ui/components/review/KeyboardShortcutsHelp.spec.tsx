import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';

describe('KeyboardShortcutsHelp', () => {
  it('renders dialog when open', () => {
    render(<KeyboardShortcutsHelp open={true} onOpenChange={jest.fn()} />);

    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
  });

  it('calls onOpenChange when dialog is closed', async () => {
    const onOpenChange = jest.fn();
    render(<KeyboardShortcutsHelp open={true} onOpenChange={onOpenChange} />);

    // Find and click the close button
    const closeButton = screen.getByRole('button', { name: /close/i });
    await userEvent.click(closeButton);

    expect(onOpenChange).toHaveBeenCalled();
  });
});
