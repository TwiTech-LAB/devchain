import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LAUNCH_SCRIPT_DIRECTORY } from '../../../runtime-directory/runtime-directory.service';
import { quoteShellArg } from '../../../terminal/services/terminal-io/quote-shell-arg';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export const LAUNCH_SCRIPT_SHELL = '/bin/sh';

export function launchScriptPath(runtimeRoot: string): string {
  return join(runtimeRoot, LAUNCH_SCRIPT_DIRECTORY, `${randomUUID()}.sh`);
}

/**
 * The script deletes itself before `exec`, so the provider env never stays on disk once the
 * pane shell runs it. `exec` keeps the provider on the PID, process group and tty foreground
 * group that the pane shell gave to `/bin/sh`.
 *
 * `pathPrependDirs` are prepended to the pane shell's own inherited `$PATH`, expanded by
 * `/bin/sh` at run time — never baked in as a literal, so the session keeps the user's
 * shell environment (direnv, version managers, virtualenvs).
 */
export function renderLaunchScript(
  commandArgs: readonly string[],
  pathPrependDirs: readonly string[] = [],
): string {
  const lines = ['#!/bin/sh', '/bin/rm -f -- "$0"'];
  if (pathPrependDirs.length > 0) {
    lines.push(`export PATH=${pathPrependDirs.map(quoteShellArg).join(':')}:"$PATH"`);
  }
  lines.push(`exec ${commandArgs.map(quoteShellArg).join(' ')}`, '');
  return lines.join('\n');
}

export async function writeLaunchScript(
  path: string,
  commandArgs: readonly string[],
  pathPrependDirs: readonly string[] = [],
): Promise<void> {
  for (const directory of [dirname(dirname(path)), dirname(path)]) {
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
  }
  await writeFile(path, renderLaunchScript(commandArgs, pathPrependDirs), {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
    flag: 'wx',
  });
}
