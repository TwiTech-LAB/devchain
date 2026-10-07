import { SLUG_PATTERN, SEMVER_PATTERN, isValidSlug, isValidVersion } from './template-validation';

describe('template-validation', () => {
  describe('SLUG_PATTERN', () => {
    it.each([
      ['should match alphanumeric slugs', ['mytemplate', 'MyTemplate123']],
      ['should match slugs with hyphens', ['my-template', 'claude-codex-advanced']],
      ['should match slugs with underscores', ['my_template', 'template_v2']],
      [
        'should match slugs with mixed hyphens and underscores',
        ['my-template_v2', 'my_template-v2'],
      ],
    ])('%s', (_name, inputs) => {
      for (const input of inputs) expect(SLUG_PATTERN.test(input)).toBe(true);
    });

    it('should reject slugs with special characters', () => {
      expect(SLUG_PATTERN.test('my/template')).toBe(false);
      expect(SLUG_PATTERN.test('../template')).toBe(false);
      expect(SLUG_PATTERN.test('template@1.0')).toBe(false);
      expect(SLUG_PATTERN.test('template.json')).toBe(false);
      expect(SLUG_PATTERN.test('template name')).toBe(false);
    });

    it('should reject empty strings', () => {
      expect(SLUG_PATTERN.test('')).toBe(false);
    });
  });

  describe('SEMVER_PATTERN', () => {
    it.each([
      ['should match basic semver versions', ['1.0.0', '2.1.3', '10.20.30']],
      [
        'should match versions with prerelease tags',
        ['1.0.0-alpha', '1.0.0-beta.1', '2.0.0-rc.1', '1.0.0-alpha.beta.1'],
      ],
      ['should match versions with build metadata', ['1.0.0+build.123', '1.0.0+20231215']],
      ['should match versions with prerelease and build metadata', ['1.0.0-beta.1+build.123']],
    ])('%s', (_name, inputs) => {
      for (const input of inputs) expect(SEMVER_PATTERN.test(input)).toBe(true);
    });

    it('should reject invalid version formats', () => {
      expect(SEMVER_PATTERN.test('1.0')).toBe(false);
      expect(SEMVER_PATTERN.test('1')).toBe(false);
      expect(SEMVER_PATTERN.test('v1.0.0')).toBe(false);
      expect(SEMVER_PATTERN.test('1.0.0.0')).toBe(false);
      expect(SEMVER_PATTERN.test('invalid')).toBe(false);
      expect(SEMVER_PATTERN.test('')).toBe(false);
    });
  });

  describe('isValidSlug', () => {
    it('should return false for invalid slugs', () => {
      expect(isValidSlug('../template')).toBe(false);
      expect(isValidSlug('template/path')).toBe(false);
      expect(isValidSlug('')).toBe(false);
    });
  });

  describe('isValidVersion', () => {
    it('should return false for invalid versions', () => {
      expect(isValidVersion('1.0')).toBe(false);
      expect(isValidVersion('v1.0.0')).toBe(false);
      expect(isValidVersion('')).toBe(false);
    });
  });
});
