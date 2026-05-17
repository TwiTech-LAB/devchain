import { access } from 'fs/promises';
import { constants } from 'fs';
import { isAbsolute } from 'path';
import type { ProcessExecutor } from '../modules/terminal/services/process-executor/process-executor.port';

export async function resolveBinary(
  name: string,
  executor?: ProcessExecutor,
): Promise<string | null> {
  if (!name) return null;

  if (isAbsolute(name)) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }

  if (!executor) return null;

  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = await executor.run({ argv: [whichCmd, name], mode: 'pipe' });
    if (!result.success) return null;
    const discovered = result.stdout.trim().split(/\r?\n/)[0] || '';
    if (!discovered) return null;

    await access(discovered, constants.X_OK);
    return discovered;
  } catch {
    return null;
  }
}
