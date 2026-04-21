import { access } from 'fs/promises';
import { constants } from 'fs';
import { isAbsolute } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function resolveBinary(name: string): Promise<string | null> {
  if (!name) return null;

  if (isAbsolute(name)) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }

  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(whichCmd, [name]);
    const discovered = stdout.trim().split(/\r?\n/)[0] || '';
    if (!discovered) return null;

    await access(discovered, constants.X_OK);
    return discovered;
  } catch {
    return null;
  }
}
