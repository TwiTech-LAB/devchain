import { Inject, Injectable } from '@nestjs/common';
import { resolve } from 'node:path';
import { createLogger } from '../../../common/logging/logger';
import { inside } from '../../../common/filesystem/vm-home-path';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { shareFolderId } from '../../file-sync/share-paths';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import { RemoteOperationStepRefusedError } from '../operations/remote-operation.errors';
import { SharedFoldersStore } from './shared-folders.store';

const logger = createLogger('SharedFoldersLifecycle');

/** What projects and VM lifecycle actions must respect of this PC's shared folders. */
@Injectable()
export class SharedFoldersLifecycle {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly store: SharedFoldersStore,
    private readonly files: FileSyncService,
  ) {}

  /**
   * Refuses a project whose root is, holds or sits inside a folder shared with any VM: one path
   * must never be in two Syncthing folders.
   */
  async assertProjectOutsideShares(projectId: string): Promise<void> {
    const root = resolve(await this.files.folderPath(projectId));
    const share = this.store
      .list()
      .find((entry) => inside(root, entry.path) || inside(entry.path, root));
    if (!share) return;
    const vm = await this.storage.getRemote(share.remoteId).then(
      (remote) => remote.name,
      () => share.remoteId,
    );
    throw new RemoteOperationStepRefusedError(
      'PROJECT_OVERLAPS_SHARED_FOLDER',
      `The project folder ${root} overlaps ${share.path}, which is shared with the VM ${vm}. ` +
        'Stop sharing that folder first.',
      { projectId, path: share.path, remoteId: share.remoteId },
    );
  }

  /**
   * Forgets the VM's shared folders and removes this PC's folders of them; files stay. The
   * settings JSON has no foreign key to the remote, so Remove, Destroy and Reset all call this.
   */
  async forgetRemote(remoteId: string): Promise<void> {
    for (const entry of this.store.removeForRemote(remoteId)) {
      try {
        await this.files.removeFolder(shareFolderId(entry.path));
      } catch (error) {
        // Best effort: a later share of the path removes the folder before it copies.
        logger.warn(
          { remoteId, path: entry.path, error: error instanceof Error ? error.message : error },
          'Shared folder was not removed on this PC',
        );
      }
    }
  }
}
