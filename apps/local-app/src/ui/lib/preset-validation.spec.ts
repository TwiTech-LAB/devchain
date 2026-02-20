import { validatePresetAvailability } from './preset-validation';

describe('validatePresetAvailability', () => {
  // Test data fixtures
  const mockAgents: Agent[] = [
    { id: 'agent-1', name: 'Brainstormer', profileId: 'profile-1' },
    { id: 'agent-2', name: 'Coder', profileId: 'profile-1' },
    { id: 'agent-3', name: 'Reviewer', profileId: 'profile-2' },
    { id: 'agent-4', name: 'Tester', profileId: 'profile-2' },
  ];

  const mockConfigsByProfile = new Map<string, ProviderConfig[]>([
    [
      'profile-1',
      [
        { id: 'config-1', name: 'claude-config', profileId: 'profile-1', providerId: 'provider-1' },
        { id: 'config-2', name: 'codex-config', profileId: 'profile-1', providerId: 'provider-2' },
        { id: 'config-3', name: 'claude-fast', profileId: 'profile-1', providerId: 'provider-1' },
      ],
    ],
    [
      'profile-2',
      [
        { id: 'config-4', name: 'gemini-config', profileId: 'profile-2', providerId: 'provider-3' },
        { id: 'config-5', name: 'gemini-fast', profileId: 'profile-2', providerId: 'provider-3' },
      ],
    ],
  ]);

  const createPreset = (
    name: string,
    agentConfigs: Array<{ agentName: string; providerConfigName: string }>,
  ): Preset => ({
    name,
    description: null,
    agentConfigs,
  });

  describe('available=true cases', () => {
    it('returns available=true when all configs exist', () => {
      const preset = createPreset('All Available', [
        { agentName: 'Brainstormer', providerConfigName: 'claude-config' },
        { agentName: 'Coder', providerConfigName: 'codex-config' },
        { agentName: 'Reviewer', providerConfigName: 'gemini-config' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(true);
      expect(result.missingConfigs).toEqual([]);
    });

    it('returns available=true when preset has no configs', () => {
      const preset = createPreset('Empty Preset', []);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(true);
      expect(result.missingConfigs).toEqual([]);
    });
  });

  describe('available=false with missing agent', () => {
    it('returns available=false when agent not found', () => {
      const preset = createPreset('Missing Agent', [
        { agentName: 'NonExistent', providerConfigName: 'claude-config' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(false);
      expect(result.missingConfigs).toHaveLength(1);
      expect(result.missingConfigs[0]).toEqual({
        agentName: 'NonExistent',
        configName: 'claude-config',
        reason: 'agent_not_found',
      });
    });

    it('returns available=false with multiple missing agents', () => {
      const preset = createPreset('Multiple Missing', [
        { agentName: 'Agent1', providerConfigName: 'config-1' },
        { agentName: 'Agent2', providerConfigName: 'config-2' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(false);
      expect(result.missingConfigs).toHaveLength(2);
      expect(result.missingConfigs[0].reason).toBe('agent_not_found');
      expect(result.missingConfigs[1].reason).toBe('agent_not_found');
    });
  });

  describe('available=false with missing config', () => {
    it('returns available=false when config not found', () => {
      const preset = createPreset('Missing Config', [
        { agentName: 'Brainstormer', providerConfigName: 'NonExistentConfig' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(false);
      expect(result.missingConfigs).toHaveLength(1);
      expect(result.missingConfigs[0]).toEqual({
        agentName: 'Brainstormer',
        configName: 'NonExistentConfig',
        reason: 'config_not_found',
      });
    });

    it('returns available=false with multiple missing configs', () => {
      const preset = createPreset('Multiple Missing Configs', [
        { agentName: 'Brainstormer', providerConfigName: 'Config1' },
        { agentName: 'Coder', providerConfigName: 'Config2' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(false);
      expect(result.missingConfigs).toHaveLength(2);
      expect(result.missingConfigs[0].reason).toBe('config_not_found');
      expect(result.missingConfigs[1].reason).toBe('config_not_found');
    });
  });

  describe('case-insensitive matching', () => {
    it('matches agent names case-insensitively', () => {
      const preset = createPreset('Case Insensitive Agent', [
        { agentName: 'BRAINSTORMER', providerConfigName: 'claude-config' },
        { agentName: 'coder', providerConfigName: 'claude-config' },
        { agentName: '  ReViewEr  ', providerConfigName: 'gemini-config' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(true);
      expect(result.missingConfigs).toEqual([]);
    });

    it('matches config names case-insensitively', () => {
      const preset = createPreset('Case Insensitive Config', [
        { agentName: 'Brainstormer', providerConfigName: 'CLAUDE-CONFIG' },
        { agentName: 'Coder', providerConfigName: '  codex-config  ' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(true);
      expect(result.missingConfigs).toEqual([]);
    });

    it('returns available=false when config name does not exist', () => {
      const preset = createPreset('Wrong Config', [
        { agentName: 'Brainstormer', providerConfigName: 'non-existent-config' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(false);
      expect(result.missingConfigs[0].reason).toBe('config_not_found');
    });
  });

  describe('whitespace handling', () => {
    it('matches agent names with leading/trailing whitespace', () => {
      const preset = createPreset('Whitespace Agent', [
        { agentName: '  Brainstormer  ', providerConfigName: 'claude-config' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(true);
    });

    it('matches config names with leading/trailing whitespace', () => {
      const preset = createPreset('Whitespace Config', [
        { agentName: 'Brainstormer', providerConfigName: '  claude-config  ' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(true);
    });
  });

  describe('empty configs by profile', () => {
    it('returns available=false when agent has no configs in profile', () => {
      const emptyMap = new Map<string, ProviderConfig[]>();
      const preset = createPreset('Empty Profile', [
        { agentName: 'Brainstormer', providerConfigName: 'claude-config' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, emptyMap);

      expect(result.available).toBe(false);
      expect(result.missingConfigs[0].reason).toBe('config_not_found');
    });

    it('returns available=false when agent profile has no configs', () => {
      const preset = createPreset('No Configs In Profile', [
        { agentName: 'Tester', providerConfigName: 'any-config' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(false);
      expect(result.missingConfigs[0]).toEqual({
        agentName: 'Tester',
        configName: 'any-config',
        reason: 'config_not_found',
      });
    });
  });

  describe('mixed scenarios', () => {
    it('returns available=false with both missing agent and missing config', () => {
      const preset = createPreset('Mixed Issues', [
        { agentName: 'NonExistent', providerConfigName: 'config-1' },
        { agentName: 'Brainstormer', providerConfigName: 'NonExistentConfig' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(false);
      expect(result.missingConfigs).toHaveLength(2);
      expect(result.missingConfigs[0].reason).toBe('agent_not_found');
      expect(result.missingConfigs[1].reason).toBe('config_not_found');
    });

    it('returns available=true when all configs exist even with some agents offline', () => {
      const preset = createPreset('All Exist', [
        { agentName: 'Brainstormer', providerConfigName: 'claude-config' },
        { agentName: 'Coder', providerConfigName: 'codex-config' },
      ]);

      const result = validatePresetAvailability(preset, mockAgents, mockConfigsByProfile);

      expect(result.available).toBe(true);
    });
  });

  describe('partial provider coverage (relaxed import scenario)', () => {
    // After a relaxed template import where only claude is installed,
    // presets referencing codex/gemini configs should be unavailable.
    const partialAgents: Agent[] = [
      { id: 'agent-1', name: 'Brainstormer', profileId: 'profile-arch' },
      { id: 'agent-2', name: 'Coder', profileId: 'profile-coder' },
      { id: 'agent-3', name: 'Code Reviewer', profileId: 'profile-reviewer' },
    ];

    // Only claude configs exist (codex/gemini not installed)
    const partialConfigs = new Map<string, ProviderConfig[]>([
      [
        'profile-arch',
        [{ id: 'c1', name: 'opus', profileId: 'profile-arch', providerId: 'p-claude' }],
      ],
      [
        'profile-coder',
        [
          { id: 'c2', name: 'opus', profileId: 'profile-coder', providerId: 'p-claude' },
          { id: 'c3', name: 'sonnet', profileId: 'profile-coder', providerId: 'p-claude' },
        ],
      ],
      [
        'profile-reviewer',
        [{ id: 'c4', name: 'opus', profileId: 'profile-reviewer', providerId: 'p-claude' }],
      ],
    ]);

    it('returns available=false for presets referencing configs from missing providers', () => {
      const preset = createPreset('Tier-A[gpt-high]', [
        { agentName: 'Brainstormer', providerConfigName: 'gpt-high' },
        { agentName: 'Coder', providerConfigName: 'gpt-high' },
        { agentName: 'Code Reviewer', providerConfigName: 'gpt-high' },
      ]);

      const result = validatePresetAvailability(preset, partialAgents, partialConfigs);

      expect(result.available).toBe(false);
      expect(result.missingConfigs).toHaveLength(3);
      expect(result.missingConfigs.every((m) => m.reason === 'config_not_found')).toBe(true);
    });

    it('returns available=true for presets using only installed provider configs', () => {
      const preset = createPreset('Tier-A[opus]', [
        { agentName: 'Brainstormer', providerConfigName: 'opus' },
        { agentName: 'Coder', providerConfigName: 'opus' },
        { agentName: 'Code Reviewer', providerConfigName: 'opus' },
      ]);

      const result = validatePresetAvailability(preset, partialAgents, partialConfigs);

      expect(result.available).toBe(true);
      expect(result.missingConfigs).toEqual([]);
    });

    it('returns mixed results for presets with partial coverage', () => {
      const preset = createPreset('Tier-B[opus:sonnet:gpt-high]', [
        { agentName: 'Brainstormer', providerConfigName: 'opus' },
        { agentName: 'Coder', providerConfigName: 'sonnet' },
        { agentName: 'Code Reviewer', providerConfigName: 'gpt-high' },
      ]);

      const result = validatePresetAvailability(preset, partialAgents, partialConfigs);

      expect(result.available).toBe(false);
      // Only Code Reviewer's gpt-high config is missing
      expect(result.missingConfigs).toHaveLength(1);
      expect(result.missingConfigs[0].agentName).toBe('Code Reviewer');
      expect(result.missingConfigs[0].configName).toBe('gpt-high');
      expect(result.missingConfigs[0].reason).toBe('config_not_found');
    });
  });
});
