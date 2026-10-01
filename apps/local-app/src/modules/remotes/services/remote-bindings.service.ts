import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import type { RemoteBindingChangedEventPayload } from '../../events/catalog/remote.binding.changed';
import { EventsService } from '../../events/services/events.service';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type {
  RemoteProjectBinding,
  UpdateRemoteProjectBinding,
} from '../../storage/models/domain.models';
import { ProjectWriteAdmissionService } from '../admission/project-write-admission.service';

const logger = createLogger('RemoteBindingsService');

/**
 * The only writer of home binding rows. Each write reloads the write-admission
 * map before it returns, so `PROJECT_REMOTE` follows the row immediately, and
 * announces `remote.binding.changed`.
 */
@Injectable()
export class RemoteBindingsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    private readonly admission: ProjectWriteAdmissionService,
    private readonly events: EventsService,
  ) {}

  list(): Promise<RemoteProjectBinding[]> {
    return this.storage.listRemoteProjectBindings();
  }

  get(projectId: string): Promise<RemoteProjectBinding | null> {
    return this.storage.getRemoteProjectBinding(projectId);
  }

  async create(projectId: string, remoteId: string): Promise<RemoteProjectBinding> {
    const binding = await this.storage.createRemoteProjectBinding({ projectId, remoteId });
    await this.afterWrite(toPayload(binding));
    return binding;
  }

  async update(projectId: string, data: UpdateRemoteProjectBinding): Promise<RemoteProjectBinding> {
    const binding = await this.storage.updateRemoteProjectBinding(projectId, data);
    await this.afterWrite(toPayload(binding));
    return binding;
  }

  /** No-op (and no event) when the project has no binding. */
  async delete(projectId: string): Promise<void> {
    const deleted = await this.storage.deleteRemoteProjectBinding(projectId);
    if (!deleted) return;
    await this.afterWrite({ ...toPayload(deleted), state: 'deleted' });
  }

  private async afterWrite(payload: RemoteBindingChangedEventPayload): Promise<void> {
    await this.admission.refreshBindings();
    try {
      await this.events.publish('remote.binding.changed', payload);
    } catch (error) {
      // The row and the admission map are already correct; clients catch up on their next poll.
      logger.warn({ error, projectId: payload.projectId }, 'Failed to publish binding change');
    }
  }
}

function toPayload(binding: RemoteProjectBinding): RemoteBindingChangedEventPayload {
  return {
    projectId: binding.projectId,
    remoteId: binding.remoteId,
    state: binding.state,
    hostCursor: binding.hostCursor,
    syncError: binding.syncError,
  };
}
