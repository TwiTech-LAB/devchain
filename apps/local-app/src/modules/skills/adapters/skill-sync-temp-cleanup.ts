import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('SkillSyncTempCleanup');

/** A GitHub skill sync works in <tmpdir>/skills-<source>-XXXXXX, which holds only these entries. */
export const SKILL_SYNC_TEMP_PREFIX = 'skills-';
export const SKILL_SYNC_ARCHIVE_FILE = 'repo.tar.gz';
export const SKILL_SYNC_EXTRACT_DIR = 'repo';
export const STALE_SKILL_SYNC_DIR_MAX_AGE_MS = 60 * 60 * 1000;

const SKILL_SYNC_DIR_PATTERN = new RegExp(
  `^${SKILL_SYNC_TEMP_PREFIX}[a-zA-Z0-9_-]+-[a-zA-Z0-9]{6}$`,
);
const SKILL_SYNC_ENTRIES = new Set([SKILL_SYNC_ARCHIVE_FILE, SKILL_SYNC_EXTRACT_DIR]);

export async function cleanupStaleSkillSyncDirectories(
  rootDir = tmpdir(),
  maxAgeMs = STALE_SKILL_SYNC_DIR_MAX_AGE_MS,
): Promise<void> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !SKILL_SYNC_DIR_PATTERN.test(entry.name)) {
        continue;
      }
      const path = join(rootDir, entry.name);
      try {
        const stats = await fs.lstat(path);
        if (!stats.isDirectory() || Date.now() - stats.mtimeMs <= maxAgeMs) continue;
        const contents = await fs.readdir(path);
        if (contents.some((name) => !SKILL_SYNC_ENTRIES.has(name))) continue;
        await fs.rm(path, { recursive: true, force: true });
      } catch (error) {
        logger.warn({ path, error }, 'Failed to clean stale skill sync directory');
      }
    }
  } catch (error) {
    logger.warn({ rootDir, error }, 'Failed to scan skill sync temp directories');
  }
}
