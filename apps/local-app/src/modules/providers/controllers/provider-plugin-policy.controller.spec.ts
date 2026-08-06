import { ProviderPluginPolicyController } from './provider-plugin-policy.controller';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { ProviderPluginPolicyService } from '../services/provider-plugin-policy.service';

describe('ProviderPluginPolicyController', () => {
  let controller: ProviderPluginPolicyController;
  const policy = {
    resolveAll: jest.fn(),
    listConfigured: jest.fn(),
    setDefault: jest.fn(),
    resetDefault: jest.fn(),
    setProjectOverride: jest.fn(),
    resetProjectOverride: jest.fn(),
  };
  const storage = {
    getProject: jest.fn(),
    getProvider: jest.fn(),
    listProviders: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    policy.resolveAll.mockResolvedValue([]);
    policy.listConfigured.mockResolvedValue([]);
    policy.setDefault.mockResolvedValue({
      providerId: 'provider-1',
      pluginId: 'plugin@market',
      enabled: true,
      source: 'default',
    });
    policy.setProjectOverride.mockResolvedValue({
      providerId: 'provider-1',
      pluginId: 'plugin@market',
      enabled: false,
      source: 'project',
    });
    policy.resetDefault.mockResolvedValue(true);
    policy.resetProjectOverride.mockResolvedValue(true);
    storage.listProviders.mockResolvedValue({ items: [{ id: 'provider-1' }], total: 1 });
    controller = new ProviderPluginPolicyController(
      policy as unknown as ProviderPluginPolicyService,
      storage as unknown as StorageService,
    );
  });

  it('lists policies for every provider when only a project is supplied', async () => {
    await expect(controller.list({ projectId: 'project-1' })).resolves.toEqual({ items: [] });

    expect(storage.getProject).toHaveBeenCalledWith('project-1');
    expect(storage.listProviders).toHaveBeenCalledWith({ limit: 1_000, offset: 0 });
    expect(policy.listConfigured).toHaveBeenCalledWith('project-1', 'provider-1');
  });

  it('validates provider-scoped writes and project-scoped writes', async () => {
    await controller.setDefault({
      providerId: 'provider-1',
      pluginId: ' plugin@market ',
      enabled: true,
    });
    await controller.setProject({
      projectId: 'project-1',
      providerId: 'provider-1',
      pluginId: 'plugin@market',
      enabled: false,
    });

    expect(storage.getProvider).toHaveBeenCalledWith('provider-1');
    expect(policy.setDefault).toHaveBeenCalledWith('provider-1', 'plugin@market', true);
    expect(storage.getProject).toHaveBeenCalledWith('project-1');
    expect(policy.setProjectOverride).toHaveBeenCalledWith(
      'project-1',
      'provider-1',
      'plugin@market',
      false,
    );
  });

  it('resets default and project rules with exact scoped keys', async () => {
    await expect(
      controller.resetDefault({ providerId: 'provider-1', pluginId: 'plugin@market' }),
    ).resolves.toEqual({ deleted: true });
    await expect(
      controller.resetProject({
        projectId: 'project-1',
        providerId: 'provider-1',
        pluginId: 'plugin@market',
      }),
    ).resolves.toEqual({ deleted: true });

    expect(policy.resetDefault).toHaveBeenCalledWith('provider-1', 'plugin@market');
    expect(policy.resetProjectOverride).toHaveBeenCalledWith(
      'project-1',
      'provider-1',
      'plugin@market',
    );
  });

  it('rejects unknown fields and control characters', async () => {
    await expect(
      controller.setDefault({
        providerId: 'provider-1',
        pluginId: 'plugin@market',
        enabled: true,
        extra: true,
      }),
    ).rejects.toThrow();
    await expect(
      controller.resetDefault({ providerId: 'provider-1', pluginId: 'bad\nselector' }),
    ).rejects.toThrow();
  });
});
