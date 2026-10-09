import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NoticeBanner } from './NoticeBanner';

// A component test verifies accessible controls and consumer callbacks without a browser harness.
it('exposes polite status and supports actions, keyboard disclosure, and close', async () => {
  const user = userEvent.setup();
  const onSelect = jest.fn();
  const onClose = jest.fn();
  render(
    <NoticeBanner
      tone="info"
      message="Reminder"
      details={<a href="/details">Read details</a>}
      actions={[{ label: 'Acknowledge', onSelect }]}
      onClose={onClose}
      closeLabel="Close reminder"
    />,
  );
  const banner = within(screen.getByRole('status'));
  expect(banner.queryByRole('link')).not.toBeInTheDocument();
  await user.tab();
  expect(banner.getByRole('button', { name: 'Show' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(banner.getByRole('link', { name: 'Read details' })).toBeVisible();
  await user.keyboard(' ');
  expect(banner.queryByRole('link')).not.toBeInTheDocument();
  await user.click(banner.getByRole('button', { name: 'Acknowledge' }));
  expect(onSelect).toHaveBeenCalledTimes(1);
  await user.click(banner.getByRole('button', { name: 'Close reminder' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});
