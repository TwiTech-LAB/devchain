import { appendFile, mkdir, readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import type { ProcessExecutor } from '../modules/terminal/services/process-executor/process-executor.port';

/**
 * In a git repository, add project-relative paths to the repository's exclude
 * file once each, so `git add -A` never commits machine-local files that
 * DevChain writes into a project. `--git-path` resolves the common exclude file
 * from a linked worktree, and `--show-prefix` keeps the patterns relative to
 * the repository root when the project is a subfolder.
 *
 * Returns the added patterns. A project outside git (or a host without git) is
 * skipped and returns `[]`. File errors propagate; callers that must not fail
 * catch them.
 */
export async function addToGitExclude(
  executor: ProcessExecutor,
  projectRootPath: string,
  files: readonly string[],
): Promise<string[]> {
  const result = await executor.run({
    argv: ['git', 'rev-parse', '--show-prefix', '--git-path', 'info/exclude'],
    mode: 'pipe',
    cwd: projectRootPath,
    timeout: 10_000,
  });
  if (result.exitCode !== 0) return [];
  const [prefix = '', gitPath] = result.stdout.split('\n');
  if (!gitPath) return [];

  const excludePath = resolve(projectRootPath, gitPath);
  let existing = '';
  try {
    existing = await readFile(excludePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = files
    .map((file) => `${prefix}${file}`)
    .filter((pattern) => !lines.has(pattern) && !lines.has(`/${pattern}`));
  if (missing.length === 0) return [];

  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await mkdir(dirname(excludePath), { recursive: true });
  await appendFile(excludePath, `${separator}${missing.join('\n')}\n`, 'utf-8');
  return missing;
}
