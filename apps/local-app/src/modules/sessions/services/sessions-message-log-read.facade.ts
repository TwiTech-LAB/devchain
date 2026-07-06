import { Injectable } from '@nestjs/common';
import { SessionsMessagePoolService } from './sessions-message-pool.service';
import type { DeliveryFailureCode } from './message-pool.types';

/**
 * One pending mobile message projected for `chat.getPendingMessages` — the wire
 * shape mobile reconciles its outbox against. `messageId` is the server log-entry
 * id; `status` is the ledger state (delivered = tmux paste succeeded, NOT
 * transcript presence).
 */
export interface PendingMobileMessage {
  messageId: string;
  clientMessageId: string;
  text: string;
  status: 'queued' | 'delivered' | 'failed' | 'unconfirmed';
  timestamp: number;
  deliveredAt?: number;
  failureCode?: DeliveryFailureCode;
}

/**
 * NARROW read-only facade over the in-memory message log, exposing ONLY the
 * mobile pending-message lookup `chat.getPendingMessages` needs. Exported by
 * {@link SessionsMessageLogReadModule} so `CloudTunnelModule` can read pending
 * state WITHOUT importing `SessionsModule` (and thus `SessionsMessagePoolService`)
 * wholesale — mirroring `TerminalViewportFacade`. Read-only by construction: it
 * only queries the log.
 */
@Injectable()
export class SessionsMessageLogReadFacade {
  constructor(private readonly pool: SessionsMessagePoolService) {}

  /**
   * Pending mobile sends for `agentId`/`projectId` whose `clientMessageId` is in
   * `clientMessageIds`. Scoped to `source==='mobile'` so it can never surface a
   * desktop/agent-origin message. Caller must have already authorized the agent
   * against the project (the RPC does so before delegating here).
   */
  queryPendingMobile(
    agentId: string,
    projectId: string,
    clientMessageIds: string[],
  ): PendingMobileMessage[] {
    const wanted = new Set(clientMessageIds);
    return this.pool
      .getMessageLog({ agentId, projectId, source: 'mobile' })
      .filter((entry) => !!entry.clientMessageId && wanted.has(entry.clientMessageId))
      .map((entry) => ({
        messageId: entry.id,
        clientMessageId: entry.clientMessageId as string,
        text: entry.text,
        status: entry.status,
        timestamp: entry.timestamp,
        ...(entry.deliveredAt !== undefined ? { deliveredAt: entry.deliveredAt } : {}),
        ...(entry.failureCode !== undefined ? { failureCode: entry.failureCode } : {}),
      }));
  }
}
