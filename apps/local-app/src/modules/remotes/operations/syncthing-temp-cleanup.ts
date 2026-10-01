import { opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isSyncthingTemp } from '../../../common/constants/syncthing-markers';
import { createLogger } from '../../../common/logging/logger';
import { isIgnored, parseIgnoreRules } from '../host-install/project-size.service';

const logger = createLogger('SyncthingTempCleanup');

/** Bounds the whole walk: a Disconnect step must not stall on leftover files. */
export const SYNCTHING_TEMP_CLEANUP_TIMEOUT_MS = 30_000;

class TempCleanupStoppedError extends Error {
  constructor() {
    super('Syncthing temp-file cleanup reached its time limit');
    this.name = 'TempCleanupStoppedError';
  }
}

/**
 * Best-effort deletion of Syncthing's partial-pull temp files under `rootPath`
 * at home. Disconnect pauses home's folders, and Syncthing deletes an old temp
 * file only while scanning, so its own cleanup cannot run there until the next
 * Connect. Directories the code folder ignores by plain name hold no temp
 * files — Syncthing never pulls into them — so the walk skips them; rooted and
 * glob-ignored paths are still entered, because `parseIgnoreRules` keeps plain
 * names only. Never throws: an error or the time limit logs a warning with the
 * number of files already deleted, and the count is returned either way.
 */
export async function deleteSyncthingTempFiles(
  rootPath: string,
  ignores: readonly string[],
  timeoutMs = SYNCTHING_TEMP_CLEANUP_TIMEOUT_MS,
): Promise<number> {
  const { rules } = parseIgnoreRules(ignores);
  const startedAt = Date.now();
  const expired = () => {
    if (Date.now() - startedAt >= timeoutMs) throw new TempCleanupStoppedError();
  };
  let deleted = 0;

  const walk = async (directoryPath: string): Promise<void> => {
    expired();
    const directory = await opendir(directoryPath);
    try {
      for await (const entry of directory) {
        expired();
        // A directory entry knows its own kind: no stat, and a symlink entry
        // is neither file nor directory here, so links are never followed.
        if (entry.isSymbolicLink() || isIgnored(entry.name, rules)) continue;
        if (entry.isDirectory()) await walk(join(directoryPath, entry.name));
        else if (entry.isFile() && isSyncthingTemp(entry.name)) {
          await rm(join(directoryPath, entry.name));
          deleted += 1;
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const walking = walk(rootPath);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TempCleanupStoppedError()), timeoutMs);
    });
    await Promise.race([walking, timeout]);
  } catch (error) {
    if (error instanceof TempCleanupStoppedError) {
      logger.warn({ rootPath, deleted }, 'Syncthing temp-file cleanup stopped at its time limit');
    } else {
      logger.warn(
        { rootPath, deleted, error: error instanceof Error ? error.message : String(error) },
        'Syncthing temp-file cleanup failed',
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return deleted;
}
