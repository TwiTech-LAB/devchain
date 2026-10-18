import { ensurePrivateCwd } from '../../providers/utils/private-cwd';

/** The private working folder of one usage check (`<data root>/provider-usage/<name>`). */
export function ensureUsageCheckCwd(name: string): Promise<string> {
  return ensurePrivateCwd('provider-usage', name);
}
