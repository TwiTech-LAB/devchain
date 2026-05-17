import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import type { MessageLogEntry } from './message-pool.types';

const logger = createLogger('MessageLogService');

const MAX_LOG_ENTRIES = 500;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_WARNING_THRESHOLD = 0.8;

@Injectable()
export class MessageLogService {
  private messageLog: MessageLogEntry[] = [];
  private logBytes = 0;
  private logIndex = new Map<string, number>();

  addEntry(entry: MessageLogEntry): void {
    this.pruneIfNeeded(entry.text.length);

    this.messageLog.push(entry);
    this.logBytes += entry.text.length;
    this.logIndex.set(entry.id, this.messageLog.length - 1);

    logger.debug(
      { messageId: entry.id, logSize: this.messageLog.length, logBytes: this.logBytes },
      'Message log entry added',
    );
  }

  getById(messageId: string): MessageLogEntry | null {
    const index = this.logIndex.get(messageId);
    if (index === undefined) return null;
    return this.messageLog[index] ?? null;
  }

  update(
    messageId: string,
    updates: Partial<
      Pick<
        MessageLogEntry,
        | 'status'
        | 'batchId'
        | 'deliveredAt'
        | 'error'
        | 'nonce'
        | 'confirmedAt'
        | 'retryCount'
        | 'failureCode'
      >
    >,
  ): void {
    const index = this.logIndex.get(messageId);
    if (index === undefined || !this.messageLog[index]) {
      logger.debug({ messageId }, 'Log entry not found for update');
      return;
    }

    Object.assign(this.messageLog[index], updates);
    logger.debug({ messageId, updates }, 'Message log entry updated');
  }

  query(options?: {
    projectId?: string;
    agentId?: string;
    status?: MessageLogEntry['status'];
    source?: string;
    limit?: number;
  }): MessageLogEntry[] {
    let entries = [...this.messageLog].reverse();

    if (options?.projectId) entries = entries.filter((e) => e.projectId === options.projectId);
    if (options?.agentId) entries = entries.filter((e) => e.agentId === options.agentId);
    if (options?.status) entries = entries.filter((e) => e.status === options.status);
    if (options?.source) entries = entries.filter((e) => e.source === options.source);
    if (options?.limit && options.limit > 0) entries = entries.slice(0, options.limit);

    return entries;
  }

  getStats(): { entryCount: number; bytesUsed: number; maxEntries: number; maxBytes: number } {
    return {
      entryCount: this.messageLog.length,
      bytesUsed: this.logBytes,
      maxEntries: MAX_LOG_ENTRIES,
      maxBytes: MAX_LOG_BYTES,
    };
  }

  getMessageById(messageId: string): MessageLogEntry | null {
    return this.getById(messageId);
  }

  private pruneIfNeeded(incomingBytes: number): void {
    const bytesThreshold = MAX_LOG_BYTES * LOG_WARNING_THRESHOLD;
    const entriesThreshold = MAX_LOG_ENTRIES * LOG_WARNING_THRESHOLD;

    if (this.logBytes >= bytesThreshold || this.messageLog.length >= entriesThreshold) {
      logger.warn(
        {
          entryCount: this.messageLog.length,
          maxEntries: MAX_LOG_ENTRIES,
          bytesUsed: this.logBytes,
          maxBytes: MAX_LOG_BYTES,
        },
        'Message log approaching memory limits',
      );
    }

    let pruned = false;

    while (
      this.messageLog.length + 1 > MAX_LOG_ENTRIES ||
      this.logBytes + incomingBytes > MAX_LOG_BYTES
    ) {
      const idx = this.messageLog.findIndex((e) => e.status !== 'queued');

      if (idx === -1) {
        logger.warn(
          {
            entryCount: this.messageLog.length,
            queuedCount: this.messageLog.length,
            bytesUsed: this.logBytes,
            incomingBytes,
          },
          'Cannot prune message log: all entries are queued',
        );
        break;
      }

      const removed = this.messageLog.splice(idx, 1)[0];
      this.logBytes -= removed.text.length;
      this.logIndex.delete(removed.id);
      pruned = true;
    }

    if (pruned) {
      this.logIndex.clear();
      this.messageLog.forEach((entry, idx) => {
        this.logIndex.set(entry.id, idx);
      });
    }
  }
}
