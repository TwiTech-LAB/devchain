import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { createLogger } from '../../../common/logging/logger';
import type { SessionActivityChangedEventPayload } from '../../events/catalog/session.activity.changed';
import type { SessionCrashedEventPayload } from '../../events/catalog/session.crashed';
import type { SessionStoppedEventPayload } from '../../events/catalog/session.stopped';
import { EventsService } from '../../events/services/events.service';
import type { CommittedEvent } from '../../events/services/durable-event-registry.service';
import { EpicTimeStore, type EpicTimeActivation } from './epic-time.store';

const logger = createLogger('AgentTimeAccountingService');
const MAX_SWEEP_INTERVAL_MS = 5_000;
const MIN_SWEEP_INTERVAL_MS = 250;
export const EPIC_TIME_DELIVERY_KEY = 'epic-time-accounting';

interface FullSweepOptions {
  forceCloseOpenSegments?: boolean;
}

@Injectable()
export class AgentTimeAccountingService implements OnModuleInit, OnModuleDestroy {
  private activation: EpicTimeActivation | null = null;
  private workTail: Promise<void> = Promise.resolve();
  private sweepTimer: NodeJS.Timeout | null = null;
  private unregisterDurableSubscriber: (() => void) | null = null;
  private destroyed = false;

  constructor(
    private readonly store: EpicTimeStore,
    private readonly events: EventsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.destroyed = false;
    this.activation = await this.store.activate();
    this.unregisterDurableSubscriber = this.events.registerDurableSubscriber({
      deliveryKey: EPIC_TIME_DELIVERY_KEY,
      eventNames: ['epic.created', 'epic.updated', 'epic.comment.created'],
      ordered: true,
      handle: (event) => this.handleCommittedTaskTouch(event),
    });
    await this.requestFullSweep(new Date(), { forceCloseOpenSegments: true });
    this.scheduleNextSweep();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.unregisterDurableSubscriber?.();
    this.unregisterDurableSubscriber = null;
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  @OnEvent('session.activity.changed', { async: true })
  handleActivityChanged(payload: SessionActivityChangedEventPayload): Promise<void> {
    return this.requestSessionReconciliation(payload.sessionId);
  }

  @OnEvent('session.stopped', { async: true })
  handleSessionStopped(payload: SessionStoppedEventPayload): Promise<void> {
    return this.requestSessionReconciliation(payload.sessionId);
  }

  @OnEvent('session.crashed', { async: true })
  handleSessionCrashed(payload: SessionCrashedEventPayload): Promise<void> {
    return this.requestSessionReconciliation(payload.sessionId);
  }

  handleCommittedTaskTouch(event: CommittedEvent): Promise<void> {
    return this.enqueue(async () => {
      // Subscriber registration gates admission; callbacks accepted before
      // unregistration must drain even if module teardown has since begun.
      await this.recordCommittedTaskTouch(event);
      const activation = this.activation;
      if (activation) {
        await this.store.processTeamBatches(
          EPIC_TIME_DELIVERY_KEY,
          activation.idleTimeoutMs,
          new Date(),
        );
      }
    });
  }

  private async recordCommittedTaskTouch(event: CommittedEvent): Promise<void> {
    if (
      event.name !== 'epic.created' &&
      event.name !== 'epic.updated' &&
      event.name !== 'epic.comment.created'
    ) {
      return;
    }
    const payload = event.payload as {
      actor?: { type: 'agent' | 'guest'; id: string } | null;
      projectId: string;
      epicId: string;
      title?: string;
      epicTitle?: string;
      parentId?: string | null;
      parentTitle?: string;
    };
    if (payload.actor?.type !== 'agent') {
      return;
    }

    let targetEpicId = payload.epicId;
    let targetEpicTitle = payload.epicTitle;
    if (event.name === 'epic.created') {
      if (payload.parentId) {
        targetEpicId = payload.parentId;
        targetEpicTitle = payload.parentTitle ?? payload.title;
      } else {
        targetEpicTitle = payload.title;
      }
    }

    if (!targetEpicTitle) {
      if (event.name === 'epic.comment.created') {
        logger.warn(
          { eventId: event.id, eventName: event.name },
          'Skipping comment task touch without an Epic title snapshot',
        );
        return;
      }
      throw new Error('Committed Epic task touch is missing its target title snapshot.');
    }

    await this.store.recordTaskTouch({
      committedEventId: event.id,
      eventName: event.name,
      projectId: payload.projectId,
      actorAgentId: payload.actor.id,
      targetEpicId,
      targetEpicTitle,
      publishedAt: event.publishedAt,
    });
  }

  requestSessionReconciliation(sessionId: string, now = new Date()): Promise<void> {
    return this.enqueue(async () => {
      const activation = this.activation;
      if (!activation || this.destroyed) {
        return;
      }
      await this.store.reconcileSession(
        sessionId,
        activation.trackingStartedAt,
        activation.idleTimeoutMs,
        now,
      );
      await this.store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, activation.idleTimeoutMs, now);
    });
  }

  requestFullSweep(now = new Date(), options: FullSweepOptions = {}): Promise<void> {
    return this.enqueue(async () => {
      const activation = this.activation;
      if (!activation || this.destroyed) {
        return;
      }
      const sessionIds = this.store.listReconciliationSessionIds(activation.trackingStartedAt);
      for (const sessionId of sessionIds) {
        if (this.destroyed) {
          return;
        }
        await this.store.reconcileSession(
          sessionId,
          activation.trackingStartedAt,
          activation.idleTimeoutMs,
          now,
          { forceCloseOpenSegment: options.forceCloseOpenSegments ?? false },
        );
      }
      await this.store.processTeamBatches(EPIC_TIME_DELIVERY_KEY, activation.idleTimeoutMs, now);
    });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.workTail.then(work);
    this.workTail = run.catch((error) => {
      logger.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError' },
        'Epic time reconciliation failed',
      );
    });
    return run;
  }

  private scheduleNextSweep(): void {
    if (this.destroyed || !this.activation) {
      return;
    }
    const intervalMs = Math.min(
      MAX_SWEEP_INTERVAL_MS,
      Math.max(MIN_SWEEP_INTERVAL_MS, Math.floor(this.activation.idleTimeoutMs / 2)),
    );
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      void this.requestFullSweep()
        .catch(() => undefined)
        .finally(() => this.scheduleNextSweep());
    }, intervalMs);
    this.sweepTimer.unref?.();
  }
}
