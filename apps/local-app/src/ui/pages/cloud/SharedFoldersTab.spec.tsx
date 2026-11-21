import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InMemoryRemoteVmApi } from '../../../../test/helpers/in-memory-remote-vm-api';
import { RemoteVmApiProvider } from './lib/remote-vm-api-context';
import type { SharedFolderDto } from './lib/remote-vm-contracts';
import { SharedFoldersTab } from './SharedFoldersTab';

const HOME = '/home/devchain';

// Component tests: the dialogs' gates and the browser's navigation live in React state and
// the injected API; no cheaper layer renders them.
function setup(options: { blockedReason?: string | null; folders?: SharedFolderDto[] } = {}): {
  api: InMemoryRemoteVmApi;
  onOpenActivity: jest.Mock;
} {
  const api = new InMemoryRemoteVmApi();
  api.homePath = HOME;
  api.folderTree = {
    [HOME]: ['code', '.claude'],
    [`${HOME}/code`]: ['app'],
    [`${HOME}/code/app`]: [],
    [`${HOME}/.claude`]: ['skills'],
    [`${HOME}/.claude/skills`]: [],
  };
  api.folderLinks = [`${HOME}/code/app`];
  const onOpenActivity = jest.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RemoteVmApiProvider api={api}>
        <SharedFoldersTab
          remoteId="r1"
          vmName="vm-01"
          homePath={HOME}
          folders={options.folders ?? []}
          loading={false}
          error={null}
          blockedReason={options.blockedReason ?? null}
          onOpenActivity={onOpenActivity}
        />
      </RemoteVmApiProvider>
    </QueryClientProvider>,
  );
  return { api, onOpenActivity };
}

async function subfolders(): Promise<string[]> {
  const list = await screen.findByRole('list', { name: 'Subfolders' });
  return within(list)
    .getAllByRole('button')
    .map((button) => button.textContent ?? '');
}

