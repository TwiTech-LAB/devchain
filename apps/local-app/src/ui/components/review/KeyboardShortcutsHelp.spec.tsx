import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';

describe('KeyboardShortcutsHelp', () => {
  it('renders dialog when open', () => {
    render(<KeyboardShortcutsHelp open={true} onOpenChange={jest.fn()} />);

    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
  });

  it('does not render content when closed', () => {
    render(<KeyboardShortcutsHelp open={false} onOpenChange={jest.fn()} />);

    expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument();
  });

  it('displays all keyboard shortcuts', () => {
    render(<KeyboardShortcutsHelp open={true} onOpenChange={jest.fn()} />);

    expect(screen.getByText('Next file')).toBeInTheDocument();
    expect(screen.getByText('Previous file')).toBeInTheDocument();
    expect(screen.getByText('Next comment')).toBeInTheDocument();
    expect(screen.getByText('Previous comment')).toBeInTheDocument();
    expect(screen.getByText('Add comment on selected line')).toBeInTheDocument();
    expect(screen.getByText('Reply to focused comment')).toBeInTheDocument();
    expect(screen.getByText('Close dialog / Clear selection')).toBeInTheDocument();
    expect(screen.getByText('Submit comment')).toBeInTheDocument();
    expect(screen.getByText('Show keyboard shortcuts')).toBeInTheDocument();
  });

  it('displays key badges', () => {
    render(<KeyboardShortcutsHelp open={true} onOpenChange={jest.fn()} />);

    expect(screen.getByText('j')).toBeInTheDocument();
    expect(screen.getByText('k')).toBeInTheDocument();
    expect(screen.getByText('n')).toBeInTheDocument();
    expect(screen.getByText('p')).toBeInTheDocument();
    expect(screen.getByText('c')).toBeInTheDocument();
    expect(screen.getByText('r')).toBeInTheDocument();
    expect(screen.getByText('Escape')).toBeInTheDocument();
  });

  it('calls onOpenChange when dialog is closed', async () => {
    const onOpenChange = jest.fn();
    render(<KeyboardShortcutsHelp open={true} onOpenChange={onOpenChange} />);

    // Find and click the close button
    const closeButton = screen.getByRole('button', { name: /close/i });
    await userEvent.click(closeButton);

    expect(onOpenChange).toHaveBeenCalled();
  });

  it('shows help hint at bottom', () => {
    render(<KeyboardShortcutsHelp open={true} onOpenChange={jest.fn()} />);

    expect(screen.getByText(/anytime to show this help/)).toBeInTheDocument();
  });
});
