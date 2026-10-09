import { chmodSync, existsSync } from 'node:fs';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('DbFilePermissions');

export function restrictDatabaseFilePermissions(dbPath: string): void {
  // SQLite inherits the main file's mode for new WAL/SHM files; run before WAL pragmas.
  for (const [file, suffix] of [
    ['database', ''],
    ['wal', '-wal'],
    ['shm', '-shm'],
  ]) {
    const path = `${dbPath}${suffix}`;
    if (suffix && !existsSync(path)) continue;
    try {
      chmodSync(path, 0o600);
    } catch {
      logger.warn({ file }, 'Could not set SQLite file permissions to 0600');
    }
  }
}
