import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { AppError } from '../../common/errors/error-types';
import { inside } from '../../common/filesystem/vm-home-path';

export const ListFoldersSchema = z
  .object({ path: z.string().min(1).max(4096).optional(), showHidden: z.boolean().default(false) })
  .strict();

export interface FolderListEntry {
  name: string;
  path: string;
  hidden: boolean;
  /** The entry is a link to a folder. */
  link: boolean;
}

export interface FolderList {
  path: string;
  /** Null at the home folder: the browser does not leave home. */
  parent: string | null;
  entries: FolderListEntry[];
}

export const FS_LIST_OUTSIDE_HOME = 'FS_LIST_OUTSIDE_HOME';
export const FS_LIST_NOT_FOUND = 'FS_LIST_NOT_FOUND';
export const FS_LIST_NOT_FOLDER = 'FS_LIST_NOT_FOLDER';
export const FS_LIST_UNREADABLE = 'FS_LIST_UNREADABLE';

/** The subfolders of a folder under this PC's home, sorted by name. Files are not listed. */
export async function listFolders(
  request: { path?: string; showHidden: boolean },
  home: string = homedir(),
): Promise<FolderList> {
  const canonicalHome = await realpath(home);
  const requested = resolve(request.path ?? home);
  const outside = () =>
    new AppError(`${requested} is outside the home folder.`, FS_LIST_OUTSIDE_HOME, 403, {
      path: requested,
    });
  if (!inside(requested, resolve(home)) && !inside(requested, canonicalHome)) throw outside();
  const path = await realpath(requested).catch((error: NodeJS.ErrnoException) => {
    throw readError(error, requested);
  });
  if (!inside(path, canonicalHome)) throw outside();
  const dirents = await readdir(path, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      throw readError(error, path);
    },
  );
  const entries: FolderListEntry[] = [];
  for (const dirent of dirents) {
    const hidden = dirent.name.startsWith('.');
    if (hidden && !request.showHidden) continue;
    const link = dirent.isSymbolicLink();
    const folder = link
      ? await stat(join(path, dirent.name)).then(
          (info) => info.isDirectory(),
          () => false,
        )
      : dirent.isDirectory();
    if (folder) entries.push({ name: dirent.name, path: join(path, dirent.name), hidden, link });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { path, parent: path === canonicalHome ? null : dirname(path), entries };
}

function readError(error: NodeJS.ErrnoException, path: string): AppError {
  if (error.code === 'ENOENT')
    return new AppError(`${path} does not exist.`, FS_LIST_NOT_FOUND, 404, { path });
  if (error.code === 'ENOTDIR')
    return new AppError(`${path} is not a folder.`, FS_LIST_NOT_FOLDER, 400, { path });
  return new AppError(
    `${path} cannot be read${error.code ? ` (${error.code})` : ''}.`,
    FS_LIST_UNREADABLE,
    403,
    { path },
  );
}
