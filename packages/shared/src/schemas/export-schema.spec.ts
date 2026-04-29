/**
 * ExportSchema Validation Tests
 *
 * Tests for validating the export schema structure including profiles, presets, and agent configs.
 * Run with: pnpm test (in packages/shared directory)
 */

import { ExportSchema } from './export-schema';
import { EnvVarsSchema } from './env-vars';

describe('ExportSchema', () => {
  describe('profiles.familySlug', () => {
    const baseProfile = {
      name: 'Test Profile',
      provider: { id: 'provider-1', name: 'claude' },
      options: null,
      instructions: null,
      temperature: null,
      maxTokens: null,
    };

    const baseTemplate = {
      version: 1,
      exportedAt: '2024-01-01T00:00:00Z',
      prompts: [],
      profiles: [baseProfile],
      agents: [],
      statuses: [],
    };

    it('should accept profile without familySlug (backward compatibility)', () => {
      const result = ExportSchema.safeParse(baseTemplate);
      expect(result.success).toBe(true);
    });

    it('should accept profile with familySlug as string', () => {
      const template = {
        ...baseTemplate,
        profiles: [{ ...baseProfile, familySlug: 'coder' }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.profiles[0].familySlug).toBe('coder');
      }
    });

    it('should accept profile with familySlug as null', () => {
      const template = {
        ...baseTemplate,
        profiles: [{ ...baseProfile, familySlug: null }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.profiles[0].familySlug).toBeNull();
      }
    });

    it('should reject profile with familySlug as non-string', () => {
      const template = {
        ...baseTemplate,
        profiles: [{ ...baseProfile, familySlug: 123 }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should allow multiple profiles with same familySlug', () => {
      const template = {
        ...baseTemplate,
        profiles: [
          { ...baseProfile, name: 'CodeOpus', familySlug: 'coder' },
          { ...baseProfile, name: 'CodeGPT', familySlug: 'coder' },
        ],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.profiles[0].familySlug).toBe('coder');
        expect(result.data.profiles[1].familySlug).toBe('coder');
      }
    });

    it('should accept mixed profiles with and without familySlug', () => {
      const template = {
        ...baseTemplate,
        profiles: [
          { ...baseProfile, name: 'WithFamily', familySlug: 'coder' },
          { ...baseProfile, name: 'WithoutFamily' },
          { ...baseProfile, name: 'WithNull', familySlug: null },
        ],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.profiles[0].familySlug).toBe('coder');
        expect(result.data.profiles[1].familySlug).toBeUndefined();
        expect(result.data.profiles[2].familySlug).toBeNull();
      }
    });
  });

  describe('providerSettings', () => {
    const baseTemplate = {
      version: 1,
      exportedAt: '2024-01-01T00:00:00Z',
      prompts: [],
      profiles: [],
      agents: [],
      statuses: [],
    };

    it('should accept template without providerSettings (backward compatible)', () => {
      const result = ExportSchema.safeParse(baseTemplate);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providerSettings).toBeUndefined();
      }
    });

    it('should accept valid providerSettings with threshold', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [{ name: 'claude', autoCompactThreshold: 10 }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providerSettings).toHaveLength(1);
        expect(result.data.providerSettings![0].autoCompactThreshold).toBe(10);
      }
    });

    it('should accept providerSettings with null threshold', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [{ name: 'claude', autoCompactThreshold: null }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
    });

    it('should accept providerSettings without threshold field', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [{ name: 'claude' }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
    });

    it('should reject providerSettings with threshold out of range', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [{ name: 'claude', autoCompactThreshold: 101 }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should reject providerSettings with empty name', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [{ name: '', autoCompactThreshold: 10 }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should accept empty providerSettings array', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
    });

    it('should accept providerSettings with oneMillionContextEnabled', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [
          { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
        ],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      expect(result.data!.providerSettings![0].oneMillionContextEnabled).toBe(true);
    });

    it('should accept providerSettings without oneMillionContextEnabled (backward compatible)', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [{ name: 'claude', autoCompactThreshold: 10 }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      expect(result.data!.providerSettings![0].oneMillionContextEnabled).toBeUndefined();
    });
  });

  describe('agents.modelOverride', () => {
    const baseTemplate = {
      version: 1,
      exportedAt: '2024-01-01T00:00:00Z',
      prompts: [],
      profiles: [],
      agents: [{ name: 'Coder' }],
      statuses: [],
    };

    it('should accept agent with modelOverride as string', () => {
      const template = {
        ...baseTemplate,
        agents: [{ name: 'Coder', modelOverride: 'anthropic/claude-sonnet-4-5' }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agents[0].modelOverride).toBe('anthropic/claude-sonnet-4-5');
      }
    });

    it('should accept agent with modelOverride as null', () => {
      const template = {
        ...baseTemplate,
        agents: [{ name: 'Coder', modelOverride: null }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agents[0].modelOverride).toBeNull();
      }
    });

    it('should accept agent without modelOverride for backward compatibility', () => {
      const result = ExportSchema.safeParse(baseTemplate);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.agents[0].modelOverride).toBeUndefined();
      }
    });
  });

  describe('providerModels', () => {
    const baseTemplate = {
      version: 1,
      exportedAt: '2024-01-01T00:00:00Z',
      prompts: [],
      profiles: [],
      agents: [],
      statuses: [],
    };

    it('should default providerModels to empty array when omitted (backward compatibility)', () => {
      const result = ExportSchema.safeParse(baseTemplate);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providerModels).toEqual([]);
      }
    });

    it('should accept valid providerModels payload', () => {
      const template = {
        ...baseTemplate,
        providerModels: [
          {
            providerName: 'opencode',
            models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5'],
          },
        ],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providerModels).toEqual(template.providerModels);
      }
    });

    it('should reject providerModels when models contains non-string values', () => {
      const template = {
        ...baseTemplate,
        providerModels: [
          {
            providerName: 'opencode',
            models: ['openai/gpt-5', 123],
          },
        ],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should reject providerModels entries missing providerName', () => {
      const template = {
        ...baseTemplate,
        providerModels: [
          {
            models: ['openai/gpt-5'],
          },
        ],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });
  });

  describe('teams', () => {
    it('defaults to empty array when omitted', () => {
      const result = ExportSchema.parse({ profiles: [], statuses: [] });
      expect(result.teams).toEqual([]);
    });

    it('accepts valid teams array', () => {
      const result = ExportSchema.parse({
        teams: [
          {
            name: 'Backend Team',
            description: 'The backend team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Agent-A', 'Agent-B'],
            profileNames: ['Profile-1'],
          },
        ],
      });
      expect(result.teams).toHaveLength(1);
      expect(result.teams[0].name).toBe('Backend Team');
      expect(result.teams[0].memberAgentNames).toEqual(['Agent-A', 'Agent-B']);
      expect(result.teams[0].profileNames).toEqual(['Profile-1']);
    });

    it('accepts teams without optional fields', () => {
      const result = ExportSchema.parse({
        teams: [
          {
            name: 'Minimal Team',
            memberAgentNames: ['Agent-A'],
          },
        ],
      });
      expect(result.teams[0].description).toBeUndefined();
      expect(result.teams[0].teamLeadAgentName).toBeUndefined();
      expect(result.teams[0].profileNames).toEqual([]);
    });

    it('rejects teams with empty name', () => {
      expect(() =>
        ExportSchema.parse({
          teams: [{ name: '', memberAgentNames: ['A'] }],
        }),
      ).toThrow();
    });

    it('backward compatibility: legacy templates without teams still parse', () => {
      const legacy = { version: 1, profiles: [], statuses: [], agents: [] };
      const result = ExportSchema.parse(legacy);
      expect(result.teams).toEqual([]);
    });

    it('accepts teams with profileSelections', () => {
      const result = ExportSchema.parse({
        teams: [
          {
            name: 'Team A',
            memberAgentNames: ['Agent-A'],
            profileNames: ['Profile-1'],
            profileSelections: [
              { profileName: 'Profile-1', configNames: ['Config-A', 'Config-B'] },
            ],
          },
        ],
      });
      expect(result.teams[0].profileSelections).toEqual([
        { profileName: 'Profile-1', configNames: ['Config-A', 'Config-B'] },
      ]);
    });

    it('accepts teams without profileSelections (backward compatible)', () => {
      const result = ExportSchema.parse({
        teams: [{ name: 'Team A', memberAgentNames: ['Agent-A'] }],
      });
      expect(result.teams[0].profileSelections).toBeUndefined();
    });

    it('rejects profileSelections with empty configNames', () => {
      expect(() =>
        ExportSchema.parse({
          teams: [
            {
              name: 'Team A',
              memberAgentNames: ['Agent-A'],
              profileSelections: [{ profileName: 'P', configNames: [] }],
            },
          ],
        }),
      ).toThrow();
    });

    it('rejects profileSelections with empty profileName', () => {
      expect(() =>
        ExportSchema.parse({
          teams: [
            {
              name: 'Team A',
              memberAgentNames: ['Agent-A'],
              profileSelections: [{ profileName: '', configNames: ['C'] }],
            },
          ],
        }),
      ).toThrow();
    });

    it('rejects profileSelections with extra fields (strict)', () => {
      expect(() =>
        ExportSchema.parse({
          teams: [
            {
              name: 'Team A',
              memberAgentNames: ['Agent-A'],
              profileSelections: [
                { profileName: 'P', configNames: ['C'], extra: true } as never,
              ],
            },
          ],
        }),
      ).toThrow();
    });
  });

  describe('presets', () => {
    const baseTemplate = {
      version: 1,
      exportedAt: '2024-01-01T00:00:00Z',
      prompts: [],
      profiles: [],
      agents: [],
      statuses: [],
    };

    const validPreset = {
      name: 'default',
      description: 'Default preset',
      agentConfigs: [
        { agentName: 'coder', providerConfigName: 'claude-config' },
        { agentName: 'reviewer', providerConfigName: 'gemini-config' },
      ],
    };

    it('should accept valid preset with all fields', () => {
      const template = {
        ...baseTemplate,
        presets: [validPreset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.presets).toHaveLength(1);
        expect(result.data.presets[0].name).toBe('default');
        expect(result.data.presets[0].description).toBe('Default preset');
        expect(result.data.presets[0].agentConfigs).toHaveLength(2);
      }
    });

    it('should accept preset without description', () => {
      const preset = {
        name: 'minimal',
        agentConfigs: [{ agentName: 'agent', providerConfigName: 'config' }],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.presets[0].description).toBeUndefined();
      }
    });

    it('should accept preset with empty agentConfigs array', () => {
      const preset = {
        name: 'empty',
        agentConfigs: [],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
    });

    it('should accept agentConfig with modelOverride string', () => {
      const preset = {
        name: 'with-model-override',
        agentConfigs: [
          {
            agentName: 'agent',
            providerConfigName: 'config',
            modelOverride: 'openai/gpt-5',
          },
        ],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.presets[0].agentConfigs[0].modelOverride).toBe('openai/gpt-5');
      }
    });

    it('should accept agentConfig with null modelOverride', () => {
      const preset = {
        name: 'with-null-model-override',
        agentConfigs: [{ agentName: 'agent', providerConfigName: 'config', modelOverride: null }],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.presets[0].agentConfigs[0].modelOverride).toBeNull();
      }
    });

    it('should accept agentConfig without modelOverride for backward compatibility', () => {
      const preset = {
        name: 'without-model-override',
        agentConfigs: [{ agentName: 'agent', providerConfigName: 'config' }],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.presets[0].agentConfigs[0].modelOverride).toBeUndefined();
      }
    });

    it('should reject preset with missing name', () => {
      const preset = {
        description: 'No name',
        agentConfigs: [{ agentName: 'agent', providerConfigName: 'config' }],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should reject preset with empty name', () => {
      const preset = {
        name: '',
        agentConfigs: [{ agentName: 'agent', providerConfigName: 'config' }],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should reject agentConfig with missing agentName', () => {
      const preset = {
        name: 'invalid',
        agentConfigs: [{ providerConfigName: 'config' }],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should reject agentConfig with empty agentName', () => {
      const preset = {
        name: 'invalid',
        agentConfigs: [{ agentName: '', providerConfigName: 'config' }],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should reject agentConfig with missing providerConfigName', () => {
      const preset = {
        name: 'invalid',
        agentConfigs: [{ agentName: 'agent' }],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should reject agentConfig with empty providerConfigName', () => {
      const preset = {
        name: 'invalid',
        agentConfigs: [{ agentName: 'agent', providerConfigName: '' }],
      };
      const template = {
        ...baseTemplate,
        presets: [preset],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });
  });

  describe('EnvVarsSchema (standalone)', () => {
    it('should accept valid env vars', () => {
      const result = EnvVarsSchema.safeParse({ MY_VAR: 'value', PATH: '/usr/bin' });
      expect(result.success).toBe(true);
    });

    it('should accept null', () => {
      const result = EnvVarsSchema.safeParse(null);
      expect(result.success).toBe(true);
    });

    it('should accept undefined', () => {
      const result = EnvVarsSchema.safeParse(undefined);
      expect(result.success).toBe(true);
    });

    it('should reject keys with invalid characters', () => {
      const result = EnvVarsSchema.safeParse({ 'invalid-key': 'value' });
      expect(result.success).toBe(false);
    });

    it('should reject keys starting with a digit', () => {
      const result = EnvVarsSchema.safeParse({ '1VAR': 'value' });
      expect(result.success).toBe(false);
    });

    it('should reject values with control characters', () => {
      const result = EnvVarsSchema.safeParse({ MY_VAR: 'val\x00ue' });
      expect(result.success).toBe(false);
    });

    it('should accept empty record', () => {
      const result = EnvVarsSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should accept keys starting with underscore', () => {
      const result = EnvVarsSchema.safeParse({ _PRIVATE: 'secret' });
      expect(result.success).toBe(true);
    });
  });

  describe('providerConfigs[].env validation', () => {
    const baseTemplate = {
      version: 1,
      exportedAt: '2024-01-01T00:00:00Z',
      prompts: [],
      profiles: [
        {
          name: 'Test Profile',
          provider: { name: 'claude' },
          providerConfigs: [
            {
              name: 'config-1',
              providerName: 'claude',
              env: { VALID_KEY: 'value' },
            },
          ],
        },
      ],
      agents: [],
      statuses: [],
    };

    it('should accept providerConfig with valid env keys', () => {
      const result = ExportSchema.safeParse(baseTemplate);
      expect(result.success).toBe(true);
    });

    it('should reject providerConfig with invalid env key', () => {
      const template = {
        ...baseTemplate,
        profiles: [
          {
            ...baseTemplate.profiles[0],
            providerConfigs: [
              { name: 'c', providerName: 'claude', env: { 'bad-key': 'val' } },
            ],
          },
        ],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should accept providerConfig with null env', () => {
      const template = {
        ...baseTemplate,
        profiles: [
          {
            ...baseTemplate.profiles[0],
            providerConfigs: [{ name: 'c', providerName: 'claude', env: null }],
          },
        ],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
    });

    it('should accept providerConfig without env field', () => {
      const template = {
        ...baseTemplate,
        profiles: [
          {
            ...baseTemplate.profiles[0],
            providerConfigs: [{ name: 'c', providerName: 'claude' }],
          },
        ],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
    });
  });

  describe('providerSettings[].env', () => {
    const baseTemplate = {
      version: 1,
      exportedAt: '2024-01-01T00:00:00Z',
      prompts: [],
      profiles: [],
      agents: [],
      statuses: [],
    };

    it('should accept providerSettings with valid env', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [
          { name: 'claude', env: { API_BASE: 'https://api.example.com' } },
        ],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providerSettings![0].env).toEqual({
          API_BASE: 'https://api.example.com',
        });
      }
    });

    it('should accept providerSettings with null env', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [{ name: 'claude', env: null }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
    });

    it('should accept providerSettings without env field (backward compatible)', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [{ name: 'claude', autoCompactThreshold: 50 }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providerSettings![0].env).toBeUndefined();
      }
    });

    it('should reject providerSettings with invalid env key', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [{ name: 'claude', env: { '123bad': 'val' } }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('should reject providerSettings with control chars in env value', () => {
      const template = {
        ...baseTemplate,
        providerSettings: [{ name: 'claude', env: { GOOD_KEY: 'val\x01ue' } }],
      };
      const result = ExportSchema.safeParse(template);
      expect(result.success).toBe(false);
    });

    it('older templates without env in providerSettings still parse cleanly', () => {
      const legacy = {
        version: 1,
        profiles: [],
        statuses: [],
        agents: [],
        providerSettings: [
          { name: 'claude', autoCompactThreshold: 80, oneMillionContextEnabled: true },
        ],
      };
      const result = ExportSchema.safeParse(legacy);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providerSettings![0].env).toBeUndefined();
        expect(result.data.providerSettings![0].autoCompactThreshold).toBe(80);
      }
    });
  });
});
