// Component layer: the option's visibility and the request it builds depend only on the
// sync-state answer, so the dialog is rendered alone with the transport mocked.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DockerSyncState } from '@/modules/remotes/docker/docker-copy-back.dto';
import { apiFetch } from '@/ui/lib/api-transport';
import { DisconnectProjectDialog } from './DisconnectProjectDialog';

jest.mock('@/ui/lib/api-transport', () => ({
  HOME_BACKEND: 'home',
  apiFetch: jest.fn(),
}));
const mockApiFetch = jest.mocked(apiFetch);

function syncState(overrides: Partial<DockerSyncState> = {}): DockerSyncState {
  return {
    availability: { available: true, side: null, reason: null },
    imported: true,
    groups: [
      {
        key: 'aaaaaaaaaaaaaaaa',
        itemNames: ['app-db-1'],
        volumes: ['app_db'],
        bindPaths: [],
        state: 'vm-newer',
        needsChoice: false,
      },
      {
        key: 'bbbbbbbbbbbbbbbb',
        itemNames: ['runner'],
        volumes: [],
        bindPaths: ['/home/u/p/state'],
        state: 'both-changed',
        needsChoice: true,
      },
    ],
    ...overrides,
  };
}

function answer(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

function renderDialog(offline = false) {
  const onDisconnect = jest.fn();
  const { unmount } = render(
    <QueryClientProvider client={new QueryClient()}>
      <DisconnectProjectDialog
        projectId="p1"
        projectName="Project One"
        remoteId="r1"
        remoteName="lab-vm"
        offline={offline}
        hostCursor={null}
        pending={false}
        onClose={jest.fn()}
        onDisconnect={onDisconnect}
      />
    </QueryClientProvider>,
  );
  return { onDisconnect, unmount };
}

const checkbox = () => screen.queryByRole('checkbox', { name: 'Copy Docker data back to this PC' });

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('DisconnectProjectDialog Docker copy home', () => {
  it('offers the option off by default and disconnects as before', async () => {
    mockApiFetch.mockResolvedValue(answer(syncState()));
    const { onDisconnect } = renderDialog();

    expect(await screen.findByRole('checkbox', { name: /Copy Docker data/ })).not.toBeChecked();
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/projects/p1/docker/sync-state',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ remoteId: 'r1' }) }),
      { backend: 'home' },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith(false, undefined);
  });

  it('requires a choice for both-changed groups and sends it', async () => {
    mockApiFetch.mockResolvedValue(answer(syncState()));
    const { onDisconnect } = renderDialog();

    await userEvent.click(await screen.findByRole('checkbox', { name: /Copy Docker data/ }));
    expect(screen.getByText('app-db-1: changed on the VM; copied home.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    await userEvent.click(screen.getByRole('combobox', { name: 'Choice for runner' }));
    await userEvent.click(await screen.findByRole('option', { name: "Keep this PC's data" }));
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith(false, {
      choices: { bbbbbbbbbbbbbbbb: 'keep-home' },
    });
  });

  it('hides the option on a forced disconnect', async () => {
    renderDialog(true);
    expect(await screen.findByRole('button', { name: 'Force disconnect' })).toBeInTheDocument();
    expect(checkbox()).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      '/api/projects/p1/docker/sync-state',
      expect.anything(),
      expect.anything(),
    );
  });

  it('hides the option when home Docker is unusable, nothing was imported, or the check failed', async () => {
    for (const response of [
      answer(
        syncState({
          availability: {
            available: false,
            side: 'home',
            reason: { code: 'unavailable', message: 'Home Docker is unavailable.' },
          },
          groups: [],
        }),
      ),
      answer(syncState({ imported: false, groups: [] })),
      answer(null, false),
    ]) {
      mockApiFetch.mockReset();
      mockApiFetch.mockResolvedValue(response);
      const { unmount } = renderDialog();
      await screen.findByRole('button', { name: 'Disconnect' });
      await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
      // Let the answer settle into the query before asserting the option stays hidden.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(checkbox()).not.toBeInTheDocument();
      unmount();
    }
  });
});
