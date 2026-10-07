import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, sep } from 'node:path';
import { AppError } from '../errors/error-types';

/** The root itself, or a path below it. */
export function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/** The path or its nearest existing ancestor, never climbing past `stop`. */
export async function nearestExisting(path: string, stop?: string): Promise<string> {
  for (let candidate = path; ; candidate = dirname(candidate)) {
    try {
      // lstat distinguishes a dangling symlink from a destination not created yet.
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === stop) throw error;
    }
  }
}

/** Resolve missing destinations through their existing parent so links cannot escape the VM home. */
export async function assertVmHomePath(
  path: string,
  refusal: { code: string; message: string; linkMessage: string; rejectAncestorLinks?: boolean },
  home = homedir(),
): Promise<{ existing: string; resolved: string }> {
  const canonicalHome = await realpath(home);
  if (path === home || !inside(path, home)) throw new AppError(refusal.message, refusal.code, 403);
  if (refusal.rejectAncestorLinks) {
    for (let candidate = path; candidate !== home; candidate = dirname(candidate)) {
      const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (info?.isSymbolicLink()) throw new AppError(refusal.linkMessage, refusal.code, 403);
    }
  }
  const existing = await nearestExisting(path);
  const resolved = await realpath(existing);
  if (!inside(resolved, canonicalHome)) throw new AppError(refusal.message, refusal.code, 403);
  if (existing === path && (await lstat(path)).isSymbolicLink())
    throw new AppError(refusal.linkMessage, refusal.code, 403);
  return { existing, resolved };
}
