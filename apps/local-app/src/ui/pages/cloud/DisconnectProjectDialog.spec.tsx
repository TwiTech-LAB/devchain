// Component layer: the option's visibility and the request it builds depend only on the
// sync-state answer, so the dialog is rendered alone with the transport mocked.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DockerSyncState } from '@/modules/remotes/docker/docker-copy-back.dto';
import { apiFetch } from '@/ui/lib/api-transport';
import { fileSyncFailures } from './testing/file-sync-failures.fixture';
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

function renderDialog(offline = false, force = false) {
  const onDisconnect = jest.fn();
  const onFixFileSync = jest.fn();
  const { unmount } = render(
    <QueryClientProvider client={new QueryClient()}>
      <DisconnectProjectDialog
        projectId="p1"
        projectName="Project One"
        remoteId="r1"
        remoteName="lab-vm"
        offline={offline}
        force={force}
        onFixFileSync={onFixFileSync}
        hostCursor={null}
        pending={false}
        onClose={jest.fn()}
        onDisconnect={onDisconnect}
      />
    </QueryClientProvider>,
  );
  return { onDisconnect, onFixFileSync, unmount };
}

const checkbox = () => screen.queryByRole('checkbox', { name: 'Copy Docker data back to this PC' });
/** The table row whose containers start with `name`. */
const row = (table: string, name: string) =>
  within(screen.getByRole('table', { name: table })).getByRole('row', {
    name: new RegExp(`^${name} `),
  });

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('DisconnectProjectDialog Docker copy home', () => {
  it('keeps Disconnect usable without a copy option when the VM user ids differ', async () => {
    mockApiFetch.mockResolvedValue(
      answer(
        syncState({
          availability: {
            available: false,
            side: 'remote',
            reason: { code: 'vm-user-mismatch', message: 'The user ids differ.' },
            userMismatch: { homeUid: 1000, homeGid: 1000, vmUid: 1001, vmGid: 1000 },
          },
          groups: [],
        }),
      ),
    );
    const { onDisconnect } = renderDialog();
    const note = await screen.findByRole('note', { name: 'Docker copy-back unavailable' });
    expect(note).toHaveTextContent(
      'Docker data is not copied back automatically, because the user ids differ (1000:1000 here, 1001:1000 on the VM). Copy what you need yourself, for example with a volume export and import.',
    );
    expect(checkbox()).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith(false, undefined);
  });

  it('offers the option off when the VM changed no data, and disconnects as before', async () => {
    mockApiFetch.mockResolvedValue(
      answer(
        syncState({
          groups: syncState().groups.map((group) => ({
            ...group,
            state: 'in-sync',
            needsChoice: false,
          })),
        }),
      ),
    );
    const { onDisconnect } = renderDialog();

    expect(await screen.findByRole('checkbox', { name: /Copy Docker data/ })).not.toBeChecked();
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/projects/p1/docker/sync-state',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ remoteId: 'r1' }) }),
      { backend: 'home' },
    );
    expect(screen.queryByText(/Docker data changed on the VM/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith(false, undefined);
  });

  it('ticks the option when the VM changed data, and names it when the user unticks it', async () => {
    mockApiFetch.mockResolvedValue(answer(syncState({ groups: syncState().groups.slice(0, 1) })));
    const { onDisconnect } = renderDialog();

    const option = await screen.findByRole('checkbox', { name: /Copy Docker data/ });
    expect(option).toBeChecked();
    expect(screen.getByText('1 of 1 data group copies home')).toBeInTheDocument();
    const copied = row('Docker data', 'app-db-1');
    expect(copied).toHaveTextContent('VM data changed');
    expect(copied).toHaveTextContent('Copied home');
    expect(copied).toHaveAttribute('data-marked', 'true');
    await userEvent.click(option);
    expect(screen.getByText('Without the copy, these changes stay on the VM:')).toBeInTheDocument();
    expect(row('Docker data that stays on the VM', 'app-db-1')).toHaveTextContent(
      'VM data changedStays on the VM',
    );
    expect(screen.queryByRole('table', { name: 'Docker data' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith(false, undefined);
  });

  it('requires a choice for both-changed groups and sends it', async () => {
    const inSync = {
      key: 'cccccccccccccccc',
      itemNames: ['cache-1'],
      volumes: ['cache'],
      bindPaths: [],
      state: 'in-sync' as const,
      needsChoice: false,
    };
    mockApiFetch.mockResolvedValue(answer(syncState({ groups: [inSync, ...syncState().groups] })));
    const { onDisconnect } = renderDialog();

    expect(await screen.findByRole('checkbox', { name: /Copy Docker data/ })).toBeChecked();
    expect(
      screen.getByText('1 of 3 data groups copies home; 1 needs your choice'),
    ).toBeInTheDocument();
    // Choices first, then VM changes in yellow, then the rest.
    const rows = within(screen.getByRole('table', { name: 'Docker data' })).getAllByRole('row');
    expect(rows.slice(1).map((r) => r.querySelector('th')?.textContent)).toEqual([
      'runner',
      'app-db-1',
      'cache-1',
    ]);
    expect(row('Docker data', 'runner')).toHaveAttribute('data-marked', 'true');
    expect(row('Docker data', 'cache-1')).toHaveTextContent('In syncNothing to copy');
    expect(row('Docker data', 'cache-1')).not.toHaveAttribute('data-marked');
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    await userEvent.click(screen.getByRole('combobox', { name: 'Choice for runner' }));
    await userEvent.click(await screen.findByRole('option', { name: "Keep this PC's data" }));
    expect(screen.getByText('1 of 3 data groups copies home')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith(false, {
      choices: { bbbbbbbbbbbbbbbb: 'keep-home' },
    });
  });

  it('waits for the Docker check before Disconnect', async () => {
    let reply: (response: Response) => void = () => {};
    mockApiFetch.mockImplementation((url) =>
      String(url).endsWith('/sync-state')
        ? new Promise<Response>((resolve) => {
            reply = resolve;
          })
        : Promise.resolve(answer(syncState({ groups: [] }))),
    );
    const { onDisconnect } = renderDialog();

    expect(await screen.findByText('Checking Docker data…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
    await act(async () => reply(answer(syncState({ groups: syncState().groups.slice(0, 1) }))));
    expect(await screen.findByRole('checkbox', { name: /Copy Docker data/ })).toBeChecked();
    expect(screen.queryByText('Checking Docker data…')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith(false, { choices: {} });
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
    for (const [response, failed] of [
      [
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
        false,
      ],
      [answer(syncState({ imported: false, groups: [] })), false],
      [answer(null, false), true],
    ] as const) {
      mockApiFetch.mockReset();
      mockApiFetch.mockResolvedValue(response);
      const { unmount } = renderDialog();
      await screen.findByRole('button', { name: 'Disconnect' });
      await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
      // Let the answer settle into the query before asserting the option stays hidden.
      await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
      expect(checkbox()).not.toBeInTheDocument();
      expect(screen.queryByText(/The Docker data check failed/) !== null).toBe(failed);
      unmount();
    }
  });
});

// Component layer keeps this optional check independent of the Disconnect action.
describe('DisconnectProjectDialog file sync failures', () => {
  it('opens Fix for failures without blocking Disconnect', async () => {
    mockApiFetch.mockImplementation(async (url) =>
      String(url).endsWith('/failed')
        ? answer(fileSyncFailures())
        : answer(syncState({ groups: [] })),
    );
    const { onDisconnect, onFixFileSync } = renderDialog();
    await screen.findByText(
      "2 files can't sync. Disconnect waits for them and stops after 30 minutes.",
    );
    await userEvent.click(screen.getByRole('button', { name: 'Fix file sync' }));
    expect(onFixFileSync).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith(false, undefined);
  });

  it.each(['offline', 'force'] as const)(
    'skips the failed-file check for %s disconnects',
    async (kind) => {
      mockApiFetch.mockResolvedValue(answer({ folders: null }));
      const { onDisconnect } = renderDialog(kind === 'offline', kind === 'force');
      await userEvent.click(screen.getByRole('button', { name: 'Force disconnect' }));
      expect(mockApiFetch.mock.calls.some(([url]) => String(url).endsWith('/failed'))).toBe(false);
      expect(screen.queryByRole('button', { name: 'Fix file sync' })).not.toBeInTheDocument();
      expect(onDisconnect).toHaveBeenCalledWith(true, undefined);
    },
  );

  it('keeps Disconnect available while the optional failed-file request is unresolved', async () => {
    mockApiFetch.mockImplementation(async (url) =>
      String(url).endsWith('/failed')
        ? new Promise<Response>(() => {})
        : answer(syncState({ groups: [] })),
    );
    const { onDisconnect } = renderDialog();
    // Only the Docker check holds Disconnect.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(onDisconnect).toHaveBeenCalledWith(false, undefined);
  });
});
