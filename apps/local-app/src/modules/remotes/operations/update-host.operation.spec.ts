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
      step.run({ operation, details: { version: '2.0.0' } } as Parameters<typeof step.run>[0]),
    ).rejects.toMatchObject({ code: 'HOST_API_KEY_REJECTED' });
  });
});
