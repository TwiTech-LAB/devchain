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
    service.onModuleDestroy();
    jest.useRealTimers();
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

  it('filters worktree activity events by ownerProjectId from payload', async () => {
    await service.recordPublished({
      id: 'evt-owner-a',
      name: 'orchestrator.worktree.activity',
      payload: {
        worktreeId: 'wt-1',
        ownerProjectId: 'project-a',
        type: 'started',
      },
    });
    await service.recordPublished({
      id: 'evt-owner-b',
      name: 'orchestrator.worktree.activity',
      payload: {
        worktreeId: 'wt-2',
        ownerProjectId: 'project-b',
        type: 'started',
      },
    });

    const filtered = await service.listEvents({
      name: 'orchestrator.worktree.activity',
      ownerProjectId: 'project-a',
      limit: 20,
      offset: 0,
    });

    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.id).toBe('evt-owner-a');
  });

  it('does not throw on malformed payload_json when filtering by ownerProjectId', async () => {
    sqlite
      .prepare(
        `
          INSERT INTO events (id, name, payload_json, request_id, published_at)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        'evt-invalid-owner-filter',
        'epic.updated',
        'not-json',
        null,
        '2026-02-18T00:00:00.000Z',
      );

    await service.recordPublished({
      id: 'evt-valid-owner-filter',
      name: 'epic.updated',
      payload: { ownerProjectId: 'project-safe', epicId: 'epic-1' },
      publishedAt: '2026-02-18T00:00:01.000Z',
    });

    const filtered = await service.listEvents({
      ownerProjectId: 'project-safe',
      limit: 20,
      offset: 0,
    });

    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.id).toBe('evt-valid-owner-filter');
  });

  it('does not throw on malformed payload_json when filtering by name and ownerProjectId', async () => {
    sqlite
      .prepare(
        `
          INSERT INTO events (id, name, payload_json, request_id, published_at)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        'evt-invalid-activity-filter',
        'orchestrator.worktree.activity',
        'not-json',
        null,
        '2026-02-18T00:00:02.000Z',
      );

    await service.recordPublished({
      id: 'evt-valid-activity-filter',
      name: 'orchestrator.worktree.activity',
      payload: {
        ownerProjectId: 'project-safe',
        worktreeId: 'wt-safe',
        type: 'started',
      },
      publishedAt: '2026-02-18T00:00:03.000Z',
    });

    const filtered = await service.listEvents({
      name: 'orchestrator.worktree.activity',
      ownerProjectId: 'project-safe',
      limit: 20,
      offset: 0,
    });

    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.id).toBe('evt-valid-activity-filter');
  });

  it('cleans only old worktree activity events based on retention', async () => {
    const now = Date.now();
    const days = 86_400_000;

    await service.recordPublished({
      id: 'evt-old-activity',
      name: 'orchestrator.worktree.activity',
      payload: { type: 'started' },
      publishedAt: new Date(now - 31 * days).toISOString(),
    });
    await service.recordPublished({
      id: 'evt-recent-activity',
      name: 'orchestrator.worktree.activity',
      payload: { type: 'stopped' },
      publishedAt: new Date(now - 2 * days).toISOString(),
    });
    await service.recordPublished({
      id: 'evt-old-other',
      name: 'epic.updated',
      payload: { epicId: 'epic-1' },
      publishedAt: new Date(now - 31 * days).toISOString(),
    });

    await service.cleanupOldWorktreeActivityEvents();

    const activityEvents = await service.listEvents({
      name: 'orchestrator.worktree.activity',
      limit: 20,
      offset: 0,
    });
    expect(activityEvents.total).toBe(1);
    expect(activityEvents.items[0]?.id).toBe('evt-recent-activity');

    const otherEvents = await service.listEvents({
      name: 'epic.updated',
      limit: 20,
      offset: 0,
    });
    expect(otherEvents.total).toBe(1);
    expect(otherEvents.items[0]?.id).toBe('evt-old-other');
  });

  it('runs cleanup on module init and schedules periodic cleanup', async () => {
    jest.useFakeTimers();
    const cleanupSpy = jest
      .spyOn(service, 'cleanupOldWorktreeActivityEvents')
      .mockResolvedValue(undefined);

    await service.onModuleInit();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(86_400_000);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
    cleanupSpy.mockRestore();
  });
});
