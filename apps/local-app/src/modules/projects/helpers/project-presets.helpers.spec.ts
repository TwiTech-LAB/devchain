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
    it.each([
      {
        label: 'matching models',
        agentModel: 'openai/gpt-5',
        presetModel: { modelOverride: 'openai/gpt-5' },
        expected: true,
      },
      {
        label: 'preset model drift',
        agentModel: null,
        presetModel: { modelOverride: 'openai/gpt-5' },
        expected: false,
      },
      {
        label: 'default model drift',
        agentModel: 'openai/gpt-5',
        presetModel: { modelOverride: null },
        expected: false,
      },
      { label: 'both omit model', agentModel: undefined, presetModel: {}, expected: true },
      {
        label: 'preset ignores model',
        agentModel: 'openai/gpt-5',
        presetModel: {},
        expected: true,
      },
    ])('$label', async ({ agentModel, presetModel, expected }) => {
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'cfg-1',
            modelOverride: agentModel,
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
              ...presetModel,
            },
          ],
        },
        { storage: storage as unknown as StorageService },
      );

      expect(result).toBe(expected);
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
        isProjectOwner: true,
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
      expect(storage.updateAgent.mock.calls[0]?.[1]).not.toHaveProperty('isProjectOwner');
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

    it.each([
      {
        label: 'unknown agent',
        agentName: 'Ghost',
        providerConfigName: 'claude-config',
        warning: 'Agent "Ghost" not found in project',
      },
      {
        label: 'unknown config',
        agentName: 'Coder',
        providerConfigName: 'missing-config',
        warning: 'Provider config "missing-config" not found for agent "Coder"',
      },
    ])('$label', async ({ agentName, providerConfigName, warning }) => {
      mockAgentsList({ providerConfigId: 'old-cfg' });
      storage.updateAgent.mockResolvedValue({} as never);

      const result = await applyAgentConfigs(
        projectId,
        [{ agentName, providerConfigName }],
        { storage: storage as unknown as StorageService },
        nameMaps,
      );

      expect(result.applied).toBe(0);
      expect(result.warnings).toEqual([warning]);
      expect(storage.updateAgent).not.toHaveBeenCalled();
    });
  });

  describe('effortOverride semantics (mirrors modelOverride)', () => {
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

    it.each([
      {
        label: 'effort drift',
        agentEffort: 'medium',
        presetEffort: { effortOverride: 'high' },
        expected: false,
      },
      { label: 'effort omitted', agentEffort: 'high', presetEffort: {}, expected: true },
    ])('$label', async ({ agentEffort, presetEffort, expected }) => {
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Coder',
            profileId: 'profile-1',
            providerConfigId: 'cfg-claude',
            modelOverride: null,
            effortOverride: agentEffort,
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
            { agentName: 'Coder', providerConfigName: 'claude-config', ...presetEffort },
          ],
        },
        { storage: storage as unknown as StorageService },
      );

      expect(result).toBe(expected);
    });
  });
});
