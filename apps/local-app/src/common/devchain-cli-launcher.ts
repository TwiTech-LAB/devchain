import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** The CLI file of this app, or null where sessions get no `devchain` launcher. */
export const DEVCHAIN_CLI_PATH = Symbol('DEVCHAIN_CLI_PATH');

const MAX_LEVELS = 8;

/**
 * The CLI file that belongs to this app: the entry script when `devchain start` loaded
 * the app in its own process, else the packed `dist/cli.js` or the source checkout's
 * `scripts/cli.js` above this module. Null when none is found.
 */
export function findDevchainCli(
  entry: string | undefined = require.main?.filename,
  from: string = __dirname,
): string | null {
  if (entry && basename(entry) === 'cli.js' && existsSync(entry)) return entry;
  let dir = from;
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    // Packed: dist/cli.js next to dist/server. Source: scripts/cli.js at the workspace root.
    if (basename(dir) === 'dist' && existsSync(join(dir, 'server'))) {
      const packed = join(dir, 'cli.js');
      if (existsSync(packed)) return packed;
    }
    const source = join(dir, 'scripts', 'cli.js');
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(source)) return source;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The launcher directory in the instance's runtime directory, first on agent session PATH. */
export function devchainCliBin(runtimeRoot: string): string {
  return join(runtimeRoot, 'cli-bin');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes `<bin>/devchain`, which runs this app's CLI with this app's Node. A dev checkout
 * next to an installed DevChain thus gives its agents its own CLI, whatever PATH holds.
 */
export async function writeDevchainCliLauncher(
  bin: string,
  cliPath: string,
  nodePath: string = process.execPath,
): Promise<string> {
  const file = join(bin, 'devchain');
  const content = `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(cliPath)} "$@"\n`;
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current === content) return file;
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o755, flag: 'wx' });
    await chmod(temp, 0o755);
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  return file;
}
