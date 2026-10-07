import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForceSyncDialog } from './ForceSyncDialog';

// A component unit is the cheapest layer for source-dependent consent and pending form gates.
function renderDialog(pending = false) {
  const onForceSync = jest.fn();
  const onClose = jest.fn();
  const offer = { offered: true, reason: null, pending: { fromVm: 7, fromHome: 0 } };
  render(
    <ForceSyncDialog
      projectName="Project One"
      remoteName="lab-vm"
      offer={offer}
      pending={pending}
      onClose={onClose}
      onForceSync={onForceSync}
    />,
  );
  return { onForceSync, onClose };
}

it.each(['home', 'vm'] as const)(
  'requires an explicit source and loss consent before starting from %s',
  async (source) => {
    const { onForceSync } = renderDialog();
    expect(
      screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).checked),
    ).toBe(true);
    const start = screen.getByRole('button', { name: 'Force sync' });
    expect(start).toBeDisabled();
    const otherSide = source === 'home' ? 'the VM' : 'this PC';
    await userEvent.click(
      screen.getByRole('radio', {
        name: source === 'home' ? "Use this PC's files" : "Use the VM's files (lab-vm)",
      }),
    );
    expect(start).toBeDisabled();
    expect(screen.getByText(new RegExp(`Files on ${otherSide} that differ`))).toHaveTextContent(
      `Files that exist only on ${otherSide} are deleted.`,
    );
    expect(screen.getByText(/Ignored files stay/)).toHaveTextContent(
      `inside a folder that exists only on ${otherSide}`,
    );
    expect(screen.getByText(/DevChain keeps a copy/)).toHaveTextContent(
      `sync-backups in the DevChain folder on ${otherSide}`,
    );
    expect(screen.getByText(/has about/)).toHaveTextContent(
      source === 'home' ? 'The VM has about 7 changes' : 'This PC has about 0 changes',
    );
    await userEvent.click(start);
    expect(onForceSync).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('checkbox', { name: `Replace and delete files on ${otherSide}` }),
    );
    await userEvent.click(start);
    expect(onForceSync).toHaveBeenCalledWith(source);
  },
);

it('requires new consent when the losing side changes', async () => {
  const { onForceSync } = renderDialog();
  await userEvent.click(screen.getByRole('radio', { name: "Use this PC's files" }));
  await userEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('button', { name: 'Force sync' })).toBeEnabled();
  await userEvent.click(screen.getByRole('radio', { name: "Use the VM's files (lab-vm)" }));
  expect(
    screen.getByRole('checkbox', { name: 'Replace and delete files on this PC' }),
  ).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Force sync' })).toBeDisabled();
  expect(onForceSync).not.toHaveBeenCalled();
});

it('locks the form while the start is pending', async () => {
  const { onClose, onForceSync } = renderDialog(true);
  expect(
    screen
      .getAllByRole('radio')
      .every(
        (radio) => (radio as HTMLInputElement).disabled || !!radio.closest('fieldset[disabled]'),
      ),
  ).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).not.toHaveBeenCalled();
  expect(onForceSync).not.toHaveBeenCalled();
});
