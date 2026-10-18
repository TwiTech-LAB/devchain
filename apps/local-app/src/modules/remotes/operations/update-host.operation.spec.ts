import type { RemoteOperation } from '../../storage/models/domain.models';
import { UpdateHostOperation } from './update-host.operation';

// Layer: unit. The preflight reads only the health port, so a stubbed state proves
// the refusal without a host or a runner.
describe('UpdateHostOperation preflight', () => {
  it("refuses a VM that rejects this PC's API key", async () => {
    const health = {
      refresh: async () => ({ online: true, apiKeyRejected: true, version: '1.0.0' }),
    };
    const update = new UpdateHostOperation(health as never, {} as never, {} as never);
    const step = update.steps.find((definition) => definition.id === 'preflight')!;
    const operation = { id: 'op-update', remoteId: 'remote-1' } as RemoteOperation;

    await expect(
      step.run({ operation, details: { version: '2.0.0' }, progress: async () => undefined }),
    ).rejects.toMatchObject({ code: 'HOST_API_KEY_REJECTED' });
  });
});

// Layer: unit. The update step records an ignored registry; the failure message names it.
describe('UpdateHostOperation registry', () => {
  const operation = { id: 'op-update', remoteId: 'remote-1' } as RemoteOperation;
  const progress = async () => undefined;

  function makeUpdate(host: Record<string, unknown>) {
    const update = new UpdateHostOperation(
      {} as never,
      {} as never,
      host as never,
      {
        hostUpdateTimeoutMs: 1_000,
        pollIntervalMs: 1,
      } as never,
    );
    return (id: string) => update.steps.find((definition) => definition.id === id)!;
  }

  it('passes the saved registry and records that the host ignored it', async () => {
    const requestHostUpdate = jest
      .fn()
      .mockResolvedValue({ outcome: 'started', registryIgnored: true });
    const step = makeUpdate({
      remoteRuntime: async () => ({ version: '1.0.0' }),
      requestHostUpdate,
    })('update');
    const details: Record<string, unknown> = { version: '2.0.0', npmRegistry: 'http://lan.test/' };

    await step.run({ operation, details, progress });

    expect(requestHostUpdate).toHaveBeenCalledWith('remote-1', '2.0.0', 'http://lan.test/');
    expect(details.npmRegistryIgnored).toBe(true);
  });

  it.each([
    {
      npmRegistryIgnored: true,
      message:
        "The host could not install 2.0.0: ETARGET. This VM's version ignores HOST_NPM_REGISTRY and installed from its image's registry.",
    },
    { npmRegistryIgnored: undefined, message: 'The host could not install 2.0.0: ETARGET.' },
  ])(
    'words a failed update with ignored=$npmRegistryIgnored',
    async ({ npmRegistryIgnored, message }) => {
      const step = makeUpdate({
        remoteRuntime: async () => ({ version: '1.0.0' }),
        hostUpdateStatus: async () => ({ state: 'failed', version: '2.0.0', error: 'ETARGET' }),
      })('wait_healthy');

      await expect(
        step.run({ operation, details: { version: '2.0.0', npmRegistryIgnored }, progress }),
      ).rejects.toMatchObject({ code: 'HOST_UPDATE_FAILED', message });
    },
  );
});
