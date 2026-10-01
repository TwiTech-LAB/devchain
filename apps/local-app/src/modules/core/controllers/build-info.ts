import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildInfo {
  commit: string | null;
  dirty: boolean | null;
  builtAt: string;
}

const BUILD_INFO_FILE = join(__dirname, '../../../../build-info.json');
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Reads the stamp scripts/copy-cli.js writes into a packed CLI. Returns null for a source run
 * (no stamp) or a malformed stamp; commit and dirty are null together when the package was
 * built without Git metadata.
 */
export function readBuildInfo(file = BUILD_INFO_FILE): BuildInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const { commit, dirty, builtAt } = parsed as Record<string, unknown>;
    if (commit !== null && (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit))) {
      return null;
    }
    if (dirty !== null && typeof dirty !== 'boolean') return null;
    if ((commit === null) !== (dirty === null)) return null;
    // An unparsable builtAt makes toISOString() throw, which lands in the catch below.
    if (typeof builtAt !== 'string' || new Date(builtAt).toISOString() !== builtAt) return null;

    return { commit, dirty, builtAt };
  } catch {
    return null;
  }
}
