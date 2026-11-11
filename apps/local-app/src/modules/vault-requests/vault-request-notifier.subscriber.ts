import { Injectable } from '@nestjs/common';
import { createLogger } from '../../common/logging/logger';
import { AgentMessageDeliveryService } from '../agent-message-delivery/agent-message-delivery.service';
import type { EventPayload } from '../events/catalog';
import { OnCatalogEvent } from '../events/catalog/on-catalog-event';
import { VaultRequestStore } from './vault-request.store';

const logger = createLogger('VaultRequestNotifier');

/** Tells the requesting agent, through its message pool, how the user answered. */
@Injectable()
export class VaultRequestNotifierSubscriber {
  constructor(
    private readonly delivery: AgentMessageDeliveryService,
    private readonly store: VaultRequestStore,
  ) {}

  @OnCatalogEvent('vault.request.resolved', { async: true })
  async onResolved(payload: EventPayload<'vault.request.resolved'>): Promise<void> {
    // An expired request has nobody to tell: its session stopped or the agent moved on.
    if (payload.status === 'expired') return;
    // The agent runs on the remote, whose own notifier tells it.
    if (this.store.remoteOrigin(payload.requestId)) return;
    const body =
      payload.status === 'fulfilled'
        ? `Secret ${payload.name} is available — use devchain vault exec --only ${payload.name} -- <cmd>`
        : `The user denied your request for secret ${payload.name}.${
            payload.reason ? ` Reason: ${payload.reason}` : ''
          }`;
    try {
      const outcome = await this.delivery.deliver(
        [payload.agentId],
        {
          kind: 'pooled',
          body,
          source: 'vault.request',
          projectId: payload.projectId,
          senderName: 'System',
        },
        // A stopped agent is not launched for this: its requests expired with the session.
        { submitKeys: ['Enter'], requireActiveSession: true },
      );
      logger.info(
        { requestId: payload.requestId, status: payload.status, poolStatus: outcome.status },
        'Notified the agent about its Vault request',
      );
    } catch (error) {
      logger.warn(
        { requestId: payload.requestId, error: error instanceof Error ? error.message : error },
        'Failed to notify the agent about its Vault request',
      );
    }
  }
}
