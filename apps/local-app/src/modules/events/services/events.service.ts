import { Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { eventCatalog, isTransientEvent, type EventName, type EventPayload } from '../catalog';
import { EventLogService } from './event-log.service';
import {
  DurableEventRegistryService,
  type DurableEventSubscriber,
  type PreparedEvent,
} from './durable-event-registry.service';

const logger = createLogger('EventsService');
const eventMetadata = new WeakMap<object, { id: string }>();

export function getEventMetadata(payload: unknown): { id: string } | null {
  if (payload && typeof payload === 'object') {
    return eventMetadata.get(payload as object) ?? null;
  }
  return null;
}

@Injectable()
export class EventsService {
  private readonly durableEventRegistry: DurableEventRegistryService;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly eventLogService: EventLogService,
    @Optional() durableEventRegistry?: DurableEventRegistryService,
  ) {
    this.durableEventRegistry = durableEventRegistry ?? new DurableEventRegistryService();
  }

  prepareCommitted<TEventName extends EventName>(
    name: TEventName,
    payload: EventPayload<TEventName>,
    options?: { requestId?: string | null; id?: string; publishedAt?: string },
  ): PreparedEvent<TEventName> {
    const schema = eventCatalog[name];
    if (!schema) {
      throw new Error(`Unknown event: ${name}`);
    }
    if (isTransientEvent(name)) {
      throw new Error(`Transient event ${name} cannot be prepared for durable publication.`);
    }
    return {
      id: options?.id ?? randomUUID(),
      name,
      payload: schema.parse(payload) as EventPayload<TEventName>,
      requestId: options?.requestId ?? null,
      publishedAt: options?.publishedAt ?? new Date().toISOString(),
    };
  }

  emitCommitted(event: PreparedEvent): void {
    this.eventLogService.announceCommitted(event);
    this.emit(event);
  }

  private emit(event: PreparedEvent): void {
    eventMetadata.set(event.payload as object, { id: event.id });
    this.eventEmitter.emit(event.name, event.payload);
    logger.debug({ name: event.name, eventId: event.id }, 'Committed event emitted');
  }

  registerDurableSubscriber(subscriber: DurableEventSubscriber): () => void {
    return this.durableEventRegistry.register(subscriber);
  }

  async publish<TEventName extends EventName>(
    name: TEventName,
    payload: EventPayload<TEventName>,
    options?: { requestId?: string | null },
  ): Promise<string | null> {
    const schema = eventCatalog[name];
    if (!schema) {
      throw new Error(`Unknown event: ${name}`);
    }

    try {
      const parsed = schema.parse(payload);
      if (isTransientEvent(name)) {
        this.eventEmitter.emit(name, parsed);
        logger.debug({ name }, 'Transient event published');
        return null;
      }

      const recorded = await this.eventLogService.recordPublished({
        name,
        payload: parsed,
        requestId: options?.requestId ?? null,
      });
      const prepared: PreparedEvent<TEventName> = {
        id: recorded.id,
        name,
        payload: parsed,
        requestId: options?.requestId ?? null,
        publishedAt: recorded.publishedAt,
      };
      this.emit(prepared);
      logger.debug({ name, eventId: prepared.id }, 'Event published');
      return prepared.id;
    } catch (error) {
      if (error instanceof ZodError) {
        logger.error({ name, issues: error.issues }, 'Invalid event payload');
        throw error;
      }
      throw error;
    }
  }
}
