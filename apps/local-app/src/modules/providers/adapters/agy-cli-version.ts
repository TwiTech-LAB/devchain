export type AgyCliVersion = readonly [number, number, number];

/**
 * The first agy known to accept `--settings` with the `altScreenMode` key. 1.5.18 is the
 * oldest build verified: its `--help` lists `--settings`, and `--settings
 * '{"altScreenMode":"never"}'` keeps it inline over a saved `"always"`. No release note names
 * an earlier version, and an agy without the flag or the key exits at launch.
 */
export const AGY_INLINE_SETTINGS_MIN_VERSION: AgyCliVersion = [1, 5, 18];

/** The first `x.y.z` in `agy --version` output; null when there is none. */
export function parseVersion(text: string): AgyCliVersion | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: AgyCliVersion, b: AgyCliVersion): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}
