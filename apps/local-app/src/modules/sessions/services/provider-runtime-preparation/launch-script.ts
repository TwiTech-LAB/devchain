import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { quoteShellArg } from '../../../terminal/services/terminal-io/quote-shell-arg';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Runtime-context root; launch scripts go to its `launch/` directory. */
export const PROVIDER_LAUNCH_SCRIPT_ROOT = Symbol('PROVIDER_LAUNCH_SCRIPT_ROOT');

export const LAUNCH_SCRIPT_SHELL = '/bin/sh';

export function launchScriptPath(runtimeRoot: string): string {
  return join(runtimeRoot, 'launch', `${randomUUID()}.sh`);
}

/**
 * The script deletes itself before `exec`, so the provider env never stays on disk once the
 * pane shell runs it. `exec` keeps the provider on the PID, process group and tty foreground
 * group that the pane shell gave to `/bin/sh`.
 */
export function renderLaunchScript(commandArgs: readonly string[]): string {
  return [
    '#!/bin/sh',
    '/bin/rm -f -- "$0"',
    `exec ${commandArgs.map(quoteShellArg).join(' ')}`,
    '',
  ].join('\n');
}

export async function writeLaunchScript(
  path: string,
  commandArgs: readonly string[],
): Promise<void> {
  for (const directory of [dirname(dirname(path)), dirname(path)]) {
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
  }
  await writeFile(path, renderLaunchScript(commandArgs), {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
    flag: 'wx',
  });
}
