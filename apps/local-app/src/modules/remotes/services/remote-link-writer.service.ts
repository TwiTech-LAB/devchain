import { Inject, Injectable } from '@nestjs/common';
import { AppError, ConflictError } from '../../../common/errors/error-types';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteIntegrationPushService } from './remote-integration-push.service';

export interface RemoteLinkWrite<T> {
  /** Writes at home; runs only for a reachable VM that takes no seed and so keeps no links. */
  home: () => Promise<T>;
  /** Writes on the VM, which owns the project's links once seeded. */
  host: () => Promise<T>;
}

/**
 * Picks where a home UI link write for a `remote` project runs, by its owner
 * (`RemoteIntegrationPushService.linkWriter`). A VM that owns the links, of this version,
 * is seeded first, then takes the write, and home's mirror learns it at the next pull; of
 * another version, the write is refused until the versions match, since the VM's link
 * table would erase a home write. Home writes only for a VM confirmed to take no seed.
 */
@Injectable()
export class RemoteLinkWriterService {
  constructor(
    @Inject(REMOTE_HEALTH_PORT) private readonly health: Pick<RemoteHealthPort, 'getState'>,
    private readonly push: RemoteIntegrationPushService,
  ) {}

  async write<T>(remoteId: string, projectId: string, write: RemoteLinkWrite<T>): Promise<T> {
    // Decided under the lock a seed takes, so no seed reads the links while home writes one.
    const atHome = await this.push.withProjectLinks([projectId], async () => {
      const state = this.health.getState(remoteId);
      if (!state.online || state.apiKeyRejected) {
        throw new ConflictError('The VM that runs this project is not reachable; try again.', {
          code: 'REMOTE_OFFLINE',
          retryable: true,
          remoteId,
          projectId,
        });
      }
      const writer = await this.push.linkWriter(remoteId, projectId);
      if (writer === 'home') return { value: await write.home() };
      if (writer === 'unknown') {
        throw new ConflictError(
          "This computer cannot read the VM's integration status; update them to the same DevChain version to change task links in this project.",
          { code: 'REMOTE_UPDATE_REQUIRED', remoteId, projectId },
        );
      }
      if (writer === null) {
        throw new ConflictError('The VM that runs this project has not reported yet; try again.', {
          code: 'REMOTE_OFFLINE',
          retryable: true,
          remoteId,
          projectId,
        });
      }
      if (!state.versionMatches) {
        throw new ConflictError(
          'The VM and this computer run different DevChain versions; update them to the same version to change task links in this project.',
          { code: 'REMOTE_UPDATE_REQUIRED', remoteId, projectId },
        );
      }
      return null;
    });
    if (atHome) return atHome.value;
    await this.push.seedConfirmed(remoteId, projectId);
    try {
      return await write.host();
    } catch (error) {
      // The VM lost its seed (a re-import); home's view is stale.
      if (!(error instanceof AppError) || error.code !== 'PROJECT_NOT_SEEDED') throw error;
      this.push.forgetSeeded(remoteId, projectId);
      await this.push.seedConfirmed(remoteId, projectId);
      return write.host();
    }
  }
}
