import { z } from 'zod';
import { isValidSemVer } from '@devchain/shared';

/**
 * Recreate semver string schema for testing
 * (Avoids ESM/CJS import issues with the actual ManifestSchema)
 */
const semverString = z.string().refine((v) => isValidSemVer(v), {
  message: 'Must be a valid semantic version (e.g., "1.0.0", "0.4.0-beta.1")',
});

/**
 * ManifestSchema for testing - mirrors the actual schema in @devchain/shared
 */
const ManifestSchema = z
  .object({
    slug: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    category: z.enum(['development', 'planning', 'custom']).optional(),
    tags: z.array(z.string()).max(10).optional(),
    authorName: z.string().optional(),
    minDevchainVersion: semverString.optional(),
    isOfficial: z.boolean().optional(),
    version: semverString.optional(),
    publishedAt: z.string().optional(),
    changelog: z.string().optional(),
    gitCommit: z.string().optional(),
  })
  .strict();

/**
 * Tests for ManifestSchema semver validation.
 * These tests verify the semver validation added to minDevchainVersion and version fields.
 */
describe('ManifestSchema semver validation', () => {
  describe('minDevchainVersion validation', () => {
    it('accepts valid semver version', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        minDevchainVersion: '0.4.0',
      });
      expect(result.success).toBe(true);
    });

    it('accepts semver with prerelease tag', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        minDevchainVersion: '1.0.0-beta.1',
      });
      expect(result.success).toBe(true);
    });

    it('accepts semver with build metadata', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        minDevchainVersion: '1.0.0+build.123',
      });
      expect(result.success).toBe(true);
    });

    it('accepts semver with prerelease and build metadata', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        minDevchainVersion: '1.0.0-alpha.1+build.456',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid version format (missing patch)', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        minDevchainVersion: '1.0',
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0].message).toContain('semantic version');
    });

    it('rejects invalid version format (not semver)', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        minDevchainVersion: 'invalid-version',
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0].message).toContain('semantic version');
    });

    it('rejects version with leading zeros', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        minDevchainVersion: '01.0.0',
      });
      expect(result.success).toBe(false);
    });

    it('allows minDevchainVersion to be omitted', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('version validation', () => {
    it('accepts valid semver version', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        version: '2.0.0',
      });
      expect(result.success).toBe(true);
    });

    it('accepts semver with prerelease tag', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        version: '1.0.0-rc.1',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid version format', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        version: 'v1.0.0', // v prefix is not valid semver
      });
      expect(result.success).toBe(false);
      expect(result.error?.errors[0].message).toContain('semantic version');
    });

    it('rejects empty string version', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        version: '',
      });
      expect(result.success).toBe(false);
    });

    it('allows version to be omitted', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('strict mode', () => {
    it('rejects unknown fields', () => {
      const result = ManifestSchema.safeParse({
        name: 'Test Template',
        unknownField: 'value',
      });
      expect(result.success).toBe(false);
    });
  });
});
