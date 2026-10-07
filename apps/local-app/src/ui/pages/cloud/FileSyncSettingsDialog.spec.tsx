import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiFetch } from '@/ui/lib/api-transport';
import { FileSyncSettingsDialog } from './FileSyncSettingsDialog';

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
    if (String(url).endsWith('/auto-fix')) {
      if (init?.method === 'PUT') enabled = JSON.parse(String(init.body)).enabled as boolean;
      return response({
        enabled,
        actions: [
          { at: '2026-10-05T12:00:00.000Z', kind: 'exclude', side: 'vm', patterns: ['/automatic'] },
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
        connected
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
        connected
        busy={false}
        onClose={jest.fn()}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Remove /current' });
  await userEvent.type(screen.getByLabelText('Add a pattern'), '/manual');
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Force sync is running for this project. Save the list after it finishes.',
  );
  expect(screen.getByRole('button', { name: 'Remove /manual' })).toBeInTheDocument();
});
