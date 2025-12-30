/**
 * Centralized validation rules for template slugs and versions.
 *
 * These patterns are shared across controllers and services to ensure
 * consistent validation behavior throughout the application.
 */

/**
 * Slug validation pattern.
 * Allows: alphanumeric characters, hyphens, and underscores.
 * Examples: "my-template", "template_v2", "claude-codex-advanced"
 */
export const SLUG_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Semver validation pattern.
 * Allows: major.minor.patch with optional prerelease and build metadata.
 * Examples: "1.0.0", "2.1.3-beta.1", "1.0.0+build.123"
 */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;

/**
 * Validate a template slug.
 * @param slug - The slug to validate
 * @returns true if valid, false otherwise
 */
export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * Validate a semver version string.
 * @param version - The version to validate
 * @returns true if valid, false otherwise
 */
export function isValidVersion(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}

/**
 * Error messages for validation failures.
 */
export const VALIDATION_MESSAGES = {
  INVALID_SLUG: 'Slug must contain only alphanumeric characters, hyphens, and underscores',
  INVALID_VERSION: 'Version must be in semver format (e.g., 1.0.0, 1.0.0-beta.1)',
} as const;
