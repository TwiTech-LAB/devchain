import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';

@Injectable()
export class EventsStreamService {
  private readonly logger = new Logger(EventsStreamService.name);

  constructor(
    @Inject(forwardRef(() => TerminalGateway))
    private readonly terminalGateway: TerminalGateway,
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
      this.terminalGateway.broadcastEvent(topic, type, payload);
    } catch (error) {
      this.logger.error({ topic, type, error }, 'Failed to broadcast events stream update');
    }
  }
}
