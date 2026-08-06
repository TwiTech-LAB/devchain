import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { EventLogService } from './event-log.service';
import { EventsStreamService } from './events-stream.service';

// Layer: backend integration. Real in-memory SQLite is the cheapest reliable proof
// of limited DELETE behavior, query plans, and foreign-key cascades.
describe('EventLogService', () => {
  let sqlite: Database.Database;
  let service: EventLogService;
  let eventsStreamService: {
    broadcastEventCreated: jest.Mock;
    broadcastHandlerResult: jest.Mock;
  };
  let queries: Array<{ sql: string; params: unknown[] }>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
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
      CREATE INDEX events_name_idx ON events(name);
      CREATE INDEX events_published_at_idx ON events(published_at);
    `);

    eventsStreamService = {
      broadcastEventCreated: jest.fn(),
      broadcastHandlerResult: jest.fn(),
    };

    queries = [];
    const db = drizzle(sqlite, {
      logger: {
        logQuery(sql, params) {
          queries.push({ sql, params });
        },
      },
    }) as unknown as BetterSQLite3Database;
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

  it('filters events by actorId from payload', async () => {
    await service.recordPublished({
      id: 'evt-actor-a',
      name: 'agent.created',
      payload: {
        agentId: 'new-1',
        agentName: 'Bot A',
        projectId: 'project-1',
        profileId: 'profile-1',
        providerConfigId: 'config-1',
        actor: { type: 'agent', id: 'lead-agent-1' },
      },
    });
    await service.recordPublished({
      id: 'evt-actor-b',
      name: 'agent.created',
      payload: {
        agentId: 'new-2',
        agentName: 'Bot B',
        projectId: 'project-1',
        profileId: 'profile-1',
        providerConfigId: 'config-1',
        actor: { type: 'agent', id: 'lead-agent-2' },
      },
    });
    await service.recordPublished({
      id: 'evt-no-actor',
      name: 'agent.created',
      payload: {
        agentId: 'new-3',
        agentName: 'Bot C',
        projectId: 'project-1',
        profileId: 'profile-1',
        providerConfigId: 'config-1',
        actor: null,
      },
    });

    const filtered = await service.listEvents({
      actorId: 'lead-agent-1',
      limit: 20,
      offset: 0,
    });

    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.id).toBe('evt-actor-a');
  });

  it('does not throw on malformed payload_json when filtering by actorId', async () => {
    sqlite
      .prepare(
        `
          INSERT INTO events (id, name, payload_json, request_id, published_at)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        'evt-invalid-actor-filter',
        'agent.created',
        'not-json',
        null,
        '2026-02-18T00:00:00.000Z',
      );

    await service.recordPublished({
      id: 'evt-valid-actor-filter',
      name: 'agent.created',
      payload: {
        agentId: 'new-1',
        agentName: 'Bot',
        projectId: 'p1',
        profileId: 'pr1',
        providerConfigId: 'c1',
        actor: { type: 'agent', id: 'lead-safe' },
      },
      publishedAt: '2026-02-18T00:00:01.000Z',
    });

    const filtered = await service.listEvents({
      actorId: 'lead-safe',
      limit: 20,
      offset: 0,
    });

    expect(filtered.total).toBe(1);
    expect(filtered.items[0]?.id).toBe('evt-valid-actor-filter');
  });

  describe('event retention cleanup', () => {
    const dayMs = 86_400_000;
    const nowIso = '2026-08-03T12:00:00.000Z';

    function insertEvent(id: string, name: string, publishedAt: string): void {
      sqlite
        .prepare(
          `INSERT INTO events (id, name, payload_json, request_id, published_at)
           VALUES (?, ?, '{}', NULL, ?)`,
        )
        .run(id, name, publishedAt);
    }

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date(nowIso));
    });

    it('drains transient rows first, then aged history, under one shared 100-row cap', async () => {
      const now = Date.parse(nowIso);
      const cutoff = new Date(now - 30 * dayMs).toISOString();

      for (let index = 0; index < 101; index += 1) {
        insertEvent(
          `transient-${index}`,
          'session.transcript.updated',
          new Date(now - dayMs).toISOString(),
        );
      }
      insertEvent('old-with-handler', 'epic.updated', new Date(now - 31 * dayMs).toISOString());
      insertEvent('old-other', 'agent.created', new Date(now - 40 * dayMs).toISOString());
      insertEvent('at-cutoff', 'epic.updated', cutoff);
      insertEvent('recent', 'epic.updated', new Date(now - dayMs).toISOString());
      sqlite
        .prepare(
          `INSERT INTO event_handlers
           (id, event_id, handler, status, detail, started_at, ended_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run('handler-1', 'old-with-handler', 'test-handler', 'success', nowIso, nowIso);

      await expect(service.cleanupExpiredEvents()).resolves.toBe(100);
      expect(
        sqlite
          .prepare('SELECT count(*) AS count FROM events WHERE name = ?')
          .get('session.transcript.updated'),
      ).toEqual({ count: 1 });
      expect(
        sqlite.prepare('SELECT count(*) AS count FROM events WHERE id LIKE ?').get('old-%'),
      ).toEqual({ count: 2 });

      await expect(service.cleanupExpiredEvents()).resolves.toBe(3);
      await expect(service.cleanupExpiredEvents()).resolves.toBe(0);
      expect(sqlite.prepare('SELECT id FROM events ORDER BY id').all()).toEqual([
        { id: 'at-cutoff' },
        { id: 'recent' },
      ]);
      expect(sqlite.prepare('SELECT count(*) AS count FROM event_handlers').get()).toEqual({
        count: 0,
      });
    });

    it('keeps transient progress when the aged-history delete fails', async () => {
      const now = Date.parse(nowIso);
      insertEvent('transient', 'session.transcript.updated', nowIso);
      insertEvent('old', 'epic.updated', new Date(now - 31 * dayMs).toISOString());
      sqlite.exec(`
        CREATE TRIGGER reject_old_event_delete
        BEFORE DELETE ON events
        WHEN OLD.name = 'epic.updated'
        BEGIN
          SELECT RAISE(FAIL, 'aged delete failed');
        END;
      `);

      await expect(service.cleanupExpiredEvents()).rejects.toThrow('aged delete failed');
      expect(sqlite.prepare('SELECT id FROM events').all()).toEqual([{ id: 'old' }]);
    });

    it('uses parameterized limited deletes and both production covering indexes', async () => {
      const now = Date.parse(nowIso);
      insertEvent('transient', 'session.transcript.updated', nowIso);
      insertEvent('old', 'epic.updated', new Date(now - 31 * dayMs).toISOString());

      await service.cleanupExpiredEvents();

      const deleteQueries = queries.filter(({ sql }) => sql.startsWith('delete from "events"'));
      expect(deleteQueries).toHaveLength(2);
      for (const query of deleteQueries) {
        expect(query.sql).toContain('?');
        expect(query.sql).toMatch(/ limit \?$/);
        expect(query.sql).not.toMatch(/\b(or|order by|returning|payload_json)\b/i);
      }

      const transientPlan = sqlite
        .prepare('EXPLAIN QUERY PLAN DELETE FROM events WHERE name IN (?) LIMIT ?')
        .all('session.transcript.updated', 100) as Array<{ detail: string }>;
      const agedPlan = sqlite
        .prepare('EXPLAIN QUERY PLAN DELETE FROM events WHERE published_at < ? LIMIT ?')
        .all(new Date(now - 30 * dayMs).toISOString(), 100) as Array<{ detail: string }>;
      expect(
        transientPlan.some(({ detail }) => detail.includes('USING COVERING INDEX events_name_idx')),
      ).toBe(true);
      expect(
        agedPlan.some(({ detail }) =>
          detail.includes('USING COVERING INDEX events_published_at_idx'),
        ),
      ).toBe(true);
    });
  });

  describe('retention scheduler', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('runs on init, unrefs the timer, and catches up after five seconds when full', async () => {
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const cleanupSpy = jest
        .spyOn(service, 'cleanupExpiredEvents')
        .mockResolvedValueOnce(100)
        .mockResolvedValue(0);

      await service.onModuleInit();

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 5_000);
      const timer = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
      expect(timer.hasRef?.()).toBe(false);

      await jest.advanceTimersByTimeAsync(4_999);
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(cleanupSpy).toHaveBeenCalledTimes(2);
    });

    it('uses the 24-hour maintenance cadence after a partial batch', async () => {
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      jest.spyOn(service, 'cleanupExpiredEvents').mockResolvedValue(99);

      await service.onModuleInit();

      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 86_400_000);
    });

    it('retries after 60 seconds when a batch fails', async () => {
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      jest.spyOn(service, 'cleanupExpiredEvents').mockRejectedValue(new Error('database busy'));

      await service.onModuleInit();

      expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 60_000);
    });

    it('does not resurrect a timer when destroyed during an awaited batch', async () => {
      let resolveCleanup!: (deletedCount: number) => void;
      const cleanup = new Promise<number>((resolve) => {
        resolveCleanup = resolve;
      });
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      jest.spyOn(service, 'cleanupExpiredEvents').mockReturnValue(cleanup);

      const init = service.onModuleInit();
      service.onModuleDestroy();
      resolveCleanup(100);
      await init;

      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
