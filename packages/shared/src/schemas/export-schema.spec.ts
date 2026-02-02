/**
 * ExportSchema Validation Tests
 *
 * Tests for validating the export schema structure including profiles, presets, and agent configs.
 * Run with: pnpm test (in packages/shared directory)
 */

import { ExportSchema } from './export-schema';

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
});
