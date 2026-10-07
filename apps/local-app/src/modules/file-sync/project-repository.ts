import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type ProjectRepository = 'repository' | 'missing' | 'worktree';

/**
 * A `.git` folder is a repository only when Git can use it: it has HEAD, `objects/` and
 * `refs/`, the same test Git applies (it follows symbolic links inside `.git`). A failed
 * `git init` can leave HEAD without `objects/`; that counts as missing, so the next attempt
 * runs `git init` again, which completes a partial or existing repository without
 * overwriting it. A `.git` file or symbolic link keeps the Git directory elsewhere, like a
 * worktree: DevChain neither creates nor shares it.
 */
export async function projectRepository(root: string): Promise<ProjectRepository> {
  try {
    const git = await lstat(join(root, '.git'));
    if (!git.isDirectory()) return 'worktree';
    const [, objects, refs] = await Promise.all(
      ['HEAD', 'objects', 'refs'].map((name) => stat(join(root, '.git', name))),
    );
    return objects.isDirectory() && refs.isDirectory() ? 'repository' : 'missing';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}
