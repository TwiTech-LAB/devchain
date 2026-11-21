import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiFetch } from '@/ui/lib/api-transport';
import type { ManagedExclusionRow } from '@/modules/remotes/sync/remote-file-sync.dto';
import { InMemoryRemoteVmApi } from '../../../../test/helpers/in-memory-remote-vm-api';
import { FileSyncSettingsDialog } from './FileSyncSettingsDialog';
import { RemoteVmApiProvider } from './lib/remote-vm-api-context';

jest.mock('@/ui/lib/api-transport', () => ({ HOME_BACKEND: 'home', apiFetch: jest.fn() }));
jest.mock('@/ui/lib/toast-helpers', () => ({
  useToastHelpers: () => ({ showSuccess: jest.fn() }),
}));
const response = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

// The dialog joins cached server state with a revision captured when the user starts editing.
it('refreshes a cached list, rejects a stale draft, and shows removable automatic additions and the switch', async () => {
  let ignores = ['/current'];
  let revision = 1;
  let enabled = true;
  const puts: Array<{ ignores: string[]; revision: number }> = [];
  jest.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/managed-exclusions')) return response({ exclusions: [] });
    if (String(url).endsWith('/auto-fix')) {
      if (init?.method === 'PUT') enabled = JSON.parse(String(init.body)).enabled as boolean;
      return response({
        enabled,
        actions: [
          { at: '2026-10-05T12:00:00.000Z', kind: 'exclude', side: 'vm', patterns: ['/automatic'] },
          { at: '2026-10-05T12:01:00.000Z', kind: 'docker-exclusion-removed', patterns: ['/tmp'] },
          { at: '2026-10-05T12:02:00.000Z', kind: 'chown', side: 'home', paths: ['cache'] },
        ],
      });
    }
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { ignores: string[]; revision: number };
      puts.push(body);
      if (body.revision !== revision)
        return response(
          { message: 'The file list changed. Review it again.', code: 'FILE_SYNC_IGNORES_CHANGED' },
          409,
        );
      ignores = body.ignores;
      revision++;
      return response({
        ignores,
        revision,
        applied: true,
        message: 'Applied to the VM and this PC.',
      });
    }
    return response({ ignores, revision });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['home', 'file-sync-ignores', 'p'], { ignores: ['/cached'], revision: 0 });
  const onClose = jest.fn();
  render(
    <QueryClientProvider client={client}>
      <FileSyncSettingsDialog
        projectId="p"
        projectName="Project"
        remoteId="vm"
        busy={false}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Remove /current' });
  expect(screen.queryByRole('button', { name: 'Remove /cached' })).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Add a pattern'), '/manual');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  ignores = ['/current', '/automatic'];
  revision = 2;
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The file list changed. Review it again.',
  );
  await screen.findByRole('button', { name: 'Remove /automatic' });
  expect(puts[0]).toEqual({ ignores: ['/current', '/manual'], revision: 1 });
  expect(ignores).toEqual(['/current', '/automatic']);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByText(/Added automatically on .*: \/automatic/)).toBeInTheDocument();
  expect(screen.getByText(/Docker exclusion removed on .*: \/tmp/)).toBeInTheDocument();
  expect(screen.getByText(/Owner changed on .*: cache/)).toBeInTheDocument();
  const checkbox = screen.getByRole('checkbox', { name: 'Fix file sync problems automatically' });
  await userEvent.click(checkbox);
  await waitFor(() => expect(checkbox).not.toBeChecked());
  await userEvent.click(screen.getByRole('button', { name: 'Remove /automatic' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(puts[1]).toEqual({ ignores: ['/current'], revision: 2 });
});

it('keeps the draft when the save is refused for another reason, such as a running Force sync', async () => {
  jest.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).includes('/managed-exclusions')) return response({ exclusions: [] });
    if (String(url).endsWith('/auto-fix')) return response({ enabled: true, actions: [] });
    if (init?.method === 'PUT')
      return response(
        {
          message: 'Force sync is running for this project. Save the list after it finishes.',
          code: 'conflict',
        },
        409,
      );
    return response({ ignores: ['/current'], revision: 1 });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FileSyncSettingsDialog
        projectId="p"
        projectName="Project"
        busy={false}
        onClose={jest.fn()}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Remove /current' });
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/projects/p/file-sync/managed-exclusions',
    { signal: expect.any(AbortSignal) },
    { backend: 'home' },
  );
  await userEvent.type(screen.getByLabelText('Add a pattern'), '/manual');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Force sync is running for this project. Save the list after it finishes.',
  );
  expect(screen.getByRole('button', { name: 'Remove /manual' })).toBeInTheDocument();
});

