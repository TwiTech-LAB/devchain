import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AddBoardButton } from './AddBoardButton';

describe('AddBoardButton managed subtask option', () => {
  it('shows the shared off-by-default option for a disconnected provider', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AddBoardButton connections={[]} isLoading={false} onConnect={jest.fn()} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Add board' }));
    await user.click(screen.getByRole('button', { name: 'Connect ClickUp' }));

    expect(
      screen.getByRole('switch', { name: 'Sync DevChain sub-epics as managed subtasks' }),
    ).not.toBeChecked();
  });
});
