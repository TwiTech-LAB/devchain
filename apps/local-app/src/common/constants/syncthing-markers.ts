/**
 * Entries Syncthing creates inside every shared folder root. They are not
 * project files or transcripts, and scanners of synced folders must skip them.
 */
export const SYNCTHING_MARKERS: readonly string[] = ['.stfolder', '.stignore', '.stversions'];

export function isSyncthingMarker(name: string): boolean {
  return SYNCTHING_MARKERS.includes(name);
}

/**
 * Names of the partial files Syncthing keeps next to a target while pulling
 * it and after an interrupted pull: `.syncthing.<name>.tmp` on Linux and
 * macOS, `~syncthing~<name>.tmp` on Windows. The forms here are git-exclude
 * patterns; `*` stands for the target's name.
 */
export const SYNCTHING_TEMP_PATTERNS: readonly string[] = ['.syncthing.*.tmp', '~syncthing~*.tmp'];

export function isSyncthingTemp(name: string): boolean {
  return SYNCTHING_TEMP_PATTERNS.some((pattern) => {
    const [prefix, suffix] = pattern.split('*');
    // The target's name must be non-empty: the two fixed parts alone must not
    // make up the whole name (`~syncthing~.tmp` is not a temp file).
    return (
      name.startsWith(prefix) &&
      name.endsWith(suffix) &&
      name.length - suffix.length > prefix.length
    );
  });
}
