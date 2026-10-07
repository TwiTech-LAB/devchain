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

    it('rejects invalid version format (missing patch)', () => {
      const result = ManifestOverrideSchema.safeParse({
        minDevchainVersion: '1.0',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('minDevchainVersion passed through ExportWithOverridesSchema', () => {
    it('rejects invalid minDevchainVersion in nested manifest', () => {
      const result = ExportWithOverridesSchema.safeParse({
        manifest: {
          minDevchainVersion: 'not-valid',
        },
      });
      expect(result.success).toBe(false);
    });
  });
});
