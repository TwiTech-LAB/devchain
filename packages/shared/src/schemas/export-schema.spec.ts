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
});
