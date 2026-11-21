import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { AppError } from '../../common/errors/error-types';
import { assertVmHomePath, inside, nearestExisting } from '../../common/filesystem/vm-home-path';
import {
  OPENCODE_AUTH_FILE_PATH,
  OPENCODE_DB_FILE_PATH,
  PROVIDER_AUTH_ADAPTERS,
} from '../provider-auth/provider-auth-adapters';
import {
  AUTHORIZED_KEYS_FILE,
  CLAUDE_SETTINGS_FILE,
  REFUSED_FILES,
  SSH_DIRECTORY,
  getDevinUserConfigPath,
} from '../remotes/host/host-home-files';
import { assertShareableFolder } from './file-sync-paths';
import { shareFolderIdOf } from './file-sync.dto';

export const SHARE_PATH_REFUSED = 'FILE_SYNC_SHARE_PATH_REFUSED';

/**
 * The share id of a folder: both sides compute it from the absolute path they receive, so it
 * must not depend on how either side resolves links.
 */
export function shareId(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex').slice(0, 16);
}

export function shareFolderId(path: string): string {
  return shareFolderIdOf(shareId(path));
}

/**
 * Home files DevChain writes or that hold a VM's identity or logins. A share may not be, contain
 * or sit inside any of them.
 */
export function managedHomePaths(home: string = homedir()): string[] {
  const providerFiles = Object.values(PROVIDER_AUTH_ADAPTERS).flatMap((spec) => {
    if (spec.payloadKind === 'files') return [spec.filePath];
    if (spec.payloadKind === 'env' && spec.claimFile) return [spec.claimFile.path];
    return [];
  });
  return [
    ...new Set([
      ...[
        ...REFUSED_FILES,
        CLAUDE_SETTINGS_FILE,
        ...providerFiles,
        OPENCODE_AUTH_FILE_PATH,
        OPENCODE_DB_FILE_PATH,
        join(SSH_DIRECTORY, AUTHORIZED_KEYS_FILE),
      ].map((file) => join(home, file)),
      getDevinUserConfigPath(home),
    ]),
  ];
}

/** What else on one side a share must not overlap. */
export interface ShareSideFolders {
  /** This instance's data folder; `~/.devchain` is refused as well. */
  devchainHome: string;
  /** Every project root in this instance's catalog. */
  projectRoots: readonly string[];
  /** Every other share on this side. The share being checked must not be in the list. */
  otherShares: readonly string[];
}

/**
 * Refuses a share path that is home or outside it, is a link or under one, or overlaps DevChain
 * data, a project, another share or a managed home file. Returns the path with links resolved.
 */
export async function assertSharePath(
  path: string,
  side: ShareSideFolders,
  home: string = homedir(),
): Promise<string> {
  assertShareableFolder(path, home);
  const absolute = resolve(path);
  const { existing, resolved } = await assertVmHomePath(
    absolute,
    {
      code: SHARE_PATH_REFUSED,
      message: `Cannot share ${absolute}: shared folders must be inside the home folder, not the home folder itself.`,
      linkMessage: `Cannot share ${absolute}: the folder or one of its parents is a link.`,
      rejectAncestorLinks: true,
    },
    resolve(home),
  );
  const canonical = join(resolved, relative(existing, absolute));
  const reserved: Array<{ path: string; what: string }> = [
    ...[join(home, '.devchain'), side.devchainHome].map((dir) => ({
      path: dir,
      what: 'the DevChain data folder',
    })),
    ...managedHomePaths(home).map((file) => ({ path: file, what: 'a file DevChain manages' })),
    ...side.projectRoots
      // A project at or above home can never be synced, so a share cannot collide with it.
      .filter((root) => !inside(resolve(home), resolve(root)))
      .map((root) => ({ path: root, what: 'a project folder' })),
    ...side.otherShares.map((share) => ({ path: share, what: 'another shared folder' })),
  ];
  // canonicalPath never rejects, so resolving all at once keeps the first overlap in list order.
  const others = await Promise.all(reserved.map((entry) => canonicalPath(entry.path)));
  for (const [index, entry] of reserved.entries()) {
    const other = others[index];
    if (inside(canonical, other) || inside(other, canonical))
      throw new AppError(
        `Cannot share ${absolute}: it overlaps ${entry.what}, ${entry.path}.`,
        SHARE_PATH_REFUSED,
        403,
      );
  }
  return canonical;
}

/** The path with the links of its existing part resolved; a missing tail is kept as written. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    const existing = await nearestExisting(absolute);
    return join(await realpath(existing), relative(existing, absolute));
  } catch {
    return absolute;
  }
}
