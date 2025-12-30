import { ManifestOverrideSchema, ExportWithOverridesSchema } from './export.dto';

/**
 * Tests for ManifestOverrideSchema validation.
 * Ensures the export endpoint accepts valid manifest overrides including minDevchainVersion.
 */
describe('ManifestOverrideSchema', () => {
  describe('minDevchainVersion validation', () => {
    it('accepts valid semver version', () => {
      const result = ManifestOverrideSchema.safeParse({
        minDevchainVersion: '0.4.0',
      });
      expect(result.success).toBe(true);
    });

    it('accepts semver with prerelease tag', () => {
      const result = ManifestOverrideSchema.safeParse({
        minDevchainVersion: '1.0.0-beta.1',
      });
      expect(result.success).toBe(true);
    });

    it('accepts semver with build metadata', () => {
      const result = ManifestOverrideSchema.safeParse({
        minDevchainVersion: '1.0.0+build.123',
      });
      expect(result.success).toBe(true);
    });

    it('accepts semver with prerelease and build metadata', () => {
      const result = ManifestOverrideSchema.safeParse({
        minDevchainVersion: '1.0.0-alpha.1+build.456',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid version format (missing patch)', () => {
      const result = ManifestOverrideSchema.safeParse({
        minDevchainVersion: '1.0',
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid version format (not semver)', () => {
      const result = ManifestOverrideSchema.safeParse({
        minDevchainVersion: 'invalid-version',
      });
      expect(result.success).toBe(false);
    });

    it('rejects version with v prefix', () => {
      const result = ManifestOverrideSchema.safeParse({
        minDevchainVersion: 'v1.0.0',
      });
      expect(result.success).toBe(false);
    });

    it('allows minDevchainVersion to be omitted', () => {
      const result = ManifestOverrideSchema.safeParse({
        name: 'Test Template',
      });
      expect(result.success).toBe(true);
    });

    it('allows empty object (all fields optional)', () => {
      const result = ManifestOverrideSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe('minDevchainVersion passed through ExportWithOverridesSchema', () => {
    it('accepts manifest with minDevchainVersion', () => {
      const result = ExportWithOverridesSchema.safeParse({
        manifest: {
          name: 'My Template',
          minDevchainVersion: '0.4.0',
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.manifest?.minDevchainVersion).toBe('0.4.0');
      }
    });

    it('rejects invalid minDevchainVersion in nested manifest', () => {
      const result = ExportWithOverridesSchema.safeParse({
        manifest: {
          minDevchainVersion: 'not-valid',
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('strict mode', () => {
    it('rejects unknown fields', () => {
      const result = ManifestOverrideSchema.safeParse({
        minDevchainVersion: '0.4.0',
        unknownField: 'value',
      });
      expect(result.success).toBe(false);
    });
  });
});
