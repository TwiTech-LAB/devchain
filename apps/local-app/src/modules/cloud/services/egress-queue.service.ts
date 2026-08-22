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
const DRAIN_INTERVAL_MS = 100;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/**
 * Total in-process retry window. EXACT GUARANTEE: a transient failure (network error,
 * 429, 5xx) is retried with capped exponential backoff until either this much time has
 * elapsed since the entry's FIRST attempt — or 1,000 subsequent events force a queue
 * overflow that drops it — whichever happens first, while this Local App process
 * remains alive. There is NO crash or restart durability: a killed process loses the
 * queue, and that loss is accepted (durable egress is a separate backlog item).
 */
const MAX_RETRY_WINDOW_MS = 10 * 60 * 1000;

interface QueueEntry {
  payload: IngestPayload;
  attempts: number;
  nextAttemptAt: number;
  /** Wall-clock start of this entry's first delivery attempt (retry-window anchor). */
  firstAttemptAt: number;
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
    this.queue.push({ payload, attempts: 0, nextAttemptAt: Date.now(), firstAttemptAt: 0 });
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

    if (entry.firstAttemptAt === 0) entry.firstAttemptAt = now;

    try {
      // Read at call-time (consistent with devices-proxy / preferences-proxy /
      // project-activity-reporter), so an env override is honored without a module reload.
      const notificationsServiceUrl =
        process.env.NOTIFICATIONS_SERVICE_URL || 'https://notify.devchain.cc';
      const response = await fetch(`${notificationsServiceUrl}/api/v1/ingest/local-app`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(entry.payload),
      });

      // ONLY a successful 2xx removes an entry as delivered. 200/201/`retried:true`
      // are all successful ingest outcomes from this producer's point of view.
      if (response.ok) {
        this.queue.shift();
        return;
      }

      if (response.status === 401) {
        await this.handle401();
        return;
      }

      // A classified 409 (intake context mismatch) or any other non-authentication 4xx
      // is a TERMINAL producer failure: retrying the same serialized payload can never
      // succeed, so log safely (no payload/token/routing-kid content), emit the existing
      // failure broadcast, and remove the entry WITHOUT labeling it delivered.
      if (response.status !== 429 && response.status < 500) {
        this.failEntry(entry, `terminal_response_${response.status}`);
        return;
      }

      // Transient (429 / 5xx): bounded retry.
      this.scheduleRetryOrExpire(entry, `transient_response_${response.status}`);
    } catch (error) {
      // Network error: bounded retry.
      this.scheduleRetryOrExpire(entry, 'network_error', error);
    }
  }

  /**
   * Bounded transient retry: capped exponential backoff until the 10-minute in-process
   * window expires, then a safe failure outcome (removed, never labeled delivered).
   */
  private scheduleRetryOrExpire(entry: QueueEntry, reason: string, error?: unknown): void {
    const now = Date.now();
    if (now - entry.firstAttemptAt >= MAX_RETRY_WINDOW_MS) {
      this.failEntry(entry, `retry_window_expired_after_${reason}`);
      return;
    }

    entry.attempts++;
    const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, entry.attempts - 1), MAX_BACKOFF_MS);
    entry.nextAttemptAt = now + backoff;
    logger.debug(
      {
        sourceEventId: entry.payload.sourceEventId,
        attempt: entry.attempts,
        backoffMs: backoff,
        reason,
        ...(error !== undefined ? { errorName: (error as Error)?.name } : {}),
      },
      'Delivery failed — scheduling retry',
    );
  }

  /**
   * Terminal outcome: the entry is removed and the existing cloud failure broadcast is
   * emitted. This is a producer failure, never a delivery.
   */
  private failEntry(entry: QueueEntry, reason: string): void {
    this.queue.shift();
    logger.warn(
      { sourceEventId: entry.payload.sourceEventId, reason },
      'Event delivery failed terminally',
    );
    this.broadcaster.broadcastEvent('cloud', 'egress_disconnected', {
      reason: 'delivery_failed',
      detail: reason,
    });
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
