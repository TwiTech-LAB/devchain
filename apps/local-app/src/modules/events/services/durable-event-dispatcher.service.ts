import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../common/logging/logger';
import { CommittedEventStore } from './committed-event.store';
import { DurableEventRegistryService } from './durable-event-registry.service';

const logger = createLogger('DurableEventDispatcherService');
const POLL_INTERVAL_MS = 250;
const LEASE_MS = 30_000;

@Injectable()
export class DurableEventDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly leaseOwner = randomUUID();
  private timer?: NodeJS.Timeout;
  private destroyed = false;
  private running = false;

  constructor(
    private readonly store: CommittedEventStore,
    private readonly registry: DurableEventRegistryService,
  ) {}

  onModuleInit(): void {
    this.destroyed = false;
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async dispatchAvailable(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    let delivered = 0;
    try {
      while (!this.destroyed) {
        const delivery = await this.store.claimNext(this.leaseOwner, LEASE_MS);
        if (!delivery) {
          break;
        }
        const subscriber = this.registry.getSubscriber(delivery.deliveryKey);
        if (!subscriber) {
          await this.store.markRetry(delivery);
          continue;
        }
        try {
          await subscriber.handle(delivery.event);
          await this.store.markDelivered(delivery);
          delivered += 1;
        } catch (error) {
          logger.warn(
            {
              errorName: error instanceof Error ? error.name : 'UnknownError',
              eventId: delivery.event.id,
              deliveryKey: delivery.deliveryKey,
            },
            'Durable event handler failed; delivery will retry',
          );
          await this.store.markRetry(delivery);
        }
      }
      return delivered;
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.destroyed) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.dispatchAvailable().finally(() => this.schedule(POLL_INTERVAL_MS));
    }, delayMs);
    this.timer.unref?.();
  }
}
