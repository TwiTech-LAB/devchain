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

describe('AddBoardButton project naming', () => {
  it.each([
    ['Acme Project', 'Acme Project'],
    [null, 'this app'],
  ] as const)('names the connection target for %s', async (projectName, label) => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AddBoardButton
          connections={[]}
          isLoading={false}
          onConnect={jest.fn()}
          projectName={projectName}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Add board' }));

    expect(screen.getByText(`Connect an external work board to ${label}.`)).toBeInTheDocument();
  });
});
