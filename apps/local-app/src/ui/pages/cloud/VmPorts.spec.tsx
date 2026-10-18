import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InMemoryRemoteVmApi } from '../../../../test/helpers/in-memory-remote-vm-api';
import { RemoteVmApiProvider } from './lib/remote-vm-api-context';
import { VmPorts, devchainPort } from './VmPorts';
import { remoteSyncthingDeviceQueryKey } from './lib/remote-vm-query-keys';

// Component tests exercise the wire address and query lifecycle with an injected API.
describe('VM ports', () => {
  it.each(['tcp://0.0.0.0:24001', 'tcp://[::]:24001'])(
    'shows the TCP listen port from %s and keeps the queried instance explicit',
    async (address) => {
      const api = new InMemoryRemoteVmApi();
      api.overrides.readSyncthingDevice = { deviceId: 'device', address };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const tree = (enabled: boolean) => (
        <QueryClientProvider client={client}>
          <RemoteVmApiProvider api={api}>
            <VmPorts remoteId="r2" port={3001} enabled={enabled} />
          </RemoteVmApiProvider>
        </QueryClientProvider>
      );
      const view = render(tree(true));
      await waitFor(() =>
        expect(screen.getByLabelText('Syncthing listen port')).toHaveTextContent('24001'),
      );
      expect(screen.getByLabelText('DevChain port')).toHaveTextContent('3001');
      expect(screen.getByRole('region', { name: 'VM ports' })).toHaveTextContent(
        'Allow TCP 3001 and 24001 from this PC.',
      );
      expect(api.calls.readSyncthingDevice[0][0]).toBe('r2');
      view.rerender(tree(false));
      expect(screen.getByLabelText('Syncthing listen port')).toHaveTextContent('Unknown');
    },
  );

  it.each([null, 'not-an-address', 'udp://vm:24001', 'tcp://vm:0'])(
    'keeps an unavailable or unusable listen address unknown: %p',
    async (address) => {
      const api = new InMemoryRemoteVmApi();
      api.overrides.readSyncthingDevice = address ? { deviceId: 'device', address } : null;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(
        remoteSyncthingDeviceQueryKey('r2'),
        address ? { deviceId: 'device', address } : null,
      );
      render(
        <QueryClientProvider client={client}>
          <RemoteVmApiProvider api={api}>
            <VmPorts remoteId="r2" port={3001} enabled />
          </RemoteVmApiProvider>
        </QueryClientProvider>,
      );
      expect(screen.getByLabelText('Syncthing listen port')).toHaveTextContent('Unknown');
    },
  );

  it.each([
    ['https://vm:3001', 3001],
    ['https://[::1]:3002', 3002],
    ['https://vm', 443],
    [null, null],
    ['invalid', null],
  ])('reads the DevChain port from %p', (address, port) => {
    expect(devchainPort(address)).toBe(port);
  });
});
