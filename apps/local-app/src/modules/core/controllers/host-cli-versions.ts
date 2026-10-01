import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getEnvConfig } from '../../../common/config/env.config';

const CLI_NAMES = ['claude', 'codex', 'copilot', 'opencode', 'agy'] as const;

export function readHostCliVersions(
  file = join(getEnvConfig().DEVCHAIN_HOST_ETC_DIR, 'claim.json'),
): Record<string, string> | null {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as { cliVersions?: unknown };
    const versions = record.cliVersions;
    if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return null;
    const result: Record<string, string> = {};
    for (const name of CLI_NAMES) {
      const version = (versions as Record<string, unknown>)[name];
      if (typeof version !== 'string' || version.length === 0) return null;
      result[name] = version;
    }
    return result;
  } catch {
    return null;
  }
}
