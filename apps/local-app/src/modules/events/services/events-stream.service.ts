import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';

/**
 * T2 disposition: keep — domain-specific broadcast vocabulary (broadcastEventCreated,
 * broadcastHandlerResult) adds semantic clarity over raw broadcastEvent calls.
 * Single caller: EventLogService.
 */
@Injectable()
export class EventsStreamService {
  private readonly logger = new Logger(EventsStreamService.name);

  constructor(
    @Inject(REALTIME_BROADCASTER)
    private readonly broadcaster: RealtimeBroadcaster,
  ) {}

  broadcastEventCreated(payload: {
    id: string;
    name: string;
    publishedAt: string;
    requestId: string | null;
    payload: unknown;
  }): void {
    this.broadcast('events/logs', 'event_created', payload);
  }

  broadcastHandlerResult(payload: {
    id: string;
    eventId: string;
    handler: string;
    status: 'success' | 'failure';
    detail: unknown;
    startedAt: string;
    endedAt: string | null;
  }): void {
    this.broadcast('events/logs', 'handler_recorded', payload);
  }

  private broadcast(topic: string, type: string, payload: unknown): void {
    try {
      this.broadcaster.broadcastEvent(topic, type, payload);
    } catch (error) {
      this.logger.error({ topic, type, error }, 'Failed to broadcast events stream update');
    }
  }
}
