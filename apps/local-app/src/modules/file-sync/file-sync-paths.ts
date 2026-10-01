import { homedir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';
import { ValidationError } from '../../common/errors/error-types';

/** The paths file sync reads and writes; injected so tests can give each instance its own. */
export interface FileSyncPaths {
  /** Config, keys, index and log of DevChain's own Syncthing instance. */
  syncthingHome(): string;
  /** The shared code folder of a project. */
  codeFolder(project: { id: string; rootPath: string }): string;
}

export const FILE_SYNC_PATHS = Symbol('FILE_SYNC_PATHS');

export function createProductionFileSyncPaths(home: string = homedir()): FileSyncPaths {
  return {
    syncthingHome: () => join(home, '.devchain', 'syncthing'),
    codeFolder: (project) => project.rootPath,
  };
}

/**
 * Rejects a folder that is HOME itself or contains it: sharing it would sync
 * every credential and config file under HOME.
 */
export function assertShareableFolder(path: string, home: string = homedir()): void {
  if (!isAbsolute(path)) {
    throw new ValidationError(`File sync folder ${path} is not an absolute path.`);
  }
  const fromFolderToHome = relative(resolve(path), resolve(home));
  if (
    fromFolderToHome === '' ||
    (!fromFolderToHome.startsWith('..') && !isAbsolute(fromFolderToHome))
  ) {
    throw new ValidationError(
      `File sync never shares ${path}: it is or contains the home directory.`,
    );
  }
}
