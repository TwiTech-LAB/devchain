import { PROVIDER_USAGE_SETTINGS_DEFAULTS } from '@devchain/shared';
import { providerUsageSettingsRevision } from '../host/host-provider-usage-revision';
import { RemoteProviderUsageSettingsService } from './remote-provider-usage-settings.service';

// Layer: service unit with the host client mocked. The push decision and its
// single flight live in this service; the transport has its own client tests.
describe('RemoteProviderUsageSettingsService', () => {
  const homeSettings = { ...PROVIDER_USAGE_SETTINGS_DEFAULTS, tokenCheckMinutes: 0 };
  const settings = { getProviderUsageConfig: jest.fn(() => homeSettings) };
  let host: { getProviderUsageSettingsStatus: jest.Mock; putProviderUsageSettings: jest.Mock };
  let service: RemoteProviderUsageSettingsService;

  beforeEach(() => {
    host = {
      getProviderUsageSettingsStatus: jest.fn().mockResolvedValue({ appliedRevision: 'other' }),
      putProviderUsageSettings: jest.fn().mockResolvedValue(undefined),
    };
    service = new RemoteProviderUsageSettingsService(settings as never, host as never);
  });

  it("sends home's settings when the VM runs other values", async () => {
    await service.pushIfChanged('vm');
    expect(host.putProviderUsageSettings).toHaveBeenCalledWith('vm', {
      revision: providerUsageSettingsRevision(homeSettings),
      settings: homeSettings,
    });
  });

  it('sends nothing when the VM already runs the same revision', async () => {
    host.getProviderUsageSettingsStatus.mockResolvedValue({
      appliedRevision: providerUsageSettingsRevision(homeSettings),
    });
    await service.pushIfChanged('vm');
    expect(host.putProviderUsageSettings).not.toHaveBeenCalled();
  });

  it('keeps one push in flight per VM', async () => {
    let resolve!: (value: unknown) => void;
    host.getProviderUsageSettingsStatus.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = service.pushIfChanged('vm');
    expect(service.pushIfChanged('vm')).toBe(first);
    resolve({ appliedRevision: null });
    await first;
    expect(host.putProviderUsageSettings).toHaveBeenCalledTimes(1);
  });

  it('contains a failure so the next poll retries', async () => {
    host.getProviderUsageSettingsStatus.mockRejectedValueOnce(new Error('offline'));
    await expect(service.pushIfChanged('vm')).resolves.toBeUndefined();
    await service.pushIfChanged('vm');
    expect(host.putProviderUsageSettings).toHaveBeenCalledTimes(1);
  });
});