// The dialog is the cheapest layer that verifies the API rows, reopen refresh and Save together.
it('shows the bound VM exclusions and refreshes the list on reopen', async () => {
  const api = new InMemoryRemoteVmApi();
  let answer!: (value: { exclusions: ManagedExclusionRow[] }) => void;
  api.overrides.readManagedExclusions = new Promise((resolve) => {
    answer = resolve;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (open: boolean) => (
    <QueryClientProvider client={client}>
      <RemoteVmApiProvider api={api}>
        {open && (
          <FileSyncSettingsDialog
            projectId="p"
            projectName="Project"
            remoteId="vm"
            busy={false}
            onClose={jest.fn()}
          />
        )}
      </RemoteVmApiProvider>
    </QueryClientProvider>
  );
  const view = render(tree(true));
  const section = screen.getByRole('region', { name: 'Docker data folders' });
  expect(within(section).getByRole('status')).toBeInTheDocument();
  const save = screen.getByRole('button', { name: 'Save' });
  await waitFor(() => expect(save).toBeEnabled());
  expect(api.calls.readManagedExclusions).toEqual([['p', 'vm', expect.any(AbortSignal)]]);
  answer({
    exclusions: [
      { pattern: '/cache', containers: ['worker', 'cron'], status: 'will-remove' },
      { pattern: '/old', containers: [], status: 'will-remove', remainingRule: '/old*' },
      {
        pattern: '/db',
        containers: ['old-db'],
        status: 'stays',
        reason: { kind: 'docker', side: 'compose', name: 'new-db' },
      },
      {
        pattern: '/logs',
        containers: ['init'],
        status: 'stays',
        reason: { kind: 'permissions', side: 'vm', owners: ['root', 'postgres'] },
      },
      {
        pattern: '/db/backups',
        containers: [],
        status: 'stays',
        reason: { kind: 'covered', by: '/db' },
      },
      {
        pattern: '/build',
        containers: ['builder'],
        status: 'stays',
        reason: { kind: 'unchecked', cause: 'home-mounts-unavailable' },
      },
    ],
  });
  const rows = await within(section).findAllByRole('listitem');
  expect(rows).toHaveLength(6);
  expect(rows[0]).toHaveTextContent(/\/cache.*worker, cron.*next Connect.*restart/);
  expect(rows[1]).toHaveTextContent(/\/old.*container unknown.*\/old\*.*still keeps/);
  expect(rows[2]).toHaveTextContent(/\/db.*old-db.*Stays out.*new-db.*Compose file/);
  expect(rows[3]).toHaveTextContent(/\/logs.*init.*Stays out.*the VM.*root, postgres/);
  expect(rows[4]).toHaveTextContent(/\/db\/backups.*Stays out.*folder \/db/);
  expect(rows[5]).toHaveTextContent(/\/build.*Stays out.*Could not read Docker mounts on this PC/);

  view.rerender(tree(false));
  api.overrides.readManagedExclusions = { exclusions: [] };
  view.rerender(tree(true));
  await waitFor(() => {
    expect(api.calls.readManagedExclusions).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Docker data folders' })).not.toBeInTheDocument();
  });
});
