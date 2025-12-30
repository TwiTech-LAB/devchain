import {
  SLUG_PATTERN,
  SEMVER_PATTERN,
  isValidSlug,
  isValidVersion,
  VALIDATION_MESSAGES,
} from './template-validation';

describe('template-validation', () => {
  describe('SLUG_PATTERN', () => {
    it('should match alphanumeric slugs', () => {
      expect(SLUG_PATTERN.test('mytemplate')).toBe(true);
      expect(SLUG_PATTERN.test('MyTemplate123')).toBe(true);
    });

    it('should match slugs with hyphens', () => {
      expect(SLUG_PATTERN.test('my-template')).toBe(true);
      expect(SLUG_PATTERN.test('claude-codex-advanced')).toBe(true);
    });

    it('should match slugs with underscores', () => {
      expect(SLUG_PATTERN.test('my_template')).toBe(true);
      expect(SLUG_PATTERN.test('template_v2')).toBe(true);
    });

    it('should match slugs with mixed hyphens and underscores', () => {
      expect(SLUG_PATTERN.test('my-template_v2')).toBe(true);
      expect(SLUG_PATTERN.test('my_template-v2')).toBe(true);
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
    it('should match basic semver versions', () => {
      expect(SEMVER_PATTERN.test('1.0.0')).toBe(true);
      expect(SEMVER_PATTERN.test('2.1.3')).toBe(true);
      expect(SEMVER_PATTERN.test('10.20.30')).toBe(true);
    });

    it('should match versions with prerelease tags', () => {
      expect(SEMVER_PATTERN.test('1.0.0-alpha')).toBe(true);
      expect(SEMVER_PATTERN.test('1.0.0-beta.1')).toBe(true);
      expect(SEMVER_PATTERN.test('2.0.0-rc.1')).toBe(true);
      expect(SEMVER_PATTERN.test('1.0.0-alpha.beta.1')).toBe(true);
    });

    it('should match versions with build metadata', () => {
      expect(SEMVER_PATTERN.test('1.0.0+build.123')).toBe(true);
      expect(SEMVER_PATTERN.test('1.0.0+20231215')).toBe(true);
    });

    it('should match versions with prerelease and build metadata', () => {
      expect(SEMVER_PATTERN.test('1.0.0-beta.1+build.123')).toBe(true);
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
    it('should return true for valid slugs', () => {
      expect(isValidSlug('my-template')).toBe(true);
      expect(isValidSlug('my_template')).toBe(true);
      expect(isValidSlug('mytemplate123')).toBe(true);
    });

    it('should return false for invalid slugs', () => {
      expect(isValidSlug('../template')).toBe(false);
      expect(isValidSlug('template/path')).toBe(false);
      expect(isValidSlug('')).toBe(false);
    });
  });

  describe('isValidVersion', () => {
    it('should return true for valid versions', () => {
      expect(isValidVersion('1.0.0')).toBe(true);
      expect(isValidVersion('1.0.0-beta.1')).toBe(true);
      expect(isValidVersion('1.0.0+build')).toBe(true);
    });

    it('should return false for invalid versions', () => {
      expect(isValidVersion('1.0')).toBe(false);
      expect(isValidVersion('v1.0.0')).toBe(false);
      expect(isValidVersion('')).toBe(false);
    });
  });

  describe('VALIDATION_MESSAGES', () => {
    it('should have required message keys', () => {
      expect(VALIDATION_MESSAGES.INVALID_SLUG).toBeDefined();
      expect(VALIDATION_MESSAGES.INVALID_VERSION).toBeDefined();
    });

    it('should contain descriptive messages', () => {
      expect(VALIDATION_MESSAGES.INVALID_SLUG).toContain('alphanumeric');
      expect(VALIDATION_MESSAGES.INVALID_VERSION).toContain('semver');
    });
  });
});
