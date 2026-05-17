import { ProviderConfigsService } from './provider-configs.service';
import { SettingsService } from '../../settings/services/settings.service';
import { Agent, AgentProfile, ProfileProviderConfig } from '../../storage/models/domain.models';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('ProviderConfigsService', () => {
  let service: ProviderConfigsService;
  let storage: {
    getProfileProviderConfig: jest.Mock;
    updateProfileProviderConfig: jest.Mock;
    getAgentProfile: jest.Mock;
    listAgents: jest.Mock;
  };
  let settings: {
    renameProviderConfigInProjectPresets: jest.Mock;
    getAllProjectPresetsMap: jest.Mock;
  };

  const baseConfig: ProfileProviderConfig = {
    id: 'config-1',
    profileId: 'profile-1',
    providerId: 'provider-1',
    name: 'Old Config',
    description: null,
    options: null,
    env: null,
    position: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const projectProfile: AgentProfile = {
    id: 'profile-1',
    projectId: 'project-1',
    name: 'Coder',
    familySlug: null,
    systemPrompt: null,
    instructions: null,
    temperature: null,
    maxTokens: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    storage = {
      getProfileProviderConfig: jest.fn(),
      updateProfileProviderConfig: jest.fn(),
      getAgentProfile: jest.fn(),
      listAgents: jest.fn(),
    };
    settings = {
      renameProviderConfigInProjectPresets: jest.fn().mockResolvedValue(undefined),
      getAllProjectPresetsMap: jest.fn(),
    };
    service = new ProviderConfigsService(storage as never, settings as unknown as SettingsService);
  });

  function agent(overrides: Partial<Agent>): Agent {
    return {
      id: 'agent-1',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: 'config-1',
      modelOverride: null,
      name: 'Coder',
      description: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('updates the config without cascade when the trimmed name does not change', async () => {
    const updatedConfig = { ...baseConfig, name: ' Old Config ' };
    storage.getProfileProviderConfig.mockResolvedValue(baseConfig);
    storage.updateProfileProviderConfig.mockResolvedValue(updatedConfig);

    const result = await service.updateProviderConfig('config-1', { description: 'updated' });

    expect(result).toBe(updatedConfig);
    expect(storage.updateProfileProviderConfig).toHaveBeenCalledWith('config-1', {
      description: 'updated',
    });
    expect(storage.getAgentProfile).not.toHaveBeenCalled();
    expect(settings.renameProviderConfigInProjectPresets).not.toHaveBeenCalled();
  });

  it('cascades project-scoped profile renames to exactly that project with complete agent listing', async () => {
    const updatedConfig = { ...baseConfig, name: 'New Config' };
    const agents = [
      agent({ id: 'agent-1', name: 'Coder', profileId: 'profile-1' }),
      agent({ id: 'agent-2', name: 'Reviewer', profileId: 'profile-other' }),
    ];
    storage.getProfileProviderConfig.mockResolvedValue(baseConfig);
    storage.updateProfileProviderConfig.mockResolvedValue(updatedConfig);
    storage.getAgentProfile.mockResolvedValue(projectProfile);
    storage.listAgents.mockResolvedValue({ items: agents, total: 2, limit: 10000, offset: 0 });

    await service.updateProviderConfig('config-1', { name: 'New Config' });

    expect(storage.listAgents).toHaveBeenCalledWith('project-1', { limit: 10000, offset: 0 });
    expect(settings.renameProviderConfigInProjectPresets).toHaveBeenCalledWith('project-1', {
      profileId: 'profile-1',
      oldName: 'Old Config',
      newName: 'New Config',
      agents: [
        { name: 'Coder', profileId: 'profile-1' },
        { name: 'Reviewer', profileId: 'profile-other' },
      ],
    });
  });

  it('treats casing-only name changes as renames', async () => {
    const updatedConfig = { ...baseConfig, name: 'old config' };
    storage.getProfileProviderConfig.mockResolvedValue(baseConfig);
    storage.updateProfileProviderConfig.mockResolvedValue(updatedConfig);
    storage.getAgentProfile.mockResolvedValue(projectProfile);
    storage.listAgents.mockResolvedValue({
      items: [agent({ name: 'Coder' })],
      total: 1,
      limit: 10000,
      offset: 0,
    });

    await service.updateProviderConfig('config-1', { name: 'old config' });

    expect(settings.renameProviderConfigInProjectPresets).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        oldName: 'Old Config',
        newName: 'old config',
      }),
    );
  });

  it('scans preset project ids for global profiles and cascades only projects with affected agents', async () => {
    const globalProfile = { ...projectProfile, projectId: null };
    const updatedConfig = { ...baseConfig, name: 'New Config' };
    storage.getProfileProviderConfig.mockResolvedValue(baseConfig);
    storage.updateProfileProviderConfig.mockResolvedValue(updatedConfig);
    storage.getAgentProfile.mockResolvedValue(globalProfile);
    settings.getAllProjectPresetsMap.mockReturnValue(
      new Map([
        ['project-1', []],
        ['project-2', []],
        ['project-3', []],
      ]),
    );
    storage.listAgents
      .mockResolvedValueOnce({
        items: [agent({ id: 'agent-1', projectId: 'project-1', profileId: 'profile-1' })],
        total: 1,
        limit: 10000,
        offset: 0,
      })
      .mockResolvedValueOnce({
        items: [agent({ id: 'agent-2', projectId: 'project-2', profileId: 'profile-other' })],
        total: 1,
        limit: 10000,
        offset: 0,
      })
      .mockResolvedValueOnce({
        items: [agent({ id: 'agent-3', projectId: 'project-3', profileId: 'profile-1' })],
        total: 1,
        limit: 10000,
        offset: 0,
      });

    await service.updateProviderConfig('config-1', { name: 'New Config' });

    expect(storage.listAgents).toHaveBeenCalledTimes(3);
    expect(storage.listAgents).toHaveBeenNthCalledWith(1, 'project-1', {
      limit: 10000,
      offset: 0,
    });
    expect(storage.listAgents).toHaveBeenNthCalledWith(2, 'project-2', {
      limit: 10000,
      offset: 0,
    });
    expect(storage.listAgents).toHaveBeenNthCalledWith(3, 'project-3', {
      limit: 10000,
      offset: 0,
    });
    expect(settings.renameProviderConfigInProjectPresets).toHaveBeenCalledTimes(2);
    expect(settings.renameProviderConfigInProjectPresets).toHaveBeenNthCalledWith(
      1,
      'project-1',
      expect.objectContaining({ profileId: 'profile-1' }),
    );
    expect(settings.renameProviderConfigInProjectPresets).toHaveBeenNthCalledWith(
      2,
      'project-3',
      expect.objectContaining({ profileId: 'profile-1' }),
    );
  });

  it('logs and rethrows unexpected cascade failures after storage update', async () => {
    const failure = new Error('settings write failed');
    const updatedConfig = { ...baseConfig, name: 'New Config' };
    storage.getProfileProviderConfig.mockResolvedValue(baseConfig);
    storage.updateProfileProviderConfig.mockResolvedValue(updatedConfig);
    storage.getAgentProfile.mockResolvedValue(projectProfile);
    storage.listAgents.mockResolvedValue({
      items: [agent({ name: 'Coder' })],
      total: 1,
      limit: 10000,
      offset: 0,
    });
    settings.renameProviderConfigInProjectPresets.mockRejectedValue(failure);

    await expect(service.updateProviderConfig('config-1', { name: 'New Config' })).rejects.toThrow(
      failure,
    );

    expect(storage.updateProfileProviderConfig).toHaveBeenCalled();
  });
});
