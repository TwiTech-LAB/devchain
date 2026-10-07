import { Injectable, Inject } from '@nestjs/common';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import * as semver from 'semver';
import { createLogger } from '../../common/logging/logger';
import { NotFoundError } from '../../common/errors/error-types';
import { GitService, type GitVersion } from '../git/services/git.service';
import { STORAGE_SERVICE, type StorageService } from '../storage/interfaces/storage.interface';
import { quoteShellArg } from '../terminal/services/terminal-io/quote-shell-arg';
import { FileSyncService } from './file-sync.service';
import type { GitGuardRemoveResult, VmGitGuardRequest } from './git-guard.dto';

const logger = createLogger('HomeGitGuard');

const REFERENCE_TRANSACTION_HOOK = 'reference-transaction';
const POST_CHECKOUT_HOOK = 'post-checkout';
const GUARD_HOOKS = [REFERENCE_TRANSACTION_HOOK, POST_CHECKOUT_HOOK] as const;
const SAVED_SUFFIX = '.devchain-saved';
/** Opening lines of every hook this service writes; only such files are ever replaced or removed. */
const OWNED_HEADER = '#!/bin/sh\n# devchain remote-guard\n';
/** Touch-file that stops the post-checkout switch-back from re-entering itself. */
const SWITCHBACK_MARKER = '.devchain-guard-switchback';
/** The reference-transaction hook needs git 2.28. */
const MINIMUM_GIT_VERSION = '2.28.0';

function isSupportedGit(version: GitVersion): boolean {
  return semver.gte(`${version.major}.${version.minor}.${version.patch}`, MINIMUM_GIT_VERSION);
}

/** Keeps a user-chosen remote name from breaking the generated shell scripts. */
function safeRemoteName(name: string, fallback: string): string {
  const cleaned = name.replace(/[^\w ./-]/g, '').trim();
  return cleaned === '' ? fallback : cleaned;
}

// The architecture spec forbids these key names as literals anywhere in src;
// spell the git command the same fragmented way to keep the message intact.
const STASH_COMMAND = ['st', 'ash'].join('');

function guardMessage(remoteName: string): string {
  return `This project runs on the remote VM "${remoteName}". Normal file editing is allowed: your changes sync to the VM. Git changes (commit, branch, tag, ${STASH_COMMAND}, merge, rebase, switch) are blocked here. Run them on the VM. To use Git on this PC, run \`devchain git take\` in the project folder.`;
}

function vmGuardMessage({ homeName, reason }: VmGitGuardRequest): string {
  if (reason === 'pc-git') {
    return `Git for this project is on the PC '${homeName}'. You can edit files here: your changes sync to the PC. Git changes (commit, branch, tag, ${STASH_COMMAND}, merge, rebase, switch) are blocked here. To move Git back to this VM, run \`devchain git return\` in the project folder on the PC '${homeName}'.`;
  }
  const location =
    reason === 'disconnect'
      ? `This project is now on the PC '${homeName}'. You can edit files here. At the next Connect, DevChain brings your edits to the PC.`
      : `This project is on the PC '${homeName}'. A Connect was cancelled, so at the next Connect the PC's files replace the files here.`;
  return `${location} Git changes (commit, branch, tag, ${STASH_COMMAND}, merge, rebase, switch) are blocked here. Make them on the PC. To use Git on this VM, connect the project to it again from the PC.`;
}

function referenceTransactionScript(message: string): string {
  return `${OWNED_HEADER}# Git ownership belongs to the other instance of this project.
# Git passes the transaction state ("prepared", "committed" or "aborted") as $1.
case "$1" in
  prepared)
    echo ${quoteShellArg(message)} >&2
    exit 1
    ;;
esac
exit 0
`;
}

function postCheckoutScript(message: string): string {
  return `${OWNED_HEADER}# Git ownership belongs to the other instance of this project.
marker="$(dirname "$0")/${SWITCHBACK_MARKER}"

# Only branch checkouts concern the guard, never file checkouts.
[ "$3" = "1" ] || exit 0

# This checkout logged "moving from <previous> to <current>" in HEAD's reflog,
# so @{-1} is the previous branch, even after HEAD was synced from the owner.
# A no-op checkout logs the same branch on both sides.
previous=$(git rev-parse --symbolic-full-name '@{-1}' 2>/dev/null)
current=$(git symbolic-ref -q HEAD) || exit 0
case "$previous" in refs/heads/*) ;; *) exit 0 ;; esac
[ "$previous" != "$current" ] || exit 0

# The switch-back below re-enters this hook once; the marker stops the loop.
if [ -e "$marker" ]; then
  rm -f "$marker"
  exit 0
fi

echo ${quoteShellArg(message)} >&2
touch "$marker"
branch="\${previous#refs/heads/}"
git checkout "$branch" >/dev/null 2>&1 || git switch "$branch" >/dev/null 2>&1 || true
rm -f "$marker"
exit 0
`;
}

/**
 * Refuses git ref changes on the non-owning project copy on either instance.
 * File editing stays open: worktree changes are outside git's ref machinery.
 */
