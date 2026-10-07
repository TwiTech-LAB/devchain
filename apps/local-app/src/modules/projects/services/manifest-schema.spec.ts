import { ManifestSchema } from '@devchain/shared';

describe('ManifestSchema semver validation', () => {
  it.each([
    ['minDevchainVersion', '0.4.0', true],
    ['minDevchainVersion', '1.0.0-beta.1', true],
    ['minDevchainVersion', '1.0.0+build.123', true],
    ['minDevchainVersion', '1.0', false],
    ['minDevchainVersion', 'invalid-version', false],
    ['minDevchainVersion', '01.0.0', false],
    ['version', 'v1.0.0', false],
    ['version', '', false],
  ])('validates %s = %s', (field, version, valid) => {
    const result = ManifestSchema.safeParse({ name: 'Test Template', [field]: version });
    expect(result.success).toBe(valid);
    if (!result.success) expect(result.error.issues[0].path).toEqual([field]);
  });
});
