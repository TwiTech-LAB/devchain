import { render, screen } from '@testing-library/react';
import { BusyStatus, Spinner } from './spinner';

// Component spec: jsdom renders the class contract (animation, live region) more
// cheaply than any browser layer could assert it.

describe('Spinner', () => {
  it('is decorative: aria-hidden, spinning, stopped under reduced motion', () => {
    const { container } = render(<Spinner />);
    const spinner = container.querySelector('svg');
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
    expect(spinner).toHaveClass('h-4', 'w-4', 'animate-spin', 'motion-reduce:animate-none');
  });

  it('stays on the text line inside a plain paragraph', () => {
    const { container } = render(
      <p>
        <Spinner />
        Waiting…
      </p>,
    );
    expect(container.querySelector('svg')).toHaveClass('inline-block');
  });

  it('passes the caller className through', () => {
    const { container } = render(<Spinner className="h-3 w-3 text-primary" />);
    expect(container.querySelector('svg')).toHaveClass('h-3', 'w-3', 'text-primary');
  });
});

describe('BusyStatus', () => {
  it('announces the busy text politely while the spinner moves', () => {
    render(<BusyStatus>Updating the plan…</BusyStatus>);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Updating the plan…');
    expect(status).toHaveClass('inline-flex', 'gap-2');
    expect(status.tagName).toBe('P');
    expect(status.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the label a direct child so getByText keeps matching', () => {
    render(<BusyStatus>Saving…</BusyStatus>);
    expect(screen.getByText('Saving…')).toHaveRole('status');
  });

  it('spreads native paragraph attributes and className', () => {
    render(
      <BusyStatus data-testid="vm-busy" className="ml-2">
        Restoring…
      </BusyStatus>,
    );
    const status = screen.getByTestId('vm-busy');
    expect(status).toHaveClass('ml-2');
  });
});
