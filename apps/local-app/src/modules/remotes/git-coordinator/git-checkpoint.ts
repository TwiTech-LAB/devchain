import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';

const GITLINK_MODE = '160000';

/**
 * The environment of Git that DevChain runs itself. The executor replaces the environment, so
 * PATH must come along to find git; the bypass lets it past the shim.
 */
export function internalGitEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', DEVCHAIN_GIT_BYPASS: '1', ...extra };
}

/**
 * HEAD plus every loose and packed ref, and nothing else. Home and VM run the same commands
 * over the synced Git folder, so equal digests mean the VM has every ref. A ref may still name
 * an object that has not arrived; `missingObjects` checks that.
 */
export async function refsDigest(executor: ProcessExecutor, root: string): Promise<string> {
  const head = (await readFile(join(root, '.git', 'HEAD'), 'utf8')).trim();
  return createHash('sha256')
    .update(`HEAD ${head}\n${await refs(executor, root)}`)
    .digest('hex');
}

/**
 * A copy of the root index that another checkout can read alone: no split index, untracked
 * cache or fsmonitor data. Stages, including partial staging and conflicts, are kept. An empty
 * buffer means the repository has no index yet.
 */
export async function exportIndexSnapshot(
  executor: ProcessExecutor,
  root: string,
): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'devchain-index-'));
  const snapshot = join(directory, 'index');
  try {
    try {
      // Git replaces the index by rename, so one copy reads one complete version.
      await copyFile(join(root, '.git', 'index'), snapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    }
    await git(
      executor,
      root,
      [
        '-c',
        'core.splitIndex=false',
        '-c',
        'core.untrackedCache=false',
        '-c',
        'core.fsmonitor=false',
        'update-index',
        '--no-split-index',
        '--no-untracked-cache',
        '--no-fsmonitor',
      ],
      { GIT_INDEX_FILE: snapshot },
    );
    return await readFile(snapshot);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Objects that refs, a detached HEAD or the index file name and this repository lacks. */
export async function missingObjects(
  executor: ProcessExecutor,
  root: string,
  indexFile: string,
): Promise<string[]> {
  const ids = new Set<string>();
  const staged = await git(executor, root, ['ls-files', '--stage', '-z'], {
    GIT_INDEX_FILE: indexFile,
  });
  for (const entry of staged.split('\0')) {
    const [mode, id] = entry.split(' ', 2);
    // A gitlink names a submodule commit, which lives in the submodule's repository.
    if (id && mode !== GITLINK_MODE) ids.add(id);
  }
  for (const line of (await refs(executor, root)).split('\n')) {
    const id = line.split(' ', 1)[0];
    if (id) ids.add(id);
  }
  const head = (await readFile(join(root, '.git', 'HEAD'), 'utf8')).trim();
  if (!head.startsWith('ref: ')) ids.add(head);
  if (ids.size === 0) return [];
  const checked = await git(
    executor,
    root,
    ['cat-file', '--batch-check=%(objectname)'],
    {},
    `${[...ids].join('\n')}\n`,
  );
  return checked
    .split('\n')
    .filter((line) => line.endsWith(' missing'))
    .map((line) => line.slice(0, -' missing'.length));
}

function refs(executor: ProcessExecutor, root: string): Promise<string> {
  return git(executor, root, ['for-each-ref', '--format=%(objectname) %(refname)']);
}

async function git(
  executor: ProcessExecutor,
  root: string,
  args: string[],
  env: Record<string, string> = {},
  input?: string,
): Promise<string> {
  const result = await executor.run({
    argv: ['git', '-c', 'gc.auto=0', ...args],
    mode: 'pipe',
    cwd: root,
    // The executor replaces the environment, so user config such as fsmonitor hooks stays out.
    env: internalGitEnv({ GIT_OPTIONAL_LOCKS: '0', ...env }),
    timeout: 60_000,
    ...(input !== undefined && { input }),
  });
  if (!result.success) {
    const command = args.find((arg, index) => !arg.startsWith('-') && args[index - 1] !== '-c');
    throw new Error(`git ${command} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