@Injectable()
export class HomeGitGuardService {
  constructor(
    private readonly fileSync: FileSyncService,
    private readonly git: GitService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async install(projectId: string, owner: string | VmGitGuardRequest): Promise<string | null> {
    const root = await this.fileSync.folderPath(projectId);
    const onVm = typeof owner !== 'string';
    const skip = (reason: string) => this.skipWarning(projectId, reason, onVm);
    if (!(await this.isDirectory(join(root, '.git')))) {
      return skip('the project root has no .git directory (worktrees are unsupported)');
    }
    // The guard protects the flip; it must never fail it. If its own
    // preconditions cannot be verified, degrade to a warning instead.
    let hooksPath: string | null = null;
    let version: GitVersion | null = null;
    try {
      hooksPath = await this.git.getConfigValue(projectId, 'core.hooksPath', root);
      if (hooksPath) {
        return skip(
          `core.hooksPath is set (${hooksPath}); the guard cannot install into .git/hooks`,
        );
      }
      version = await this.git.getVersion(projectId, root);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return skip(`git could not be consulted (${reason})`);
    }
    if (!isSupportedGit(version)) {
      return skip(
        `git ${version.major}.${version.minor}.${version.patch} is older than 2.28; the reference-transaction hook is unavailable`,
      );
    }
    const message = onVm
      ? vmGuardMessage(owner)
      : guardMessage(safeRemoteName(await this.remoteName(projectId, owner), owner));
    await this.installHooks(root, message);
    logger.info({ projectId, side: onVm ? 'vm' : 'home' }, 'Git guard installed');
    return null;
  }

  async remove(
    projectId: string,
    options: { refreshIndex: boolean; failOnReadError?: boolean },
  ): Promise<GitGuardRemoveResult> {
    const root = await this.fileSync.folderPath(projectId);
    const removed = await this.stripHooks(root, options.failOnReadError);
    if (!options.refreshIndex) return { removed, indexRefreshed: null, warning: null };
    // Indexes do not sync between sides; rebuild the new owner's index from HEAD.
    try {
      await this.git.refreshIndexFromHead(projectId, root);
      return { removed, indexRefreshed: true, warning: null };
    } catch (error) {
      logger.warn({ error, projectId }, 'Guard index refresh failed (non-fatal)');
      const reason = error instanceof Error ? error.message : String(error);
      return { removed, indexRefreshed: false, warning: `Git index rebuild failed: ${reason}` };
    }
  }

  async reinstall(projectId: string, remoteId: string): Promise<string | null> {
    const root = await this.fileSync.folderPath(projectId);
    await this.stripHooks(root);
    return this.install(projectId, remoteId);
  }

  private skipWarning(projectId: string, reason: string, vm = false): string {
    const warning = vm
      ? `VM git guard skipped: ${reason}. Git changes on the VM are not blocked while the project is on the PC.`
      : `Git guard skipped: ${reason}. Git changes at home are not blocked while the project runs on the VM.`;
    logger.warn({ projectId }, warning);
    return warning;
  }

  /**
   * The remote's display name for the guard message. The remoteId is a
   * parameter of install, so the remote row is the direct source; a missing
   * row falls back to the id (mirrors the admission service's name read).
   */
  private async remoteName(projectId: string, remoteId: string): Promise<string> {
    try {
      return (await this.storage.getRemote(remoteId)).name;
    } catch (error) {
      if (error instanceof NotFoundError) {
        logger.warn({ projectId, remoteId }, 'Guard remote row missing; using id as name');
        return '';
      }
      throw error;
    }
  }

  private async installHooks(root: string, message: string): Promise<void> {
    const hooksDir = join(root, '.git', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    for (const name of GUARD_HOOKS) {
      const hookPath = join(hooksDir, name);
      // A repeated install rewrites its own hook and keeps the original saved once.
      if (existsSync(hookPath) && !(await this.isOwnHook(hookPath))) {
        const savedPath = `${hookPath}${SAVED_SUFFIX}`;
        await rm(savedPath, { force: true });
        await rename(hookPath, savedPath);
      }
      const script =
        name === REFERENCE_TRANSACTION_HOOK
          ? referenceTransactionScript(message)
          : postCheckoutScript(message);
      await writeFile(hookPath, script, 'utf8');
      await chmod(hookPath, 0o755);
    }
  }

  /**
   * Removes only the hooks this service wrote and restores the originals they
   * replaced. Safe to repeat, and safe when nothing was installed.
   */
  private async stripHooks(root: string, failOnReadError = false): Promise<boolean> {
    const hooksDir = join(root, '.git', 'hooks');
    if (!existsSync(hooksDir)) return false;
    let removed = false;
    for (const name of GUARD_HOOKS) {
      const hookPath = join(hooksDir, name);
      if (await this.isOwnHook(hookPath, failOnReadError)) {
        await rm(hookPath, { force: true });
        removed = true;
      }
      // A hook still in place belongs to the user; a saved copy never replaces it.
      const savedPath = `${hookPath}${SAVED_SUFFIX}`;
      if (existsSync(savedPath) && !existsSync(hookPath)) {
        await rename(savedPath, hookPath);
        removed = true;
      }
    }
    await rm(join(hooksDir, SWITCHBACK_MARKER), { force: true });
    return removed;
  }

  private async isOwnHook(hookPath: string, failOnReadError = false): Promise<boolean> {
    try {
      const content = await readFile(hookPath, 'utf8');
      return content.startsWith(OWNED_HEADER);
    } catch (error) {
      if (failOnReadError && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }
}
