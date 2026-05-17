import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { CloudSessionManagerService } from './cloud-session-manager.service';
import { RefreshGateService } from './refresh-gate.service';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import type { IngestPayload } from './event-mapper.service';

const logger = createLogger('EgressQueue');

const MAX_QUEUE_SIZE = 1000;
const MAX_DELIVERY_ATTEMPTS = 3;
const DRAIN_INTERVAL_MS = 100;
const BASE_BACKOFF_MS = 1000;
const NOTIFICATIONS_SERVICE_URL = process.env.NOTIFICATIONS_SERVICE_URL || 'http://localhost:3003';

interface QueueEntry {
  payload: IngestPayload;
  attempts: number;
  nextAttemptAt: number;
}

@Injectable()
export class EgressQueueService implements OnModuleDestroy {
  private queue: QueueEntry[] = [];
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private pauseBackoffMs = BASE_BACKOFF_MS;

  constructor(
    private readonly cloudSession: CloudSessionManagerService,
    private readonly refreshGate: RefreshGateService,
    @Inject(REALTIME_BROADCASTER)
    private readonly broadcaster: RealtimeBroadcaster,
  ) {
    this.drainTimer = setInterval(() => this.drainOnce(), DRAIN_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  enqueue(payload: IngestPayload): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift();
      logger.warn('Queue overflow — dropped oldest entry');
    }
    this.queue.push({ payload, attempts: 0, nextAttemptAt: Date.now() });
  }

  get length(): number {
    return this.queue.length;
  }

  private async drainOnce(): Promise<void> {
    if (this.paused || this.queue.length === 0) return;

    const now = Date.now();
    const entry = this.queue[0];
    if (!entry || entry.nextAttemptAt > now) return;

    const token = this.cloudSession.getAccessToken();
    if (!token) return;

    try {
      const response = await fetch(`${NOTIFICATIONS_SERVICE_URL}/api/v1/ingest/local-app`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(entry.payload),
      });

      if (response.ok || response.status === 409) {
        this.queue.shift();
        this.pauseBackoffMs = BASE_BACKOFF_MS;
        return;
      }

      if (response.status === 401) {
        await this.handle401();
        return;
      }

      entry.attempts++;
      if (entry.attempts >= MAX_DELIVERY_ATTEMPTS) {
        this.queue.shift();
        logger.warn(
          { sourceEventId: entry.payload.sourceEventId, attempts: entry.attempts },
          'Dropping event after max delivery attempts',
        );
        return;
      }

      entry.nextAttemptAt = now + BASE_BACKOFF_MS * Math.pow(2, entry.attempts - 1);
      logger.debug(
        { sourceEventId: entry.payload.sourceEventId, attempt: entry.attempts },
        'Delivery failed — scheduling retry',
      );
    } catch (error) {
      entry.attempts++;
      if (entry.attempts >= MAX_DELIVERY_ATTEMPTS) {
        this.queue.shift();
        logger.warn(
          { sourceEventId: entry.payload.sourceEventId, error },
          'Dropping event after network error',
        );
        return;
      }
      entry.nextAttemptAt = now + BASE_BACKOFF_MS * Math.pow(2, entry.attempts - 1);
    }
  }

  private async handle401(): Promise<void> {
    this.paused = true;
    logger.info('401 received — initiating single-flight refresh');

    const outcome = await this.refreshGate.attemptRefresh();

    switch (outcome) {
      case 'success':
        this.paused = false;
        this.pauseBackoffMs = BASE_BACKOFF_MS;
        logger.info('Refresh succeeded — resuming queue');
        break;

      case 'transient_failure':
        this.pauseBackoffMs = Math.min(this.pauseBackoffMs * 2, 30_000);
        logger.warn(
          { backoffMs: this.pauseBackoffMs },
          'Transient refresh failure — pausing with backoff',
        );
        setTimeout(() => {
          this.paused = false;
        }, this.pauseBackoffMs);
        break;

      case 'permanent_failure':
        logger.warn('Permanent refresh failure — draining queue');
        this.queue = [];
        this.paused = false;
        this.broadcaster.broadcastEvent('cloud', 'egress_disconnected', {
          reason: 'refresh_failed',
        });
        break;
    }
  }
}
