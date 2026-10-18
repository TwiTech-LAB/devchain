import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FILE_SYNC_PATHS } from '../../file-sync/file-sync-paths';
import type { FileSyncPaths } from '../../file-sync/file-sync-paths';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { internalGitEnv } from './git-checkpoint';

/** Root sequencer markers, in check order, and the unfinished operation each stands for. */
const SEQUENCER_MARKERS = new Map([
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
  ['sequencer', 'a cherry-pick or revert sequence'],
]);

/** The unfinished operation a root sequencer marker stands for, as a user reads it. */
export function describeSequencer(marker: string): string {
  return SEQUENCER_MARKERS.get(marker) ?? 'a cherry-pick or revert sequence';
}

@Injectable()
export class GitCoordinatorIndexService {
  constructor(
    @Inject(FILE_SYNC_PATHS) private readonly paths: FileSyncPaths,
    private readonly files: FileSyncService,
    private readonly executor: ProcessExecutor,
  ) {}

  directory(projectId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(projectId))
      throw new Error('Invalid Git coordinator project id');
    return join(dirname(this.paths.syncthingHome()), 'git-coordinator', projectId);
  }

  async sequencer(projectId: string): Promise<string | null> {
    const gitDir = await this.files.folderPath(projectId, 'git');
    for (const name of SEQUENCER_MARKERS.keys())
      if (await statIfExists(join(gitDir, name))) return name;
    return null;
  }

  /** `verify` sees the complete snapshot file before it replaces the saved one. */
  async save(
    projectId: string,
    bytes: Buffer,
    verify?: (indexFile: string) => Promise<void>,
  ): Promise<void> {
    const directory = this.directory(projectId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = join(directory, `index-${randomUUID()}`);
    try {
      if (bytes.length === 0) {
        const result = await this.executor.run({
          argv: ['git', '-c', 'gc.auto=0', 'read-tree', '--empty'],
          mode: 'pipe',
          cwd: await this.files.folderPath(projectId),
          env: internalGitEnv({ GIT_INDEX_FILE: temp }),
          timeout: 15_000,
        });
        if (!result.success) throw new Error(`Cannot create empty Git index: ${result.stderr}`);
        await usingFile(temp, async () => {}, 'r+');
      } else {
        if (bytes.length < 12 || bytes.subarray(0, 4).toString() !== 'DIRC')
          throw new Error('Invalid Git index snapshot');
        await usingFile(
          temp,
          async (file) => {
            await file.writeFile(bytes);
          },
          'wx',
        );
      }
      await verify?.(temp);
      await rename(temp, join(directory, 'index'));
      await syncDirectory(directory);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async install(projectId: string, transitionId: string): Promise<void> {
    const directory = this.directory(projectId);
    const source = join(directory, 'index');
    const gitDir = await this.files.folderPath(projectId, 'git');
    const staged = join(gitDir, `index.devchain-${transitionId}.lock`);
    const lock = join(gitDir, 'index.lock');
    if (!(await statIfExists(staged))) {
      const temp = join(gitDir, `index.devchain-${randomUUID()}.lock`);
      try {
        await usingFile(
          temp,
          async (file) => {
            await file.writeFile(await readFile(source));
          },
          'wx',
        );
        await rename(temp, staged);
        await syncDirectory(gitDir);
      } finally {
        await rm(temp, { force: true });
      }
    }
    try {
      await link(staged, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const [ours, existing] = await Promise.all([stat(staged), stat(lock)]);
      // A crash can leave our lock. Never unlink another writer's index.lock.
      if (ours.ino !== existing.ino || ours.dev !== existing.dev)
        throw new Error('Git index.lock belongs to another writer');
    }
    await rename(lock, join(gitDir, 'index'));
    await syncDirectory(gitDir);
  }

  /**
   * Installs the saved snapshot as a fresh attempt under a reused id. A lock left by an
   * interrupted attempt with the same id is ours; another writer's lock still refuses.
   */
  async replace(projectId: string, id: string): Promise<void> {
    const gitDir = await this.files.folderPath(projectId, 'git');
    const staged = join(gitDir, `index.devchain-${id}.lock`);
    const lock = join(gitDir, 'index.lock');
    const [ours, existing] = await Promise.all([statIfExists(staged), statIfExists(lock)]);
    if (ours && existing && ours.ino === existing.ino && ours.dev === existing.dev) await rm(lock);
    await rm(staged, { force: true });
    await this.install(projectId, id);
    await this.cleanup(projectId, id);
  }

  async cleanup(projectId: string, transitionId: string): Promise<void> {
    await rm(
      join(await this.files.folderPath(projectId, 'git'), `index.devchain-${transitionId}.lock`),
      { force: true },
    );
  }

  /** Branches checked out in linked worktrees; the main worktree's branch is synced, not listed. */
  async worktreeBranches(projectId: string): Promise<string[]> {
    const result = await this.executor.run({
      argv: ['git', 'worktree', 'list', '--porcelain'],
      mode: 'pipe',
      cwd: await this.files.folderPath(projectId),
      env: internalGitEnv({ GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }),
      timeout: 15_000,
    });
    if (!result.success) throw new Error(`Cannot list Git worktrees: ${result.stderr}`);
    const linked = result.stdout.split(/\n\n+/).slice(1);
    const branches = linked.flatMap((block) =>
      block
        .split('\n')
        .filter((line) => line.startsWith('branch refs/heads/'))
        .map((line) => line.slice('branch '.length)),
    );
    return [...new Set(branches)].sort();
  }

  async read(projectId: string): Promise<Buffer> {
    return readFile(join(this.directory(projectId), 'index'));
  }
}

async function statIfExists(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function usingFile(
  path: string,
  operation: (file: Awaited<ReturnType<typeof open>>) => Promise<void>,
  flags: string,
): Promise<void> {
  const file = await open(path, flags, 0o600);
  try {
    await operation(file);
    await file.sync();
  } finally {
    await file.close();
  }
}
