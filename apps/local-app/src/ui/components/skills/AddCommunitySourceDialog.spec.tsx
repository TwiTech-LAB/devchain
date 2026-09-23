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

const CURRENT_PROJECT = { id: '00000000-0000-0000-0000-0000000000aa', name: 'DevChain' };

describe('AddCommunitySourceDialog', () => {
  it('submits community source payload in GitHub mode', async () => {
    const onSubmit = jest.fn(async (_input: AddCommunitySourceDialogSubmit) => undefined);
    const onOpenChange = jest.fn();

    render(
      <AddCommunitySourceDialog
        open
        isSubmitting={false}
        currentProject={CURRENT_PROJECT}
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
        existingProjects: { mode: 'none' },
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
        currentProject={CURRENT_PROJECT}
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
        existingProjects: { mode: 'none' },
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
        currentProject={null}
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

  describe('existing projects choice', () => {
    const submitChoice = async (
      currentProject: { id: string; name: string } | null,
      radioLabel: RegExp,
    ): Promise<AddCommunitySourceDialogSubmit | null> => {
      const onSubmit = jest.fn(async (input: AddCommunitySourceDialogSubmit) => input);

      render(
        <AddCommunitySourceDialog
          open
          isSubmitting={false}
          currentProject={currentProject}
          onOpenChange={jest.fn()}
          onSubmit={onSubmit}
        />,
      );

      fireEvent.change(screen.getByLabelText(/github url/i), {
        target: { value: 'https://github.com/example/repo-name' },
      });
      fireEvent.change(screen.getByLabelText(/source name/i), {
        target: { value: 'repo-name' },
      });

      fireEvent.click(screen.getByRole('radio', { name: radioLabel }));

      fireEvent.click(screen.getByRole('button', { name: /^add source$/i }));

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
      });
      return onSubmit.mock.calls[0][0];
    };

    it('defaults to keep disabled and shows the current-project option with a project', async () => {
      render(
        <AddCommunitySourceDialog
          open
          isSubmitting={false}
          currentProject={CURRENT_PROJECT}
          onOpenChange={jest.fn()}
          onSubmit={jest.fn(async () => undefined)}
        />,
      );

      expect(screen.getByRole('radio', { name: /keep disabled/i })).toBeChecked();
      expect(
        screen.getByRole('radio', { name: `Enable in ${CURRENT_PROJECT.name}` }),
      ).not.toBeChecked();
      expect(
        screen.getByRole('radio', { name: /enable in all existing projects/i }),
      ).not.toBeChecked();
    });

    it('omits the current-project option when no project is selected', () => {
      render(
        <AddCommunitySourceDialog
          open
          isSubmitting={false}
          currentProject={null}
          onOpenChange={jest.fn()}
          onSubmit={jest.fn(async () => undefined)}
        />,
      );

      expect(screen.queryByRole('radio', { name: `Enable in ${CURRENT_PROJECT.name}` })).toBeNull();
      expect(screen.getByRole('radio', { name: /keep disabled/i })).toBeChecked();
      expect(
        screen.getByRole('radio', { name: /enable in all existing projects/i }),
      ).toBeInTheDocument();
    });

    it('submits the selected choice with the current project id', async () => {
      const submitted = await submitChoice(CURRENT_PROJECT, /enable in devchain/i);

      expect(submitted).toMatchObject({
        existingProjects: { mode: 'selected', projectIds: [CURRENT_PROJECT.id] },
      });
    });

    it('submits the all choice', async () => {
      const submitted = await submitChoice(CURRENT_PROJECT, /enable in all existing projects/i);

      expect(submitted).toMatchObject({ existingProjects: { mode: 'all' } });
    });
  });
});
