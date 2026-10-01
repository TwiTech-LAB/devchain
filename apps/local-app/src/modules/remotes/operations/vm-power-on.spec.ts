import { VmOperationsService } from './vm-operations.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

const REMOTE = {
  id: 'r1',
  kind: 'proxmox',
  vmProviderConnectionId: 'pc1',
  vmIdentity: '00000000-0000-4000-8000-000000000150',
};

function service(refresh: jest.Mock) {
  const lifecycle = { start: jest.fn().mockResolvedValue(undefined) };
  const provider = { assertOwnedVmIdentity: jest.fn().mockResolvedValue(150) };
  const vmOperations = new VmOperationsService(
    { getRemote: jest.fn().mockResolvedValue(REMOTE) } as never,
    {} as never,
    { assertNoOpenHostOperation: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    { forConnection: jest.fn().mockResolvedValue(provider) } as never,
    lifecycle as never,
    { refresh } as never,
  );
  return { vmOperations, lifecycle };
}

// Service unit: the health refresh is a side effect the HTTP answer must not wait for;
// the route spec covers the Proxmox calls.
describe('VmOperationsService.powerOn health refresh', () => {
  it('answers after the start without waiting for the refresh', async () => {
    const refresh = jest.fn(() => new Promise(() => undefined));
    const { vmOperations, lifecycle } = service(refresh);

    await expect(vmOperations.powerOn('r1')).resolves.toEqual({ powerState: 'running' });

    expect(lifecycle.start).toHaveBeenCalledWith('pc1', 150);
    expect(refresh).toHaveBeenCalledWith('r1');
    expect(lifecycle.start.mock.invocationCallOrder[0]).toBeLessThan(
      refresh.mock.invocationCallOrder[0],
    );
  });

  it('still answers when the refresh fails', async () => {
    const refresh = jest.fn().mockRejectedValue(new Error('VM still booting'));
    await expect(service(refresh).vmOperations.powerOn('r1')).resolves.toEqual({
      powerState: 'running',
    });
  });
});
