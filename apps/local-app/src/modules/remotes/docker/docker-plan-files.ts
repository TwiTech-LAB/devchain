import { lstat, opendir } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import type { DockerPlanSize } from './docker-plan.dto';

export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      rel !== '..' &&
      !isAbsolute(rel))
  );
}

/**
 * The project-anchored form (`/state/db`) used by managed exclusions and the import
 * inventory. The root itself is never a data subtree; callers remove it first.
 */
export function projectAnchoredPath(root: string, path: string): string {
  const rel = relative(root, path).split('\\').join('/');
  if (!rel) throw new Error('The project root has no project-anchored data path');
  return `/${rel}`;
}

/** lstat prevents symlinks from pulling unrelated trees into a bind's estimate. */
export async function measureDockerBind(
  path: string,
  deadline = Date.now() + 60_000,
  signal?: AbortSignal,
): Promise<DockerPlanSize> {
  const result: DockerPlanSize = { bytes: 0, unknown: false };
  const aborted = (): never => {
    throw signal?.reason ?? new Error('This operation was aborted');
  };
  const check = () => {
    if (signal?.aborted) aborted();
    if (Date.now() >= deadline) {
      result.unknown = true;
      return true;
    }
    return false;
  };
  async function walk(current: string): Promise<void> {
    if (check()) return;
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) return;
      if (stats.isFile()) {
        result.bytes += stats.size;
        return;
      }
      if (!stats.isDirectory()) {
        result.unknown = true;
        return;
      }
      const directory = await opendir(current);
      try {
        for await (const entry of directory) {
          if (check()) break;
          await walk(join(current, entry.name));
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
    } catch (error) {
      // A deadline miss surfaces as `unknown`; an abort must stop the walk.
      if (signal?.aborted) throw signal.reason ?? error;
      result.unknown = true;
    }
  }
  await walk(path);
  if (signal?.aborted) aborted();
  return result;
}
