import { PROVIDER_CLI_NAMES } from '@devchain/shared';
import { RemoteProviderCliSettingsService } from './remote-provider-cli-settings.service';

describe('RemoteProviderCliSettingsService', () => {
  const settings = {
    getProviderCliVersions: jest.fn(() =>
      Object.fromEntries(
        PROVIDER_CLI_NAMES.map((name) => [name, { version: 'latest', homeManaged: false }]),
      ),
    ),
  };
  let host: {
    getProviderCliSettingsStatus: jest.Mock;
    putProviderCliSettings: jest.Mock;
    checkProviderClis: jest.Mock;
  };
  let service: RemoteProviderCliSettingsService;
  beforeEach(() => {
    host = {
      getProviderCliSettingsStatus: jest
        .fn()
        .mockResolvedValue({ pendingRevision: null, appliedRevision: null }),
      putProviderCliSettings: jest.fn().mockResolvedValue(undefined),
      checkProviderClis: jest.fn().mockResolvedValue(undefined),
    };
    service = new RemoteProviderCliSettingsService(settings as never, host as never);
  });
  it('allows only one policy exchange per VM and ignores already pending or applied revisions', async () => {
    let resolve!: (value: unknown) => void;
    host.getProviderCliSettingsStatus.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = service.pushIfChanged('vm');
    expect(service.pushIfChanged('vm')).toBe(first);
    resolve({ pendingRevision: null, appliedRevision: null });
    await first;
    expect(host.putProviderCliSettings).toHaveBeenCalledTimes(1);
    const body = host.putProviderCliSettings.mock.calls[0][1];
    for (const key of ['pendingRevision', 'appliedRevision']) {
      host.getProviderCliSettingsStatus.mockResolvedValue({ [key]: body.revision });
      await service.pushIfChanged('vm');
    }
    expect(host.putProviderCliSettings).toHaveBeenCalledTimes(1);
  });
  it('contains failures and retries next poll', async () => {
    host.getProviderCliSettingsStatus.mockRejectedValueOnce(new Error('offline'));
    await expect(service.pushIfChanged('vm')).resolves.toBeUndefined();
    await service.pushIfChanged('vm');
    expect(host.putProviderCliSettings).toHaveBeenCalledTimes(1);
    host.checkProviderClis.mockRejectedValueOnce(new Error('offline'));
    await expect(service.checkNow('vm')).resolves.toBeUndefined();
  });
  it('does not send a policy after shutdown during its status request', async () => {
    const pending = service.pushIfChanged('vm');
    service.onModuleDestroy();
    await pending;
    expect(host.putProviderCliSettings).not.toHaveBeenCalled();
  });
});
