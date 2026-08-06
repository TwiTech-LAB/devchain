import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProviderPluginPolicyService } from './provider-plugin-policy.service';

describe('ProviderPluginPolicyService', () => {
  let service: ProviderPluginPolicyService;
  let storage: {
    upsertProviderPluginDefault: jest.Mock;
    getProviderPluginDefault: jest.Mock;
    listProviderPluginDefaults: jest.Mock;
    deleteProviderPluginDefault: jest.Mock;
    upsertProjectProviderPluginOverride: jest.Mock;
    getProjectProviderPluginOverride: jest.Mock;
    listProjectProviderPluginOverrides: jest.Mock;
    deleteProjectProviderPluginOverride: jest.Mock;
  };

  beforeEach(async () => {
    storage = {
      upsertProviderPluginDefault: jest.fn(),
      getProviderPluginDefault: jest.fn(),
      listProviderPluginDefaults: jest.fn(),
      deleteProviderPluginDefault: jest.fn(),
      upsertProjectProviderPluginOverride: jest.fn(),
      getProjectProviderPluginOverride: jest.fn(),
      listProjectProviderPluginOverrides: jest.fn(),
      deleteProjectProviderPluginOverride: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProviderPluginPolicyService, { provide: STORAGE_SERVICE, useValue: storage }],
    }).compile();
    service = module.get(ProviderPluginPolicyService);
  });

  it('returns a project override without reading the provider default', async () => {
    storage.getProjectProviderPluginOverride.mockResolvedValue({
      projectId: 'project-1',
      providerId: 'provider-1',
      pluginId: 'plugin@market',
      enabled: false,
    });

    await expect(service.resolve('project-1', 'provider-1', 'plugin@market')).resolves.toEqual({
      providerId: 'provider-1',
      pluginId: 'plugin@market',
      enabled: false,
      source: 'project',
    });
    expect(storage.getProviderPluginDefault).not.toHaveBeenCalled();
  });

  it('falls back to the provider default and otherwise returns absence', async () => {
    storage.getProjectProviderPluginOverride.mockResolvedValue(null);
    storage.getProviderPluginDefault.mockResolvedValueOnce({
      providerId: 'provider-1',
      pluginId: 'plugin@market',
      enabled: true,
    });

    await expect(service.resolve('project-1', 'provider-1', 'plugin@market')).resolves.toEqual({
      providerId: 'provider-1',
      pluginId: 'plugin@market',
      enabled: true,
      source: 'default',
    });

    storage.getProviderPluginDefault.mockResolvedValueOnce(null);
    await expect(service.resolve('project-1', 'provider-1', 'missing@market')).resolves.toBeNull();
  });

  it('resolves all DB rows with project precedence and deterministic ordering', async () => {
    storage.listProviderPluginDefaults.mockResolvedValue([
      { providerId: 'provider-1', pluginId: 'zeta@market', enabled: true },
      { providerId: 'provider-1', pluginId: 'alpha@market', enabled: false },
    ]);
    storage.listProjectProviderPluginOverrides.mockResolvedValue([
      {
        projectId: 'project-1',
        providerId: 'provider-1',
        pluginId: 'zeta@market',
        enabled: false,
      },
    ]);

    await expect(service.resolveAll('project-1', 'provider-1')).resolves.toEqual([
      {
        providerId: 'provider-1',
        pluginId: 'alpha@market',
        enabled: false,
        source: 'default',
      },
      {
        providerId: 'provider-1',
        pluginId: 'zeta@market',
        enabled: false,
        source: 'project',
      },
    ]);
  });

  it('lists default and project rows separately for policy management', async () => {
    storage.listProviderPluginDefaults.mockResolvedValue([
      { providerId: 'provider-1', pluginId: 'plugin@market', enabled: true },
    ]);
    storage.listProjectProviderPluginOverrides.mockResolvedValue([
      {
        projectId: 'project-1',
        providerId: 'provider-1',
        pluginId: 'plugin@market',
        enabled: false,
      },
    ]);

    await expect(service.listConfigured('project-1', 'provider-1')).resolves.toEqual([
      {
        providerId: 'provider-1',
        pluginId: 'plugin@market',
        enabled: true,
        source: 'default',
      },
      {
        providerId: 'provider-1',
        pluginId: 'plugin@market',
        enabled: false,
        source: 'project',
      },
    ]);
  });

  it('upserts exact opaque IDs at both scopes after trimming boundary whitespace', async () => {
    storage.upsertProviderPluginDefault.mockImplementation(async (row) => row);
    storage.upsertProjectProviderPluginOverride.mockImplementation(async (row) => row);

    await expect(service.setDefault('provider-1', '  Name@Marketplace  ', true)).resolves.toEqual({
      providerId: 'provider-1',
      pluginId: 'Name@Marketplace',
      enabled: true,
      source: 'default',
    });
    await expect(
      service.setProjectOverride('project-1', 'provider-1', 'future:opaque/id', false),
    ).resolves.toEqual({
      providerId: 'provider-1',
      pluginId: 'future:opaque/id',
      enabled: false,
      source: 'project',
    });
  });

  it('resets a stale syntactically-valid ID without catalog access', async () => {
    storage.deleteProviderPluginDefault.mockResolvedValue(true);
    storage.deleteProjectProviderPluginOverride.mockResolvedValue(true);

    await expect(service.resetDefault('provider-1', 'removed-plugin@old-market')).resolves.toBe(
      true,
    );
    await expect(
      service.resetProjectOverride('project-1', 'provider-1', 'removed-plugin@old-market'),
    ).resolves.toBe(true);
    expect(storage.deleteProviderPluginDefault).toHaveBeenCalledWith(
      'provider-1',
      'removed-plugin@old-market',
    );
    expect(storage.deleteProjectProviderPluginOverride).toHaveBeenCalledWith(
      'project-1',
      'provider-1',
      'removed-plugin@old-market',
    );
  });

  it.each(['   ', 'valid\u0000invalid', 'x'.repeat(513)])(
    'rejects syntactically invalid plugin ID %p',
    async (pluginId) => {
      await expect(service.resetDefault('provider-1', pluginId)).rejects.toThrow(ValidationError);
    },
  );

  it('counts Unicode code points for the 512-character limit', async () => {
    const pluginId = '🔌'.repeat(512);
    storage.deleteProviderPluginDefault.mockResolvedValue(false);

    await expect(service.resetDefault('provider-1', pluginId)).resolves.toBe(false);
    expect(storage.deleteProviderPluginDefault).toHaveBeenCalledWith('provider-1', pluginId);
  });
});
