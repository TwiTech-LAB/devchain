import { Injectable } from '@nestjs/common';
import { FileSyncService, projectFolderId } from '../file-sync/file-sync.service';
import { WORKTREES_GIT_IGNORE } from '../file-sync/file-sync.dto';
import { SyncthingRestError } from '../file-sync/syncthing-rest.client';
import { GitCoordinatorService } from '../remotes/git-coordinator/git-coordinator.service';
import { ProjectGitMutex } from './project-git-mutex';
import { WorktreeError } from './worktrees.errors';

type GitFolder = Awaited<ReturnType<FileSyncService['folderConfiguration']>>;

@Injectable()
export class WorktreeAdmissionService {
  private readonly frozen = new Set<string>();

  constructor(
    private readonly files: FileSyncService,
    private readonly mutex: ProjectGitMutex,
    private readonly coordinator: GitCoordinatorService,
  ) {}

  assertUnfrozen(projectId: string): void {
    if (this.frozen.has(projectId)) {
      throw new WorktreeError(
        'LANES_FROZEN',
        'Lane operations are closed during a project handoff (Git take, or a forced Disconnect or VM reset). Try again after it finishes.',
      );
    }
  }

  async setFrozen(projectId: string, frozen: boolean): Promise<void> {
    if (!frozen) {
      this.frozen.delete(projectId);
      return;
    }
    // Close admission before draining operations already holding the project lock.
    this.frozen.add(projectId);
    await this.mutex.runExclusive(projectId, async () => undefined);
  }

  /**
   * Runs a lane mutation under the VM Git coordinator permit when the project syncs Git, waiting
   * (bounded) while the PC owns Git. Take ProjectGitMutex inside `operation`, never around this call.
   */
  async withPermit<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    if ((await this.gitFolder(projectId)) === null) return operation();
    return this.coordinator.withVmPermit(projectId, operation);
  }

  async assertOwned(projectId: string, creating = false): Promise<void> {
    this.assertUnfrozen(projectId);
    const folder = await this.gitFolder(projectId);
    if (folder === null) return;
    // The coordinator admitted the VM; a receiving folder means Git moved outside it.
    if (folder.type !== 'sendonly') {
      throw new WorktreeError(
        'GIT_NOT_OWNED',
        'The other machine owns Git for this project, so lane commits here would be reverted.',
      );
    }
    if (folder.paused) {
      throw new WorktreeError(
        'GIT_NOT_OWNED',
        'Git sync for this project is paused on this machine. Try again after it resumes.',
      );
    }
    if (creating) {
      const ignores = await this.files
        .installedIgnores(projectFolderId(projectId, 'git'))
        .catch(() => null);
      if (!ignores?.ignore.includes(WORKTREES_GIT_IGNORE)) {
        throw new WorktreeError(
          'GIT_SYNC_IGNORES_PENDING',
          'File sync has not applied the worktree ignore yet. Try again after the next sync upkeep.',
        );
      }
    }
    this.assertUnfrozen(projectId);
  }

  /** The local Git sync folder, or null for a local project without one. */
  private async gitFolder(projectId: string): Promise<GitFolder | null> {
    try {
      return await this.files.folderConfiguration(projectFolderId(projectId, 'git'));
    } catch (error) {
      if (error instanceof SyncthingRestError && error.status === 404) return null;
      throw new WorktreeError(
        'GIT_OWNERSHIP_UNKNOWN',
        'The local Git sync ownership could not be checked.',
      );
    }
  }
}
