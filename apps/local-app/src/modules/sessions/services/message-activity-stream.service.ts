import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import type { MessageLogEntry, PoolDetails } from './message-pool.types';

/**
 * Service for broadcasting message activity events via WebSocket.
 * Follows the EventsStreamService pattern for real-time UI updates.
 *
 * T2 disposition: keep — domain-specific vocabulary (broadcastEnqueued, broadcastDelivered,
 * broadcastFailed) adds semantic clarity; single caller is SessionsMessagePoolService.
 *
 * Topics:
 * - messages/activity: enqueued, delivered, failed
 * - messages/pools: updated
 */
@Injectable()
export class MessageActivityStreamService {
  private readonly logger = new Logger(MessageActivityStreamService.name);

  constructor(
    @Inject(REALTIME_BROADCASTER)
    private readonly broadcaster: RealtimeBroadcaster,
  ) {}

  /**
   * Broadcast when a message is enqueued to the pool.
   */
  broadcastEnqueued(entry: MessageLogEntry): void {
    this.broadcast('messages/activity', 'enqueued', entry);
  }

  /**
   * Broadcast when messages are successfully delivered as a batch.
   */
  broadcastDelivered(batchId: string, entries: MessageLogEntry[]): void {
    this.broadcast('messages/activity', 'delivered', { batchId, entries });
  }

  /**
   * Broadcast when message delivery is unconfirmed (paste may have worked but can't verify).
   */
  broadcastUnconfirmed(batchId: string, entries: MessageLogEntry[]): void {
    this.broadcast('messages/activity', 'unconfirmed', { batchId, entries });
  }

  /**
   * Broadcast when a message delivery fails.
   */
  broadcastFailed(entry: MessageLogEntry): void {
    this.broadcast('messages/activity', 'failed', entry);
  }

  /**
   * Broadcast updated pool state for UI.
   */
  broadcastPoolsUpdated(pools: PoolDetails[]): void {
    this.broadcast('messages/pools', 'updated', pools);
  }

  private broadcast(topic: string, type: string, payload: unknown): void {
    try {
      this.broadcaster.broadcastEvent(topic, type, payload);
    } catch (error) {
      this.logger.error({ topic, type, error }, 'Failed to broadcast message activity update');
    }
  }
}
