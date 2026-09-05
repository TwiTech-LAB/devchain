import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { CommittedEventStore } from './committed-event.store';
import { DurableEventDispatcherService } from './durable-event-dispatcher.service';
import { DurableEventRegistryService } from './durable-event-registry.service';
import { isTransientEvent, type EventName } from '../catalog';

// Layer: backend integration. Lease recovery and state transitions depend on
// compare-and-set SQL behavior, so real in-memory SQLite is the cheapest proof.
describe('DurableEventDispatcherService', () => {
  let sqlite: Database.Database;
  let store: CommittedEventStore;
  let registry: DurableEventRegistryService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, payload_json TEXT NOT NULL,
        request_id TEXT, published_at TEXT NOT NULL
      );
      CREATE TABLE event_handlers (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, handler TEXT NOT NULL,
        status TEXT NOT NULL, delivery_key TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        retry_at TEXT, lease_owner TEXT, lease_expires_at TEXT, detail TEXT,
        started_at TEXT NOT NULL, ended_at TEXT,
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX event_handlers_event_delivery_unique
        ON event_handlers(event_id, delivery_key) WHERE delivery_key IS NOT NULL;
    `);
    const db = drizzle(sqlite) as unknown as BetterSQLite3Database;
    registry = new DurableEventRegistryService();
    store = new CommittedEventStore(db, registry);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('recovers an expired lease and marks the at-least-once delivery delivered', async () => {
    const handle = jest.fn().mockResolvedValue(undefined);
    registry.register({
      deliveryKey: 'sync',
      eventNames: ['epic.deleted'],
      handle,
    });
    await store.appendCommitted({
      id: 'event-1',
      name: 'epic.deleted',
      payload: {
        epicId: 'epic-1',
        projectId: 'project-1',
        title: 'Deleted',
        parentId: null,
        actor: null,
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:00.000Z',
    });
    const abandoned = await store.claimNext(
      'crashed-worker',
      1,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(abandoned?.attempts).toBe(1);

    const dispatcher = new DurableEventDispatcherService(store, registry);
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(1);

    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-1' }));
    expect(
      sqlite
        .prepare(
          'SELECT status, attempts, lease_owner, lease_expires_at FROM event_handlers WHERE event_id = ?',
        )
        .get('event-1'),
    ).toEqual({
      status: 'delivered',
      attempts: 2,
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it('keeps failures retryable without creating audit success or failure rows', async () => {
    registry.register({
      deliveryKey: 'sync',
      eventNames: ['epic.updated'],
      handle: jest.fn().mockRejectedValue(new Error('handler failed')),
    });
    await store.appendCommitted({
      id: 'event-2',
      name: 'epic.updated',
      payload: {
        epicId: 'epic-2',
        projectId: 'project-1',
        parentId: null,
        version: 2,
        epicTitle: 'Updated',
        changes: { description: { previous: null, current: 'new' } },
      },
      requestId: null,
      publishedAt: new Date().toISOString(),
    });

    const dispatcher = new DurableEventDispatcherService(store, registry);
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(0);

    const row = sqlite
      .prepare(
        'SELECT status, attempts, retry_at, delivery_key FROM event_handlers WHERE event_id = ?',
      )
      .get('event-2') as Record<string, unknown>;
    expect(row).toMatchObject({ status: 'retry', attempts: 1, delivery_key: 'sync' });
    expect(row.retry_at).toEqual(expect.any(String));
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM event_handlers WHERE status IN ('success','failure')",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it('dispatches one committed event to each exact subscriber key', async () => {
    const externalHandle = jest.fn().mockResolvedValue(undefined);
    const timeHandle = jest.fn().mockResolvedValue(undefined);
    registry.register({
      deliveryKey: 'external-sync',
      eventNames: ['epic.deleted'],
      handle: externalHandle,
    });
    registry.register({
      deliveryKey: 'time-accounting',
      eventNames: ['epic.deleted'],
      ordered: true,
      handle: timeHandle,
    });
    await store.appendCommitted({
      id: 'event-keyed',
      name: 'epic.deleted',
      payload: {
        epicId: 'epic-1',
        projectId: 'project-1',
        title: 'Deleted',
        parentId: null,
        actor: null,
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:00.000Z',
    });

    const dispatcher = new DurableEventDispatcherService(store, registry);
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(2);
    expect(externalHandle).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-keyed' }));
    expect(timeHandle).toHaveBeenCalledWith(expect.objectContaining({ id: 'event-keyed' }));
  });

  it('delivers a seeded project-less connection fact once without retrying forever', async () => {
    const handle = jest.fn().mockResolvedValue(undefined);
    registry.register({
      deliveryKey: 'managed-subtask-sync',
      eventNames: ['integration.connection.updated'],
      handle,
    });
    const legacyPayload = {
      connectionId: 'legacy-connection',
      provider: 'clickup',
      previousGeneration: 1,
      generation: 2,
      previousSubtaskSyncEnabled: false,
      subtaskSyncEnabled: true,
      previousSyncSettingRevision: 1,
      syncSettingRevision: 2,
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T01:00:00.000Z',
    };
    sqlite
      .prepare(
        `INSERT INTO events (id, name, payload_json, request_id, published_at)
         VALUES ('legacy-event', 'integration.connection.updated', ?, NULL, ?)`,
      )
      .run(JSON.stringify(legacyPayload), '2026-08-25T01:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO event_handlers (
          id, event_id, handler, status, delivery_key, attempts, started_at
        ) VALUES (
          'legacy-delivery', 'legacy-event', 'managed-subtask-sync', 'pending',
          'managed-subtask-sync', 0, '2026-08-25T01:00:00.000Z'
        )`,
      )
      .run();

    const dispatcher = new DurableEventDispatcherService(store, registry);
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(1);
    await expect(dispatcher.dispatchAvailable()).resolves.toBe(0);

    expect(handle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'legacy-event',
        name: 'integration.connection.updated',
        payload: legacyPayload,
      }),
    );
    expect(
      sqlite
        .prepare('SELECT status, attempts, retry_at FROM event_handlers WHERE id = ?')
        .get('legacy-delivery'),
    ).toEqual({ status: 'delivered', attempts: 1, retry_at: null });
  });

  it('rejects transient durable subscriptions', () => {
    expect(
      [
        'integration.connection.created',
        'integration.connection.updated',
        'integration.connection.deleted',
      ].some((name) => isTransientEvent(name as EventName)),
    ).toBe(false);
    expect(() =>
      registry.register({
        deliveryKey: 'transient',
        eventNames: ['session.transcript.updated'],
        handle: async () => {},
      }),
    ).toThrow('cannot use durable delivery');
  });
});
