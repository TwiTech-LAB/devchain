import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { EventLogService } from './event-log.service';
import { EventsStreamService } from './events-stream.service';

describe('EventLogService', () => {
  let sqlite: Database.Database;
  let service: EventLogService;
  let eventsStreamService: {
    broadcastEventCreated: jest.Mock;
    broadcastHandlerResult: jest.Mock;
  };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        request_id TEXT,
        published_at TEXT NOT NULL
      );
      CREATE TABLE event_handlers (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        handler TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
      );
    `);

    eventsStreamService = {
      broadcastEventCreated: jest.fn(),
      broadcastHandlerResult: jest.fn(),
    };

    const db = drizzle(sqlite) as unknown as BetterSQLite3Database;
    service = new EventLogService(db, eventsStreamService as unknown as EventsStreamService);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('records events and handler results then lists them with filters', async () => {
    const { id: eventId, publishedAt } = await service.recordPublished({
      name: 'epic.assigned',
      payload: { epicId: 'epic-1', agentId: 'agent-1' },
      requestId: 'req-123',
    });

    await service.recordHandledOk({
      eventId,
      handler: 'EpicAssignmentNotifier',
      detail: { sessionId: 'session-1' },
    });

    const result = await service.listEvents({
      name: 'epic.assigned',
      handler: 'EpicAssignmentNotifier',
      status: 'success',
      from: new Date(new Date(publishedAt).getTime() - 1).toISOString(),
      to: new Date(new Date(publishedAt).getTime() + 1).toISOString(),
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(1);
    const [event] = result.items;
    expect(event.id).toBe(eventId);
    expect(event.handlers).toHaveLength(1);
    expect(event.handlers[0]).toMatchObject({
      handler: 'EpicAssignmentNotifier',
      status: 'success',
      detail: { sessionId: 'session-1' },
    });
    expect(eventsStreamService.broadcastEventCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: eventId, name: 'epic.assigned' }),
    );
    expect(eventsStreamService.broadcastHandlerResult).toHaveBeenCalledWith(
      expect.objectContaining({ eventId, handler: 'EpicAssignmentNotifier', status: 'success' }),
    );
  });

  it('filters by status and handler', async () => {
    const { id: eventId } = await service.recordPublished({
      name: 'epic.assigned',
      payload: {},
    });

    await service.recordHandledFail({
      eventId,
      handler: 'EpicAssignmentNotifier',
      detail: { error: 'failed' },
    });

    const successResults = await service.listEvents({ status: 'success' });
    expect(successResults.total).toBe(0);

    const failureResults = await service.listEvents({
      status: 'failure',
      handler: 'EpicAssignmentNotifier',
    });
    expect(failureResults.total).toBe(1);
    expect(failureResults.items[0].handlers[0].status).toBe('failure');
  });
});
