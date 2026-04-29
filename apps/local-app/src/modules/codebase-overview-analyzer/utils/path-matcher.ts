/**
 * Returns true when `filePath` is exactly `folder` or is nested inside it.
 * Both inputs are normalised to forward-slash before comparison; a trailing
 * slash on `folder` is stripped so callers don't need to worry about it.
 *
 * Examples (all true):
 *   isUnderFolder('dist/bundle.js', 'dist')
 *   isUnderFolder('src/generated', 'src/generated')
 *   isUnderFolder('src/generated/model.ts', 'src/generated')
 *   isUnderFolder('packages/foo/dist/out.js', 'packages/foo/dist')
 *
 * False-positive guard (all false):
 *   isUnderFolder('srcGenerated/foo.ts', 'src/generated')
 *   isUnderFolder('src/generatedExtra/a.ts', 'src/generated')
 */
export function isUnderFolder(filePath: string, folder: string): boolean {
  const f = filePath.replace(/\\/g, '/');
  const target = folder.replace(/\\/g, '/').replace(/\/+$/, '');
  return f === target || f.startsWith(target + '/');
}

/**
 * Returns true when `filePath` is under any of the provided `folders`.
 * Accepts both arrays and sets; iteration short-circuits on first match.
 */
export function isUnderAnyFolder(
  filePath: string,
  folders: ReadonlyArray<string> | ReadonlySet<string>,
): boolean {
  for (const folder of folders) {
    if (isUnderFolder(filePath, folder)) return true;
  }
  return false;
}
