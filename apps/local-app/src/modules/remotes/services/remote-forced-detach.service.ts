import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { RemoteHostClient, RemoteHostRequestError } from '../operations/remote-host.client';
import { RemoteForcedDetachStore } from './remote-forced-detach.store';

const logger = createLogger('RemoteForcedDetachService');
const REFUSED_STATUSES = new Set([400, 404, 409, 410, 422]);

@Injectable()
export class RemoteForcedDetachService {
  private readonly flushing = new Map<string, Promise<void>>();

  constructor(
    private readonly store: RemoteForcedDetachStore,
    private readonly host: RemoteHostClient,
  ) {}

  record(remoteId: string, projectId: string): Promise<void> {
    return this.store.record(remoteId, projectId);
  }

  flush(remoteId: string): Promise<void> {
    const previous = this.flushing.get(remoteId);
    if (previous) return previous;
    const run = this.sendPending(remoteId).finally(() => this.flushing.delete(remoteId));
    this.flushing.set(remoteId, run);
    return run;
  }

  private async sendPending(remoteId: string): Promise<void> {
    for (;;) {
      const pending = this.store.pending(remoteId);
      if (pending.length === 0) return;
      for (const { projectId } of pending) {
        try {
          await this.host.sharedVmAbandon(remoteId, projectId);
        } catch (error) {
          if (
            error instanceof RemoteHostRequestError &&
            error.status !== null &&
            REFUSED_STATUSES.has(error.status)
          ) {
            logger.warn(
              { remoteId, projectId, status: error.status, hostCode: error.details?.hostCode },
              'The VM refused a forced Disconnect tombstone; dropping it',
            );
            await this.store.remove(remoteId, projectId);
            continue;
          }
          logger.debug(
            { remoteId, error: error instanceof Error ? error.message : String(error) },
            'Forced Disconnect reconciliation waits for the next health poll',
          );
          return;
        }
        await this.store.remove(remoteId, projectId);
      }
    }
  }
}
