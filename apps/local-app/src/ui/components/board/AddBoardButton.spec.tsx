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
  it('names the selected project as the connection target', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AddBoardButton
          connections={[]}
          isLoading={false}
          onConnect={jest.fn()}
          projectName="Acme Project"
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Add board' }));

    expect(screen.getByText('Connect an external work board to Acme Project.')).toBeInTheDocument();
  });

  it('falls back to app copy when no project is selected', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <AddBoardButton
          connections={[]}
          isLoading={false}
          onConnect={jest.fn()}
          projectName={null}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Add board' }));

    expect(screen.getByText('Connect an external work board to this app.')).toBeInTheDocument();
  });
});
