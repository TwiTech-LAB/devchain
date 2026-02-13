import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AddCommunitySourceDialog,
  type AddCommunitySourceDialogSubmit,
} from './AddCommunitySourceDialog';

jest.mock('@radix-ui/react-dialog', () => {
  const actual = jest.requireActual('@radix-ui/react-dialog');
  return {
    ...actual,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

describe('AddCommunitySourceDialog', () => {
  it('submits community source payload in GitHub mode', async () => {
    const onSubmit = jest.fn(async (_input: AddCommunitySourceDialogSubmit) => undefined);
    const onOpenChange = jest.fn();

    render(
      <AddCommunitySourceDialog
        open
        isSubmitting={false}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText(/github url/i), {
      target: { value: 'https://github.com/example/repo-name' },
    });
    fireEvent.change(screen.getByLabelText(/source name/i), {
      target: { value: 'Repo-Name' },
    });
    fireEvent.change(screen.getByLabelText(/branch/i), {
      target: { value: 'develop' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^add source$/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        type: 'community',
        name: 'repo-name',
        url: 'https://github.com/example/repo-name',
        branch: 'develop',
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('switches to local mode and auto-suggests name from folder path', async () => {
    const onSubmit = jest.fn(async (_input: AddCommunitySourceDialogSubmit) => undefined);
    const onOpenChange = jest.fn();

    render(
      <AddCommunitySourceDialog
        open
        isSubmitting={false}
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /local folder/i }));

    fireEvent.change(screen.getByLabelText(/folder path/i), {
      target: { value: '/tmp/My Local_Source' },
    });

    expect(screen.getByLabelText(/source name/i)).toHaveValue('my-local-source');

    fireEvent.click(screen.getByRole('button', { name: /^add source$/i }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        type: 'local',
        name: 'my-local-source',
        folderPath: '/tmp/My Local_Source',
      });
    });
  });

  it('shows server validation error when local submit fails', async () => {
    const onSubmit = jest.fn(async (_input: AddCommunitySourceDialogSubmit) => {
      throw new Error('folderPath does not exist.');
    });

    render(
      <AddCommunitySourceDialog
        open
        isSubmitting={false}
        onOpenChange={jest.fn()}
        onSubmit={onSubmit}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /local folder/i }));
    fireEvent.change(screen.getByLabelText(/folder path/i), {
      target: { value: '/tmp/missing' },
    });
    fireEvent.change(screen.getByLabelText(/source name/i), {
      target: { value: 'missing-source' },
    });

    fireEvent.click(screen.getByRole('button', { name: /^add source$/i }));

    expect(await screen.findByText('folderPath does not exist.')).toBeInTheDocument();
  });
});
