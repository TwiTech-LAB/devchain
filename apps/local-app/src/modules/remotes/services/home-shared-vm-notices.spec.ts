// Unit tests own cache/delivery policy; the two-instance suite covers the real transport and persistence.
import { RemoteForcedDetachService } from './remote-forced-detach.service';
import { HomeSharedVmNoticesService } from './home-shared-vm-notices.service';
import { RemoteHostRequestError } from '../operations/remote-host.client';
import type { ForcedDetachTombstone } from './remote-forced-detach.store';
import type { SharedVmNotice } from '../host/shared-vm.contract';

const REMOTE = 'abb0b8a8-6195-49a0-9df7-f21b887c29e7';
const NOTICE: SharedVmNotice = {
  id: 'd187041e-7209-4dca-afbc-ac077cdf0ca4',
  fromUser: 'owner',
  action: 'reset',
  message: 'Maintenance',
  at: '2026-10-12T15:00:00Z',
};

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function forcedService() {
  let rows: ForcedDetachTombstone[] = [{ remoteId: REMOTE, projectId: 'p' }];
  const store = {
    pending: (remoteId: string) => rows.filter((row) => row.remoteId === remoteId),
    record: async (remoteId: string, projectId: string) => {
      rows.push({ remoteId, projectId });
    },
    remove: async (remoteId: string, projectId: string) => {
      rows = rows.filter((row) => row.remoteId !== remoteId || row.projectId !== projectId);
    },
  };
  const host = { sharedVmAbandon: jest.fn().mockResolvedValue(undefined) };
  return { service: new RemoteForcedDetachService(store as never, host as never), store, host };
}

describe('forced Disconnect delivery policy', () => {
  it.each([400, 404, 409, 410, 422])('drops a tombstone refused with HTTP %s', async (status) => {
    const { service, store, host } = forcedService();
    host.sharedVmAbandon.mockRejectedValue(
      new RemoteHostRequestError('refused', {
        remoteId: REMOTE,
        path: '/abandon',
        status,
        hostCode: 'PROJECT_NOT_FOUND',
      }),
    );
    await service.flush(REMOTE);
    expect(store.pending(REMOTE)).toEqual([]);
  });

  it.each([null, 401, 403, 408, 429, 503])(
    'retains a tombstone after transport/auth/retryable failure %s',
    async (status) => {
      const { service, store, host } = forcedService();
      host.sharedVmAbandon.mockRejectedValue(
        new RemoteHostRequestError('unavailable', {
          remoteId: REMOTE,
          path: '/abandon',
          status,
          hostCode: null,
        }),
      );
      await service.flush(REMOTE);
      expect(store.pending(REMOTE)).toEqual([{ remoteId: REMOTE, projectId: 'p' }]);
      host.sharedVmAbandon.mockResolvedValue(undefined);
      await service.flush(REMOTE);
      expect(store.pending(REMOTE)).toEqual([]);
    },
  );

  it('joins concurrent flushes and sends tombstones recorded while delivery is in flight', async () => {
    const { service, store, host } = forcedService();
    const reply = gate<void>();
    host.sharedVmAbandon.mockReturnValue(reply.promise);
    const one = service.flush(REMOTE);
    await service.record(REMOTE, 'new-project');
    const two = service.flush(REMOTE);
    expect(host.sharedVmAbandon).toHaveBeenCalledTimes(1);
    reply.resolve();
    await Promise.all([one, two]);
    expect(host.sharedVmAbandon).toHaveBeenCalledTimes(2);
    expect(host.sharedVmAbandon).toHaveBeenLastCalledWith(REMOTE, 'new-project');
    expect(store.pending(REMOTE)).toEqual([]);
  });
});

describe('home notice cache', () => {
  function setup() {
    const host = {
      sharedVmNotices: jest.fn().mockResolvedValue([NOTICE]),
      sharedVmDismiss: jest.fn().mockResolvedValue(undefined),
    };
    const broadcaster = { broadcastEvent: jest.fn() };
    const forced = { flush: jest.fn().mockResolvedValue(undefined) };
    return {
      service: new HomeSharedVmNoticesService(host as never, forced as never, broadcaster),
      host,
      broadcaster,
    };
  }

  it('keeps a successful Dismiss from being undone by an older poll reply', async () => {
    const { service, host } = setup();
    await service.poll(REMOTE);
    const reply = gate<SharedVmNotice[]>();
    host.sharedVmNotices.mockReturnValue(reply.promise);
    const polling = service.poll(REMOTE);
    await service.dismiss(REMOTE, NOTICE.id);
    reply.resolve([NOTICE]);
    await polling;
    expect(service.list()).toEqual([]);
  });

  it('keeps notices when polling or dismissal fails and publishes successful changes', async () => {
    const { service, host, broadcaster } = setup();
    await service.poll(REMOTE);
    expect(broadcaster.broadcastEvent).toHaveBeenCalledWith('remotes', 'notices', {
      remoteId: REMOTE,
    });
    host.sharedVmNotices.mockRejectedValue(new Error('offline'));
    await service.poll(REMOTE);
    host.sharedVmDismiss.mockRejectedValue(new Error('offline'));
    await expect(service.dismiss(REMOTE, NOTICE.id)).rejects.toThrow('offline');
    expect(service.list()).toEqual([{ ...NOTICE, remoteId: REMOTE }]);
  });

  it('does not publish a late first poll after the remote has been removed', async () => {
    const { service, host } = setup();
    const reply = gate<SharedVmNotice[]>();
    host.sharedVmNotices.mockReturnValue(reply.promise);
    const polling = service.poll(REMOTE);
    service.prune(new Set());
    reply.resolve([NOTICE]);
    await polling;
    expect(service.list()).toEqual([]);
  });
});
