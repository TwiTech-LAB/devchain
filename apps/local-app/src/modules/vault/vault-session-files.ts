import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeSessionDirectory } from '../runtime-directory/runtime-directory.service';

/** A granted `file` entry's plaintext content; keep it in memory, never log it. */
export interface VaultSessionFile {
  readonly name: string;
  readonly content: Buffer;
}

/** Env var names only; the name becomes a file name inside the session directory. */
const SAFE_FILE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `<runtime dir>/session-files/<sessionId>/vault`. It lives inside the session
 * directory, so the runtime directory's teardown and startup sweep remove it.
 */
export function vaultSessionFilesDirectory(root: string, sessionId: string): string {
  return join(runtimeSessionDirectory(root, sessionId), 'vault');
}

export function vaultSessionFilePath(directory: string, name: string): string {
  if (!SAFE_FILE_NAME.test(name)) throw new Error('Vault entry name is not safe as a file name.');
  return join(directory, name);
}

/**
 * Writes `files` at their stable paths and removes files of names outside
 * `grantedNames`, but never the directory: overlapping callers with different subsets
 * share it. Each file goes to a unique temporary name first, then an atomic rename,
 * so a reader sees the old or the new value, never a partial one.
 */
export async function writeVaultSessionFiles(
  directory: string,
  files: readonly VaultSessionFile[],
  grantedNames: ReadonlySet<string>,
): Promise<void> {
  if (files.length > 0) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // `mkdir` applies the umask and leaves an existing directory as it is.
    await chmod(join(directory, '..'), 0o700);
    await chmod(directory, 0o700);
  }
  for (const file of files) {
    const path = vaultSessionFilePath(directory, file.name);
    // A `.` never occurs in an entry name, so a temporary file never shadows an entry.
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, file.content, { mode: 0o600, flag: 'wx' });
      await chmod(temp, 0o600);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
  let present: string[];
  try {
    present = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of present) {
    if (SAFE_FILE_NAME.test(name) && !grantedNames.has(name)) {
      await unlink(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
