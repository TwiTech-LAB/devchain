import { Injectable } from '@nestjs/common';
import { isTransientEvent, type EventName, type EventPayload } from '../catalog';

export interface CommittedEvent<TName extends EventName = EventName> {
  id: string;
  name: TName;
  payload: EventPayload<TName>;
  requestId: string | null;
  publishedAt: string;
}

export type PreparedEvent<TName extends EventName = EventName> = CommittedEvent<TName>;

export interface DurableEventSubscriber {
  deliveryKey: string;
  eventNames: readonly EventName[];
  ordered?: boolean;
  handle: (event: CommittedEvent) => Promise<void>;
}

export interface RegisteredDurableEventSubscriber extends DurableEventSubscriber {
  ordered: boolean;
}

@Injectable()
export class DurableEventRegistryService {
  private readonly subscribers = new Map<string, RegisteredDurableEventSubscriber>();

  register(subscriber: DurableEventSubscriber): () => void {
    const deliveryKey = subscriber.deliveryKey.trim();
    if (!deliveryKey) {
      throw new Error('Durable event subscriber deliveryKey is required.');
    }
    if (subscriber.eventNames.length === 0) {
      throw new Error('Durable event subscriber must select at least one event.');
    }
    for (const eventName of subscriber.eventNames) {
      if (isTransientEvent(eventName)) {
        throw new Error(`Transient event ${eventName} cannot use durable delivery.`);
      }
    }
    if (this.subscribers.has(deliveryKey)) {
      throw new Error(`Durable event subscriber key ${deliveryKey} is already registered.`);
    }

    const registered: RegisteredDurableEventSubscriber = {
      ...subscriber,
      deliveryKey,
      eventNames: [...new Set(subscriber.eventNames)],
      ordered: subscriber.ordered ?? false,
    };
    this.subscribers.set(deliveryKey, registered);
    return () => {
      if (this.subscribers.get(deliveryKey) === registered) {
        this.subscribers.delete(deliveryKey);
      }
    };
  }

  getSubscriber(deliveryKey: string): RegisteredDurableEventSubscriber | null {
    return this.subscribers.get(deliveryKey) ?? null;
  }

  getSubscribers(): readonly RegisteredDurableEventSubscriber[] {
    return [...this.subscribers.values()];
  }

  deliveryKeysFor(eventName: EventName): string[] {
    return this.getSubscribers()
      .filter((subscriber) => subscriber.eventNames.includes(eventName))
      .map((subscriber) => subscriber.deliveryKey);
  }
}
