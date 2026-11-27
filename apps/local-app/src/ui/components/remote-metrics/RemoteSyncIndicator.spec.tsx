import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type {
  FileSyncStatusScope,
  FileSyncVerdict,
} from '@/ui/pages/cloud/lib/remote-vm-contracts';
import { RemoteVmApiProvider } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import { syncScope } from '@/ui/pages/cloud/testing/file-sync-status.fixture';
import { InMemoryRemoteVmApi } from '../../../../test/helpers/in-memory-remote-vm-api';
import { RemoteSyncIndicator } from './RemoteSyncIndicator';
import { formatSampleTime } from './RemoteMetricsStrip';

// Component + hook over the in-memory API; the HTTP request itself is covered by remote-vm-http-api.spec.

const CHECKED_AT = '2026-11-24T19:00:00.000Z';

function scope(overrides: Partial<FileSyncStatusScope> = {}): FileSyncStatusScope {
  return syncScope({ remoteId: 'vm', files: 10, bytes: 1024, ...overrides });
}

function Location() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

function renderIndicator(api: InMemoryRemoteVmApi, cloudUiEnabled = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RemoteVmApiProvider api={api}>
        <MemoryRouter initialEntries={['/']}>
          <RemoteSyncIndicator projectId="p1" cloudUiEnabled={cloudUiEnabled} />
          <Location />
        </MemoryRouter>
      </RemoteVmApiProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function apiWith(...scopes: FileSyncStatusScope[]) {
  const api = new InMemoryRemoteVmApi();
  api.syncStatus = { ...api.syncStatus, checkedAt: CHECKED_AT, scopes };
  return api;
}

describe('RemoteSyncIndicator', () => {
  it.each<[FileSyncVerdict, string, string]>([
    ['in-sync', 'In sync', 'text-status-ok'],
    ['syncing', 'Syncing', 'text-primary'],
    ['waiting', 'Waiting', 'text-primary'],
    ['disconnected', 'Disconnected', 'text-status-warn'],
    ['problem', 'Problem', 'text-status-warn'],
    ['busy', 'Busy', 'text-muted-foreground'],
    ['unknown', 'Unknown', 'text-muted-foreground'],
  ])(
    'shows %s with its label and tone, animating only while syncing',
    async (verdict, label, tone) => {
      renderIndicator(apiWith(scope({ verdict })));
      const button = await screen.findByRole('button', { name: `File sync: ${label}` });
      expect(button).toHaveAttribute('data-verdict', verdict);
      expect(button).toHaveClass(tone);
      const icon = within(button).getByTestId('remote-sync-icon');
      if (verdict === 'syncing') expect(icon).toHaveClass('motion-safe:animate-spin');
      else expect(icon.getAttribute('class')).not.toMatch(/animate/);
    },
  );

  it('shows the pending counts, hides a zero count, and shows unknown for null values', async () => {
    const api = apiWith(
      scope({
        verdict: 'waiting',
        toVm: { items: 3, bytes: 2048 },
        fromVm: null,
        failed: { home: 2, vm: null },
        lastReceived: { path: 'src/a.ts', at: CHECKED_AT, deleted: false },
      }),
    );
    renderIndicator(api);
    const button = await screen.findByRole('button', { name: 'File sync: Waiting' });
    expect(within(button).getByTestId('remote-sync-to-vm')).toHaveTextContent('3');
    expect(within(button).queryByTestId('remote-sync-from-vm')).not.toBeInTheDocument();

    fireEvent.focus(button);
    // Radix renders a second, visually hidden role="tooltip" copy.
    const [tooltip] = await screen.findAllByTestId('remote-sync-tooltip');
    const lines = Array.from(tooltip.querySelectorAll('p')).map((line) => line.textContent);
    expect(lines).toEqual([
      'File sync: Waiting',
      'To the VM: 3 items, 2.0 KB',
      'From the VM: unknown',
      'Failed: 2 on this PC, unknown on the VM (last reported)',
      `Last received: src/a.ts at ${formatSampleTime(CHECKED_AT)}`,
      `Checked ${formatSampleTime(CHECKED_AT)}`,
    ]);
  });

  it('shows the reason and unknown for a missing last received file', async () => {
    renderIndicator(
      apiWith(scope({ verdict: 'disconnected', reason: 'No file sync connection to the VM.' })),
    );
    fireEvent.focus(await screen.findByRole('button', { name: 'File sync: Disconnected' }));
    const [tooltip] = await screen.findAllByTestId('remote-sync-tooltip');
    expect(tooltip).toHaveTextContent('No file sync connection to the VM.');
    expect(tooltip).toHaveTextContent('Last received: unknown');
  });

  it.each([true, false])(
    'opens the File sync tab on click only with the cloud UI (%s)',
    async (enabled) => {
      renderIndicator(apiWith(scope()), enabled);
      fireEvent.click(await screen.findByRole('button', { name: 'File sync: In sync' }));
      expect(screen.getByTestId('location')).toHaveTextContent(
        enabled ? '/cloud?section=remote-vm&tab=file-sync' : /^\/$/,
      );
    },
  );

  it.each<[string, (api: InMemoryRemoteVmApi) => void]>([
    [
      'the answer has no scope for the project',
      (api) => {
        api.syncStatus.scopes = [scope({ projectId: 'other' })];
      },
    ],
    [
      'the first read is still loading',
      (api) => {
        api.overrides.readSyncStatus = () => new Promise(() => undefined);
      },
    ],
  ])('renders nothing when %s', async (_case, arrange) => {
    const api = apiWith(scope());
    arrange(api);
    renderIndicator(api);
    await waitFor(() => expect(api.calls.readSyncStatus).toHaveLength(1));
    expect(api.calls.readSyncStatus[0]).toEqual([
      { projectId: 'p1', details: false },
      expect.anything(),
    ]);
    expect(screen.queryByTestId('remote-sync-indicator')).not.toBeInTheDocument();
  });

  it('hides a shown status once a read fails', async () => {
    const api = apiWith(scope());
    const queryClient = renderIndicator(api);
    expect(await screen.findByTestId('remote-sync-indicator')).toBeInTheDocument();
    api.overrides.readSyncStatus = async () => {
      throw new Error('down');
    };
    await queryClient.refetchQueries();
    await waitFor(() =>
      expect(screen.queryByTestId('remote-sync-indicator')).not.toBeInTheDocument(),
    );
  });
});
