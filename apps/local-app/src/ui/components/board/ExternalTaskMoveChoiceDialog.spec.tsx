import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { ExternalTaskMoveChoice } from '@/ui/hooks/board/useExternalTaskMove';
import { ExternalTaskMoveChoiceDialog } from './ExternalTaskMoveChoiceDialog';

const choice: ExternalTaskMoveChoice = {
  taskId: 'ENG-1',
  taskTitle: 'Ship moves',
  source: { taskId: 'ENG-1', columnKey: 'col-open' },
  target: {
    columnKey: 'col-done',
    name: 'Done',
    remoteId: null,
    remoteStatusIds: ['status-done'],
    synthetic: false,
  },
  options: [
    {
      actionValue: '31',
      actionLabel: 'Finish',
      remoteId: 'status-done',
      remoteStatusIds: ['status-done'],
      name: 'Done',
      color: '#36b37e',
      category: 'completed',
      position: 0,
    },
    {
      actionValue: '61',
      actionLabel: 'Fast-track',
      remoteId: 'status-done',
      remoteStatusIds: ['status-done'],
      name: 'Done',
      color: '#36b37e',
      category: 'completed',
      position: 1,
    },
  ],
};

describe('ExternalTaskMoveChoiceDialog', () => {
  it('lists every action with its destination and resolves the chosen option', async () => {
    const user = userEvent.setup();
    const onResolve = jest.fn();
    const { baseElement } = render(
      <ExternalTaskMoveChoiceDialog choice={choice} onResolve={onResolve} onCancel={jest.fn()} />,
    );

    expect(
      screen.getByRole('dialog', { name: 'Choose a move for Ship moves' }),
    ).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Actions leading to Done' });
    expect(group).toHaveTextContent('Finish');
    expect(group).toHaveTextContent('Fast-track (Done)');

    await user.click(screen.getByRole('button', { name: 'Fast-track (Done)' }));
    expect(onResolve).toHaveBeenCalledWith(choice.options[1]);

    expect(await axe(baseElement)).toHaveNoViolations();
  });

  it('disables every choice and blocks close actions while the move is pending', async () => {
    const user = userEvent.setup();
    const onResolve = jest.fn();
    const onCancel = jest.fn();
    render(
      <ExternalTaskMoveChoiceDialog
        choice={choice}
        pending
        onResolve={onResolve}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('group', { name: 'Actions leading to Done' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Moving task');
    expect(screen.getByRole('button', { name: 'Finish (Done)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Finish (Done)' }));
    await user.keyboard('{Escape}');

    expect(onResolve).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels without a write on Cancel and restores focus to the supplied target', async () => {
    const user = userEvent.setup();
    const onCancel = jest.fn();
    const onResolve = jest.fn();
    const card = document.createElement('button');
    document.body.appendChild(card);
    // Mirrors the page: cancel clears the choice, which closes the dialog and
    // runs Radix's close-time focus restoration.
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <ExternalTaskMoveChoiceDialog
          choice={choice}
          open={open}
          onResolve={onResolve}
          onCancel={() => {
            onCancel();
            setOpen(false);
          }}
          returnFocusTo={() => card}
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();
    await waitFor(() => expect(card).toHaveFocus());
    card.remove();
  });

  it('cancels on Escape without a write and restores focus', async () => {
    const user = userEvent.setup();
    const onCancel = jest.fn();
    const card = document.createElement('button');
    document.body.appendChild(card);
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <ExternalTaskMoveChoiceDialog
          choice={choice}
          open={open}
          onResolve={jest.fn()}
          onCancel={() => {
            onCancel();
            setOpen(false);
          }}
          returnFocusTo={() => card}
        />
      );
    }
    render(<Harness />);

    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(card).toHaveFocus());
    card.remove();
  });
});
