import type { ReplicaProviderSettingsRow } from '../../storage/interfaces/storage.interface';
import { providerSettingsRevision } from '../host/host-provider-settings-revision';
import { RemoteProviderSettingsService } from './remote-provider-settings.service';

// Layer: service unit with storage and the host client mocked. The payload, the push
// decision and its single flight live in this service; the VM side has its own spec.
describe('RemoteProviderSettingsService', () => {
  const sources = [
    {
      id: 'p-codex',
      name: 'codex',
      env: '{"B":"2","A":"1"}',
      autoCompactThreshold: null,
      claudeLaunchSettingsJson: null,
    },
    {
      id: 'p-broken',
      name: 'broken',
      env: '{"KEY": not json',
      autoCompactThreshold: 5,
      claudeLaunchSettingsJson: null,
    },
    {
      id: 'p-claude',
      name: 'claude',
      env: null,
      autoCompactThreshold: 80,
      claudeLaunchSettingsJson: '{}',
    },
  ];
  const expectedProviders: ReplicaProviderSettingsRow[] = [
    {
      providerName: 'claude',
      env: null,
      envScopes: {},
      auto_compact_threshold: 80,
      claude_launch_settings_json: '{}',
    },
    {
      providerName: 'codex',
      env: { B: '2', A: '1' },
      envScopes: { A: ['project-1'] },
      auto_compact_threshold: null,
      claude_launch_settings_json: null,
    },
  ];
  const expectedRevision = providerSettingsRevision(expectedProviders);
  let storage: {
    listRemoteProjectBindings: jest.Mock;
    listProviderSettingsSources: jest.Mock;
    listEnvScopesByProviderIds: jest.Mock;
  };
  let host: { getProviderSettingsStatus: jest.Mock; putProviderSettings: jest.Mock };
  let service: RemoteProviderSettingsService;

  beforeEach(() => {
    storage = {
      listRemoteProjectBindings: jest.fn().mockResolvedValue([
        { remoteId: 'vm', projectId: 'project-1', state: 'remote' },
        { remoteId: 'idle-vm', projectId: 'project-2', state: 'detaching' },
      ]),
      listProviderSettingsSources: jest.fn(() => sources),
      listEnvScopesByProviderIds: jest.fn(() => new Map([['p-codex', { A: ['project-1'] }]])),
    };
    host = {
      getProviderSettingsStatus: jest.fn().mockResolvedValue({ appliedRevision: null }),
      putProviderSettings: jest.fn().mockResolvedValue(undefined),
    };
    service = new RemoteProviderSettingsService(storage as never, host as never);
  });

  it("sends every parsable home provider, sorted by name, when the VM's revision differs", async () => {
    await service.pushIfChanged('vm');

    expect(host.putProviderSettings).toHaveBeenCalledWith('vm', {
      revision: expectedRevision,
      providers: expectedProviders,
    });
  });

  it('sends nothing when the VM already holds the same revision', async () => {
    host.getProviderSettingsStatus.mockResolvedValue({ appliedRevision: expectedRevision });

    await service.pushIfChanged('vm');

    expect(host.putProviderSettings).not.toHaveBeenCalled();
  });

  it('makes no host call for a VM without a project in state remote', async () => {
    await service.pushIfChanged('idle-vm');
    await service.pushIfChanged('unknown-vm');

    expect(host.getProviderSettingsStatus).not.toHaveBeenCalled();
    expect(host.putProviderSettings).not.toHaveBeenCalled();
  });

  it('keeps one push in flight per VM', async () => {
    let resolve!: (value: unknown) => void;
    host.getProviderSettingsStatus.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = service.pushIfChanged('vm');
    expect(service.pushIfChanged('vm')).toBe(first);
    // The status call starts after the binding read.
    await new Promise((done) => setImmediate(done));
    resolve({ appliedRevision: null });
    await first;
    expect(host.putProviderSettings).toHaveBeenCalledTimes(1);
  });

  it('contains a failure so the next poll retries', async () => {
    host.getProviderSettingsStatus.mockRejectedValueOnce(new Error('offline'));

    await expect(service.pushIfChanged('vm')).resolves.toBeUndefined();
    await service.pushIfChanged('vm');

    expect(host.putProviderSettings).toHaveBeenCalledTimes(1);
  });
});
