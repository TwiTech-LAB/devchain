import Database from 'better-sqlite3';
import type { SettingsService } from '../../settings/services/settings.service';
import { PresetSettingsDelegate } from '../../settings/local/delegates/preset-settings.delegate';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import {
  applyAgentConfigs,
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
    it('applies a preset successfully after provider config rename cascade rewrites the stored config name', async () => {
      const db = new Database(':memory:');
      db.exec(`
        CREATE TABLE settings (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const presetDelegate = new PresetSettingsDelegate({ sqlite: db });

      try {
        await presetDelegate.setProjectPresets(projectId, [
          {
            name: 'default',
            description: 'Default',
            agentConfigs: [
              {
                agentName: 'Coder',
                providerConfigName: 'Old Config',
                modelOverride: 'openai/gpt-5',
              },
            ],
          },
        ]);
        await presetDelegate.renameProviderConfigInProjectPresets(projectId, {
          profileId: 'profile-1',
          oldName: 'Old Config',
          newName: 'New Config',
          agents: [{ name: 'Coder', profileId: 'profile-1' }],
        });

        storage.listAgents.mockResolvedValue({
          items: [
            {
              id: 'agent-1',
              name: 'Coder',
              profileId: 'profile-1',
              providerConfigId: 'old-cfg',
              modelOverride: null,
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
              familySlug: null,
              instructions: null,
              temperature: null,
              maxTokens: null,
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
            id: 'cfg-new',
            profileId: 'profile-1',
            providerId: 'provider-1',
            name: 'New Config',
            options: null,
            env: null,
            createdAt: '',
            updatedAt: '',
          },
        ]);
        storage.updateAgent.mockResolvedValue({} as never);

        const result = await applyPresetWithHelper(projectId, 'default', {
          storage: storage as unknown as StorageService,
          settings: {
            getProjectPresets: (id: string) => presetDelegate.getProjectPresets(id),
            setProjectActivePreset: settings.setProjectActivePreset,
          } as unknown as SettingsService,
        });

        expect(result).toEqual({ applied: 1, warnings: [] });
        expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', {
          providerConfigId: 'cfg-new',
          modelOverride: 'openai/gpt-5',
        });
        expect(settings.setProjectActivePreset).toHaveBeenCalledWith(projectId, 'default');
      } finally {
        db.close();
      }
    });

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
            providerConfigName: 'agy-config',
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
          id: 'cfg-agy',
          profileId: 'profile-1',
          providerId: 'provider-2',
          name: 'agy-config',
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
          providerConfigId: 'cfg-agy',
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

  describe('applyAgentConfigs (shared inner loop)', () => {
    // agentName(lowercased) -> agentId, and buildProviderConfigLookupKey(profileId, name) -> configId
    const nameMaps = {
      agentNameToId: new Map([['coder', 'agent-1']]),
      configLookupMap: new Map([['profile-1:claude-config', 'cfg-claude']]),
    };

    const mockAgentsList = (agent: Record<string, unknown>) => {
      storage.listAgents.mockResolvedValue({
        items: [{ id: 'agent-1', name: 'Coder', profileId: 'profile-1', ...agent }],
        total: 1,
        limit: 1000,
        offset: 0,
      });
    };

    it('resolves the provider config via configLookupMap and preserves overrides when omitted (undefined)', async () => {
      mockAgentsList({
        providerConfigId: 'old-cfg',
        modelOverride: 'keep-me',
        effortOverride: 'low',
      });
      storage.updateAgent.mockResolvedValue({} as never);

      const result = await applyAgentConfigs(
        projectId,
        [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        { storage: storage as unknown as StorageService },
        nameMaps,
      );

      expect(result).toEqual({ applied: 1, warnings: [] });
      // Only providerConfigId is written; model/effort omitted → existing values preserved.
      expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', {
        providerConfigId: 'cfg-claude',
      });
      // Never mutates active-preset state (that is applyPresetWithHelper's job only).
      expect(settings.setProjectActivePreset).not.toHaveBeenCalled();
    });

    it('clears overrides when explicitly set to null', async () => {
      mockAgentsList({
        providerConfigId: 'old-cfg',
        modelOverride: 'stale',
        effortOverride: 'high',
      });
      storage.updateAgent.mockResolvedValue({} as never);

      await applyAgentConfigs(
        projectId,
        [
          {
            agentName: 'Coder',
            providerConfigName: 'claude-config',
            modelOverride: null,
            effortOverride: null,
          },
        ],
        { storage: storage as unknown as StorageService },
        nameMaps,
      );

      expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', {
        providerConfigId: 'cfg-claude',
        modelOverride: null,
        effortOverride: null,
      });
    });

    it('applies a concrete value even when it equals the config default (no default-stripping)', async () => {
      mockAgentsList({ providerConfigId: 'old-cfg', modelOverride: null });
      storage.updateAgent.mockResolvedValue({} as never);

      await applyAgentConfigs(
        projectId,
        [
          {
            agentName: 'Coder',
            providerConfigName: 'claude-config',
            modelOverride: 'openai/gpt-5',
            effortOverride: 'medium',
          },
        ],
        { storage: storage as unknown as StorageService },
        nameMaps,
      );

      expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', {
        providerConfigId: 'cfg-claude',
        modelOverride: 'openai/gpt-5',
        effortOverride: 'medium',
      });
    });

    it('warns (not silent) and skips when the agent name is unknown', async () => {
      mockAgentsList({ providerConfigId: 'old-cfg' });
      storage.updateAgent.mockResolvedValue({} as never);

      const result = await applyAgentConfigs(
        projectId,
        [{ agentName: 'Ghost', providerConfigName: 'claude-config' }],
        { storage: storage as unknown as StorageService },
        nameMaps,
      );

      expect(result.applied).toBe(0);
      expect(result.warnings).toEqual(['Agent "Ghost" not found in project']);
      expect(storage.updateAgent).not.toHaveBeenCalled();
    });

    it('warns (not silent) and skips when the provider config is not found for the agent', async () => {
      mockAgentsList({ providerConfigId: 'old-cfg' });
      storage.updateAgent.mockResolvedValue({} as never);

      const result = await applyAgentConfigs(
        projectId,
        [{ agentName: 'Coder', providerConfigName: 'missing-config' }],
        { storage: storage as unknown as StorageService },
        nameMaps,
      );

      expect(result.applied).toBe(0);
      expect(result.warnings).toEqual([
        'Provider config "missing-config" not found for agent "Coder"',
      ]);
      expect(storage.updateAgent).not.toHaveBeenCalled();
    });
  });

  describe('effortOverride semantics (mirrors modelOverride)', () => {
    const baseAgent = {
      id: 'agent-1',
      name: 'Coder',
      profileId: 'profile-1',
      providerConfigId: 'old-cfg',
      modelOverride: null,
    };
    const baseProfileItems = [
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
    ];
    const baseConfigs = [
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
    ];

    const setupApply = (agentOverrides: Partial<typeof baseAgent>, preset: ProjectPreset) => {
      settings.getProjectPresets.mockReturnValue([preset]);
      storage.listAgents.mockResolvedValue({
        items: [{ ...baseAgent, ...agentOverrides }],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listAgentProfiles.mockResolvedValue({
        items: baseProfileItems,
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue(baseConfigs);
      storage.updateAgent.mockResolvedValue({} as never);
    };

    it('sets effortOverride when preset explicitly defines it', async () => {
      setupApply(
        { effortOverride: 'low' },
        {
          name: 'default',
          description: 'Default',
          agentConfigs: [
            { agentName: 'Coder', providerConfigName: 'claude-config', effortOverride: 'high' },
          ],
        },
      );

      const result = await applyPresetWithHelper(projectId, 'default', {
        storage: storage as unknown as StorageService,
        settings: settings as unknown as SettingsService,
      });

      expect(result).toEqual({ applied: 1, warnings: [] });
      expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', {
        providerConfigId: 'cfg-claude',
        effortOverride: 'high',
      });
    });

    it('omits effortOverride from update payload when preset does not define it (preserves existing)', async () => {
      setupApply(
        { effortOverride: 'medium' },
        {
          name: 'default',
          description: 'Default',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        },
      );

      await applyPresetWithHelper(projectId, 'default', {
        storage: storage as unknown as StorageService,
        settings: settings as unknown as SettingsService,
      });

      const payload = storage.updateAgent.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload).toEqual(expect.objectContaining({ providerConfigId: 'cfg-claude' }));
      expect(payload).toEqual(expect.not.objectContaining({ effortOverride: expect.anything() }));
    });

    it('clears effortOverride when preset explicitly sets it to null', async () => {
      setupApply(
        { effortOverride: 'high' },
        {
          name: 'default',
          description: 'Default',
          agentConfigs: [
            { agentName: 'Coder', providerConfigName: 'claude-config', effortOverride: null },
          ],
        },
      );

      await applyPresetWithHelper(projectId, 'default', {
        storage: storage as unknown as StorageService,
        settings: settings as unknown as SettingsService,
      });

      expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', {
        providerConfigId: 'cfg-claude',
        effortOverride: null,
      });
    });

    it('doesProjectMatchPreset detects effortOverride drift', async () => {
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'cfg-claude',
            modelOverride: null,
            effortOverride: 'medium',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByIds.mockResolvedValue(baseConfigs);

      const result = await doesProjectMatchPresetWithHelper(
        projectId,
        {
          agentConfigs: [
            { agentName: 'Coder', providerConfigName: 'claude-config', effortOverride: 'high' },
          ],
        },
        { storage: storage as unknown as StorageService },
      );

      expect(result).toBe(false);
    });

    it('doesProjectMatchPreset ignores effortOverride when preset omits it', async () => {
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'cfg-claude',
            modelOverride: null,
            effortOverride: 'high',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByIds.mockResolvedValue(baseConfigs);

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
});
