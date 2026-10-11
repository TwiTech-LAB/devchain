import { fireEvent, render, screen } from '@testing-library/react';
import { HelpButton } from './HelpButton';

jest.mock('./DocsViewer', () => ({
  DocsViewer: ({ open, slug }: { open: boolean; slug: string }) =>
    open ? <div role="dialog" aria-label={slug} /> : null,
}));

// A component rerender is the cheapest way to detect a change in the number of hooks.
it('handles an unknown feature between known features and can still open help', () => {
  window.localStorage.clear();
  const { rerender } = render(<HelpButton featureId="chat" />);
  expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();

  rerender(<HelpButton featureId="unknown-feature" />);
  expect(screen.queryByRole('button', { name: 'Help' })).not.toBeInTheDocument();

  rerender(<HelpButton featureId="chat" />);
  fireEvent.click(screen.getByRole('button', { name: 'Help' }));
  expect(screen.getByRole('dialog', { name: 'chat' })).toBeInTheDocument();
});
