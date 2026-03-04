import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import {
  applyPresetWithHelper,
  doesProjectMatchPresetWithHelper,
  type ProjectPreset,
} from './project-presets.helpers';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('project-presets.helpers', () => {
  const projectId = 'project-1';

  let storage: {
    listAgents: jest.Mock;
    listProfileProviderConfigsByIds: jest.Mock;
    listAgentProfiles: jest.Mock;
    listProfileProviderConfigsByProfile: jest.Mock;
    updateAgent: jest.Mock;
  };

  let settings: {
    getProjectPresets: jest.Mock;
    setProjectActivePreset: jest.Mock;
  };

  beforeEach(() => {
    storage = {
      listAgents: jest.fn(),
      listProfileProviderConfigsByIds: jest.fn(),
      listAgentProfiles: jest.fn(),
      listProfileProviderConfigsByProfile: jest.fn(),
      updateAgent: jest.fn(),
    };

    settings = {
      getProjectPresets: jest.fn(),
      setProjectActivePreset: jest.fn().mockResolvedValue(undefined),
    };
  });

  describe('doesProjectMatchPresetWithHelper', () => {
    it('returns true when providerConfigName and modelOverride match', async () => {
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'cfg-1',
            modelOverride: 'openai/gpt-5',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByIds.mockResolvedValue([
        {
          id: 'cfg-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const result = await doesProjectMatchPresetWithHelper(
        projectId,
        {
          agentConfigs: [
            {
              agentName: 'Coder',
              providerConfigName: 'claude-config',
              modelOverride: 'openai/gpt-5',
            },
          ],
        },
        { storage: storage as unknown as StorageService },
      );

      expect(result).toBe(true);
    });

    it('detects drift when preset explicitly defines a different modelOverride', async () => {
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'cfg-1',
            modelOverride: null,
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByIds.mockResolvedValue([
        {
          id: 'cfg-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const result = await doesProjectMatchPresetWithHelper(
        projectId,
        {
          agentConfigs: [
            {
              agentName: 'Coder',
              providerConfigName: 'claude-config',
              modelOverride: 'openai/gpt-5',
            },
          ],
        },
        { storage: storage as unknown as StorageService },
      );

      expect(result).toBe(false);
    });

    it('returns false when agent has modelOverride but preset expects default (null)', async () => {
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'cfg-1',
            modelOverride: 'openai/gpt-5',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByIds.mockResolvedValue([
        {
          id: 'cfg-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const result = await doesProjectMatchPresetWithHelper(
        projectId,
        {
          agentConfigs: [
            {
              agentName: 'Coder',
              providerConfigName: 'claude-config',
              modelOverride: null,
            },
          ],
        },
        { storage: storage as unknown as StorageService },
      );

      expect(result).toBe(false);
    });

    it('returns true when preset omits modelOverride and agent has undefined modelOverride', async () => {
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'cfg-1',
            modelOverride: undefined,
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByIds.mockResolvedValue([
        {
          id: 'cfg-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const result = await doesProjectMatchPresetWithHelper(
        projectId,
        {
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        },
        { storage: storage as unknown as StorageService },
      );

      expect(result).toBe(true);
    });

    it('treats omitted modelOverride as "do not care" when agent has modelOverride', async () => {
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'cfg-1',
            modelOverride: 'openai/gpt-5',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByIds.mockResolvedValue([
        {
          id: 'cfg-1',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const result = await doesProjectMatchPresetWithHelper(
        projectId,
        {
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        },
        { storage: storage as unknown as StorageService },
      );

      expect(result).toBe(true);
    });
  });

  describe('applyPresetWithHelper', () => {
    it('sets modelOverride only when explicitly defined by preset', async () => {
      const preset: ProjectPreset = {
        name: 'default',
        description: 'Default',
        agentConfigs: [
          {
            agentName: 'Coder',
            providerConfigName: 'claude-config',
            modelOverride: 'openai/gpt-5',
          },
          {
            agentName: 'Reviewer',
            providerConfigName: 'gemini-config',
          },
        ],
      };

      settings.getProjectPresets.mockReturnValue([preset]);
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'old-cfg',
            modelOverride: null,
          },
          {
            id: 'agent-2',
            name: 'Reviewer',
            profileId: 'profile-1',
            providerConfigId: 'old-cfg',
            modelOverride: 'stale-model',
          },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });
      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: 'profile-1',
            projectId,
            name: 'Code Profile',
            providerId: 'provider-1',
            familySlug: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'cfg-claude',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'cfg-gemini',
          profileId: 'profile-1',
          providerId: 'provider-2',
          name: 'gemini-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.updateAgent.mockResolvedValue({} as never);

      const result = await applyPresetWithHelper(projectId, 'default', {
        storage: storage as unknown as StorageService,
        settings: settings as unknown as SettingsService,
      });

      expect(result).toEqual({ applied: 2, warnings: [] });
      expect(storage.updateAgent).toHaveBeenNthCalledWith(
        1,
        'agent-1',
        expect.objectContaining({
          providerConfigId: 'cfg-claude',
          modelOverride: 'openai/gpt-5',
        }),
      );
      const secondCallPayload = storage.updateAgent.mock.calls[1]?.[1] as
        | { providerConfigId: string; modelOverride?: string | null }
        | undefined;
      expect(secondCallPayload).toEqual(
        expect.objectContaining({
          providerConfigId: 'cfg-gemini',
        }),
      );
      expect(secondCallPayload).toEqual(
        expect.not.objectContaining({
          modelOverride: expect.anything(),
        }),
      );
      expect(settings.setProjectActivePreset).toHaveBeenCalledWith(projectId, 'default');
    });

    it('clears modelOverride when preset explicitly sets modelOverride to null', async () => {
      const preset: ProjectPreset = {
        name: 'default',
        description: 'Default',
        agentConfigs: [
          { agentName: 'Coder', providerConfigName: 'claude-config', modelOverride: null },
        ],
      };

      settings.getProjectPresets.mockReturnValue([preset]);
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'old-cfg',
            modelOverride: 'stale-model',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: 'profile-1',
            projectId,
            name: 'Code Profile',
            providerId: 'provider-1',
            familySlug: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: '',
            updatedAt: '',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'cfg-claude',
          profileId: 'profile-1',
          providerId: 'provider-1',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.updateAgent.mockResolvedValue({} as never);

      await applyPresetWithHelper(projectId, 'default', {
        storage: storage as unknown as StorageService,
        settings: settings as unknown as SettingsService,
      });

      expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', {
        providerConfigId: 'cfg-claude',
        modelOverride: null,
      });
    });
  });
});
