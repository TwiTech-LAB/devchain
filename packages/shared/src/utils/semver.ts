/**
 * Semantic versioning utilities for template version management.
 * Lightweight implementation without external dependencies.
 */

/** Parsed semantic version */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  build?: string;
}

/** Regex pattern for valid semver strings */
const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Parse a semver string into its components.
 * @param version - Version string (e.g., "1.2.3", "1.0.0-beta.1")
 * @returns Parsed SemVer object or null if invalid
 */
export function parseSemVer(version: string): SemVer | null {
  const match = version.match(SEMVER_REGEX);
  if (!match) return null;

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || undefined,
    build: match[5] || undefined,
  };
}

/**
 * Check if a string is a valid semver version.
 * @param version - Version string to validate
 */
export function isValidSemVer(version: string): boolean {
  return SEMVER_REGEX.test(version);
}

/**
 * Compare two semver versions.
 * @param a - First version
 * @param b - Second version
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 * @throws Error if either version is invalid
 */
export function compareSemVer(a: string, b: string): -1 | 0 | 1 {
  const parsedA = parseSemVer(a);
  const parsedB = parseSemVer(b);

  if (!parsedA) throw new Error(`Invalid semver: ${a}`);
  if (!parsedB) throw new Error(`Invalid semver: ${b}`);

  // Compare major, minor, patch
  if (parsedA.major !== parsedB.major) {
    return parsedA.major > parsedB.major ? 1 : -1;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor > parsedB.minor ? 1 : -1;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch > parsedB.patch ? 1 : -1;
  }

  // Prerelease versions have lower precedence than normal versions
  // (1.0.0-alpha < 1.0.0)
  if (parsedA.prerelease && !parsedB.prerelease) return -1;
  if (!parsedA.prerelease && parsedB.prerelease) return 1;

  // Compare prerelease identifiers
  if (parsedA.prerelease && parsedB.prerelease) {
    const partsA = parsedA.prerelease.split('.');
    const partsB = parsedB.prerelease.split('.');

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const partA = partsA[i];
      const partB = partsB[i];

      if (partA === undefined) return -1;
      if (partB === undefined) return 1;

      const numA = parseInt(partA, 10);
      const numB = parseInt(partB, 10);

      // Both numeric
      if (!isNaN(numA) && !isNaN(numB)) {
        if (numA !== numB) return numA > numB ? 1 : -1;
      }
      // Numeric identifiers have lower precedence than alphanumeric
      else if (!isNaN(numA)) return -1;
      else if (!isNaN(numB)) return 1;
      // Both alphanumeric - compare lexically
      else {
        if (partA !== partB) return partA > partB ? 1 : -1;
      }
    }
  }

  return 0;
}

/**
 * Check if version a is greater than version b.
 */
export function isGreaterThan(a: string, b: string): boolean {
  return compareSemVer(a, b) === 1;
}

/**
 * Check if version a is less than version b.
 */
export function isLessThan(a: string, b: string): boolean {
  return compareSemVer(a, b) === -1;
}

/**
 * Check if two versions are equal (ignoring build metadata).
 */
export function isEqual(a: string, b: string): boolean {
  return compareSemVer(a, b) === 0;
}

/**
 * Sort an array of version strings in ascending order.
 * Invalid versions are sorted to the end.
 */
export function sortVersions(versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    try {
      return compareSemVer(a, b);
    } catch {
      // Invalid versions go to the end
      if (!isValidSemVer(a)) return 1;
      if (!isValidSemVer(b)) return -1;
      return 0;
    }
  });
}

/**
 * Get the latest version from an array of version strings.
 * @param versions - Array of version strings
 * @returns The latest version or null if array is empty or all versions invalid
 */
export function getLatestVersion(versions: string[]): string | null {
  const valid = versions.filter(isValidSemVer);
  if (valid.length === 0) return null;
  const sorted = sortVersions(valid);
  return sorted[sorted.length - 1];
}

/**
 * Format a SemVer object back to a string.
 */
export function formatSemVer(version: SemVer): string {
  let str = `${version.major}.${version.minor}.${version.patch}`;
  if (version.prerelease) str += `-${version.prerelease}`;
  if (version.build) str += `+${version.build}`;
  return str;
}
