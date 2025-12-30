import { EventEmitter2 } from '@nestjs/event-emitter';
import { ZodError } from 'zod';
import { EventsService, getEventMetadata } from './events.service';
import { EventLogService } from './event-log.service';

describe('EventsService', () => {
  let eventEmitter: EventEmitter2;
  let eventLogService: { recordPublished: jest.Mock };
  let service: EventsService;

  beforeEach(() => {
    eventEmitter = {
      emit: jest.fn(),
    } as unknown as EventEmitter2;

    eventLogService = {
      recordPublished: jest
        .fn()
        .mockResolvedValue({ id: 'event-123', publishedAt: new Date().toISOString() }),
    };

    service = new EventsService(eventEmitter, eventLogService as unknown as EventLogService);
  });

  it('publishes known event with valid payload', async () => {
    const payload = {
      sessionId: 'session-1',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionName: 'devchain_project_epic_agent_session',
    };

    const eventId = await service.publish('session.started', payload);

    expect(eventLogService.recordPublished).toHaveBeenCalledWith({
      name: 'session.started',
      payload,
      requestId: null,
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith('session.started', payload);
    expect(eventId).toBe('event-123');
    const emittedPayload = (eventEmitter.emit as jest.Mock).mock.calls[0][1];
    const metadata = getEventMetadata(emittedPayload);
    expect(metadata).toEqual({ id: 'event-123' });
  });

  it('rejects invalid payloads with ZodError', async () => {
    const publish = service.publish.bind(service) as unknown as (
      name: string,
      payload: unknown,
    ) => Promise<string>;
    await expect(publish('session.started', { sessionId: 'session-1' })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(eventLogService.recordPublished).not.toHaveBeenCalled();
  });

  it('rejects unknown event names', async () => {
    await expect(
      service.publish('unknown.event' as never, { foo: 'bar' } as never),
    ).rejects.toThrow('Unknown event: unknown.event');
    expect(eventEmitter.emit).not.toHaveBeenCalled();
    expect(eventLogService.recordPublished).not.toHaveBeenCalled();
  });
});
