import { mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { getDbConfig } from '../../storage/db/db.config';

/**
 * An empty directory under the DevChain data root for a provider CLI to run in. A project
 * directory would load that project's hooks, instruction files and MCP servers into the command.
 */
export async function ensurePrivateCwd(area: string, name: string): Promise<string> {
  const cwd = join(dirname(getDbConfig().dbPath), area, name);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}
