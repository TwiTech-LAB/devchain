import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { TranscriptDisclosureProvider, useTranscriptDisclosure } from './useTranscriptDisclosure';

function Block({ id }: { id: string }) {
  const [open, setOpen] = useTranscriptDisclosure(id);
  return (
    <button data-testid={id} aria-expanded={open} onClick={() => setOpen(!open)}>
      {id}
    </button>
  );
}

function Rows({ scope, mounted }: { scope: string; mounted: string[] }) {
  return (
    <TranscriptDisclosureProvider scope={scope}>
      {mounted.map((id) => (
        <Block key={id} id={id} />
      ))}
    </TranscriptDisclosureProvider>
  );
}

describe('useTranscriptDisclosure', () => {
  it('keeps state across unmount and remount inside the provider and resets on scope change', () => {
    const view = render(<Rows scope="session-1" mounted={['a', 'b']} />);
    fireEvent.click(screen.getByTestId('a'));
    expect(screen.getByTestId('a')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('b')).toHaveAttribute('aria-expanded', 'false');

    view.rerender(<Rows scope="session-1" mounted={['b']} />);
    view.rerender(<Rows scope="session-1" mounted={['a', 'b']} />);
    expect(screen.getByTestId('a')).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByTestId('a'));
    expect(screen.getByTestId('a')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByTestId('a'));

    view.rerender(<Rows scope="session-2" mounted={['a', 'b']} />);
    expect(screen.getByTestId('a')).toHaveAttribute('aria-expanded', 'false');

    view.rerender(<Rows scope="session-1" mounted={['a', 'b']} />);
    expect(screen.getByTestId('a')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByTestId('a'));
    view.rerender(<Rows scope="session-1" mounted={['b']} />);
    view.rerender(<Rows scope="session-1" mounted={['a', 'b']} />);
    expect(screen.getByTestId('a')).toHaveAttribute('aria-expanded', 'true');
  });

  it('falls back to local state without a provider', () => {
    const view = render(<Block id="a" />);
    fireEvent.click(screen.getByTestId('a'));
    expect(screen.getByTestId('a')).toHaveAttribute('aria-expanded', 'true');

    view.unmount();
    render(<Block id="a" />);
    expect(screen.getByTestId('a')).toHaveAttribute('aria-expanded', 'false');
  });
});
