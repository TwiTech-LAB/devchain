import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { MessageLogEntry, PoolDetails } from './sessions-message-pool.service';

/**
 * Service for broadcasting message activity events via WebSocket.
 * Follows the EventsStreamService pattern for real-time UI updates.
 *
 * Topics:
 * - messages/activity: enqueued, delivered, failed
 * - messages/pools: updated
 */
@Injectable()
export class MessageActivityStreamService {
  private readonly logger = new Logger(MessageActivityStreamService.name);

  constructor(
    @Inject(forwardRef(() => TerminalGateway))
    private readonly terminalGateway: TerminalGateway,
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
      this.terminalGateway.broadcastEvent(topic, type, payload);
    } catch (error) {
      this.logger.error({ topic, type, error }, 'Failed to broadcast message activity update');
    }
  }
}