describe('SharedFoldersTab', () => {
  it('browses folders under home and writes the chosen one into the path input', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Share a folder' }));
    const pathInput = screen.getByLabelText('Folder on this PC');

    // A typed folder under home opens first; Up opens its parent.
    await user.type(pathInput, '~/code');
    await user.click(screen.getByRole('button', { name: 'Browse…' }));
    expect(await subfolders()).toEqual(['app']);
    expect(screen.getByRole('button', { name: 'Link app' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Up' }));
    await waitFor(async () => expect(await subfolders()).toEqual(['code']));
    expect(screen.getByRole('button', { name: 'Up' })).toBeDisabled();

    // Hidden folders show on request; the breadcrumb opens a folder above.
    await user.click(screen.getByRole('switch', { name: 'Show hidden folders' }));
    await waitFor(async () => expect(await subfolders()).toEqual(['.claude', 'code']));
    await user.click(screen.getByRole('button', { name: '.claude' }));
    await waitFor(async () => expect(await subfolders()).toEqual(['skills']));
    await user.click(screen.getByRole('button', { name: 'skills' }));
    await screen.findByText('No subfolders.');
    await user.click(
      within(screen.getByRole('navigation', { name: 'Folder path' })).getByRole('button', {
        name: '.claude',
      }),
    );
    await waitFor(async () => expect(await subfolders()).toEqual(['skills']));
    await user.click(screen.getByRole('button', { name: 'Select this folder' }));
    expect(screen.queryByRole('dialog', { name: 'Choose a folder' })).not.toBeInTheDocument();
    expect(pathInput).toHaveValue(`${HOME}/.claude`);

    // Cancel leaves the input as it was.
    await user.click(screen.getByRole('button', { name: 'Browse…' }));
    await waitFor(async () => expect(await subfolders()).toEqual(['skills']));
    await user.click(screen.getByRole('button', { name: 'skills' }));
    await screen.findByText('No subfolders.');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(pathInput).toHaveValue(`${HOME}/.claude`);
  });

  it.each(['/srv/data', '~/missing'])(
    'opens the browser at home when the typed folder %s cannot be listed',
    async (typed) => {
      const user = userEvent.setup();
      const { api } = setup();
      await user.click(screen.getByRole('button', { name: 'Share a folder' }));
      await user.type(screen.getByLabelText('Folder on this PC'), typed);
      await user.click(screen.getByRole('button', { name: 'Browse…' }));
      await waitFor(async () => expect(await subfolders()).toEqual(['code']));
      expect(api.calls.listFolders.at(-1)?.[0]).toEqual({ showHidden: false });
    },
  );

  it('shows an unreadable folder as an error and lets the user go up', async () => {
    const user = userEvent.setup();
    const { api } = setup();
    api.overrides.listFolders = ({ path, showHidden }) => {
      if (path === `${HOME}/code`) throw new Error(`${HOME}/code cannot be read (EACCES).`);
      return api.defaults.listFolders(path ? { path, showHidden } : { showHidden }, signal());
    };
    await user.click(screen.getByRole('button', { name: 'Share a folder' }));
    await user.click(screen.getByRole('button', { name: 'Browse…' }));
    await user.click(await screen.findByRole('button', { name: 'code' }));
    expect(await screen.findByText(`${HOME}/code cannot be read (EACCES).`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select this folder' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Up' }));
    await waitFor(async () => expect(await subfolders()).toEqual(['code']));
  });

  it('keeps Share disabled until consent, shows a refusal under the path, then opens Activity', async () => {
    const user = userEvent.setup();
    const { api, onOpenActivity } = setup();
    await user.click(screen.getByRole('button', { name: 'Share a folder' }));
    await user.type(screen.getByLabelText('Folder on this PC'), '~/code');
    const share = screen.getByRole('button', { name: 'Share' });
    expect(screen.queryByRole('button', { name: 'Restore defaults' })).not.toBeInTheDocument();
    expect(share).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Replace and delete files in this folder on vm-01. DevChain keeps a backup on the VM.',
      }),
    );
    expect(share).toBeEnabled();

    api.overrides.shareFolder = new Error(
      'Cannot share /home/devchain/code: it overlaps a project.',
    );
    await user.click(share);
    expect(screen.getByLabelText('Folder on this PC')).toHaveAccessibleDescription(
      'Cannot share /home/devchain/code: it overlaps a project.',
    );
    expect(onOpenActivity).not.toHaveBeenCalled();

    delete api.overrides.shareFolder;
    await user.click(share);
    await waitFor(() => expect(onOpenActivity).toHaveBeenCalledWith('share-op'));
    expect(api.calls.shareFolder.at(-1)).toEqual(['r1', { path: `${HOME}/code`, ignores: [] }]);
  });

  it('disables Share a folder with the reason while the VM is not ready', () => {
    setup({ blockedReason: 'The VM is offline.' });
    expect(screen.getByRole('button', { name: 'Share a folder' })).toBeDisabled();
    expect(screen.getByText('The VM is offline.')).toBeInTheDocument();
  });

  it('keeps the edits after a refused pattern save and saves them on retry', async () => {
    const user = userEvent.setup();
    const folder: SharedFolderDto = {
      id: 'share-1',
      remoteId: 'r1',
      path: `${HOME}/code`,
      ignores: ['*.log'],
      patternsApplied: true,
      createdAt: '2026-11-17T00:00:00.000Z',
      state: { kind: 'in-sync' },
    };
    const { api } = setup({ folders: [folder] });
    api.sharedFoldersData = [{ ...folder }];
    api.overrides.saveSharedFolderIgnores = new Error('Saved, but the VM did not apply it.');

    await user.click(screen.getByRole('button', { name: 'Edit patterns' }));
    // Project defaults carry `(?d)` patterns, which delete on the VM; shares never offer them.
    expect(screen.queryByRole('button', { name: 'Restore defaults' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Add a pattern'), 'tmp');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Saved, but the VM did not apply it. Save again to retry.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove tmp' })).toBeInTheDocument();

    delete api.overrides.saveSharedFolderIgnores;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Edit patterns/ })).not.toBeInTheDocument(),
    );
    expect(api.calls.saveSharedFolderIgnores.at(-1)).toEqual(['r1', 'share-1', ['*.log', 'tmp']]);
  });
});

function signal(): AbortSignal {
  return new AbortController().signal;
}
