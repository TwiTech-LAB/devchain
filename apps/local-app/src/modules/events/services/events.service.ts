import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ZodError } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { eventCatalog, type EventName, type EventPayload } from '../catalog';
import { EventLogService } from './event-log.service';

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
  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly eventLogService: EventLogService,
  ) {}

  async publish<TEventName extends EventName>(
    name: TEventName,
    payload: EventPayload<TEventName>,
    options?: { requestId?: string | null },
  ): Promise<string> {
    const schema = eventCatalog[name];
    if (!schema) {
      throw new Error(`Unknown event: ${name}`);
    }

    try {
      const parsed = schema.parse(payload);
      const { id: eventId } = await this.eventLogService.recordPublished({
        name,
        payload: parsed,
        requestId: options?.requestId ?? null,
      });
      eventMetadata.set(parsed as object, { id: eventId });
      this.eventEmitter.emit(name, parsed);
      logger.debug({ name, eventId }, 'Event published');
      return eventId;
    } catch (error) {
      if (error instanceof ZodError) {
        logger.error({ name, issues: error.issues }, 'Invalid event payload');
        throw error;
      }
      throw error;
    }
  }
}
