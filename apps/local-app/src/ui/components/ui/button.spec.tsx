import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './button';

// Component spec: jsdom is the cheapest layer that can observe the DOM contract
// (disabled, aria-busy, no leaked props, Slot child untouched).

describe('Button pending', () => {
  it('shows the spinner, disables itself and stays aria-busy while pending', () => {
    render(<Button pending>Save changes</Button>);

    const button = screen.getByRole('button', { name: 'Save changes' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('never leaks the pending prop into the DOM', () => {
    render(<Button pending>Save</Button>);

    expect(screen.getByRole('button')).not.toHaveAttribute('pending');
  });

  it('a pending button wins over disabled={false}', () => {
    render(
      <Button pending disabled={false}>
        Save
      </Button>,
    );

    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('renders exactly as before without pending', async () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button.querySelector('svg')).toBeNull();
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forwards its ref to the native button', () => {
    const ref = jest.fn();
    render(<Button ref={ref}>Save</Button>);

    expect(ref).toHaveBeenCalledWith(screen.getByRole('button'));
  });

  it('under asChild renders the child link unchanged and ignores pending', () => {
    render(
      <Button asChild pending>
        <a href="https://example.com">Open guide</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Open guide' });
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).not.toHaveAttribute('aria-busy');
    expect(link).not.toHaveAttribute('disabled');
    expect(link.querySelector('svg')).toBeNull();
  });
});
