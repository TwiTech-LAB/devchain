import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { CommittedEventStore } from './committed-event.store';
import { DurableEventRegistryService, type PreparedEvent } from './durable-event-registry.service';

// Layer: backend integration. Per-key eligibility and committed-row ordering
// depend on real SQLite selection and compare-and-set behavior.
describe('CommittedEventStore keyed claims', () => {
  let sqlite: Database.Database;
  let registry: DurableEventRegistryService;
  let store: CommittedEventStore;

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
    registry = new DurableEventRegistryService();
    store = new CommittedEventStore(drizzle(sqlite) as unknown as BetterSQLite3Database, registry);
  });

  afterEach(() => sqlite.close());

  const event = (id: string): PreparedEvent<'epic.created'> => ({
    id,
    name: 'epic.created',
    payload: {
      epicId: id,
      projectId: 'project-1',
      title: id,
      statusId: 'status-1',
      parentId: null,
      actor: null,
    },
    requestId: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
  });

  it('creates and claims one idempotent delivery row per registered key', async () => {
    for (const deliveryKey of ['external-sync', 'time-accounting']) {
      registry.register({
        deliveryKey,
        eventNames: ['epic.created'],
        handle: async () => undefined,
      });
    }
    await store.appendCommitted(event('event-1'));

    expect(
      sqlite.prepare('SELECT delivery_key FROM event_handlers ORDER BY delivery_key').all(),
    ).toEqual([{ delivery_key: 'external-sync' }, { delivery_key: 'time-accounting' }]);
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO event_handlers
             (id, event_id, handler, status, delivery_key, attempts, started_at)
           SELECT 'duplicate-delivery', event_id, handler, status, delivery_key, attempts, started_at
           FROM event_handlers
           WHERE delivery_key = 'external-sync'`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/);

    const first = await store.claimNext('worker', 30_000);
    expect(first?.deliveryKey).toBe('external-sync');
    await store.markDelivered(first!);
    await expect(store.claimNext('worker', 30_000)).resolves.toMatchObject({
      deliveryKey: 'time-accounting',
      event: { id: 'event-1' },
    });
  });

  it('keeps unordered eligibility-first skip-and-continue behavior', async () => {
    registry.register({
      deliveryKey: 'external-sync',
      eventNames: ['epic.created'],
      handle: async () => undefined,
    });
    await store.appendCommitted(event('z-first'));
    await store.appendCommitted(event('a-second'));

    const first = await store.claimNext('worker', 30_000);
    expect(first?.event.id).toBe('z-first');
    await store.markRetry(first!, new Date('2026-01-01T00:00:00.000Z'));

    await expect(
      store.claimNext('worker', 30_000, new Date('2026-01-01T00:00:00.500Z')),
    ).resolves.toMatchObject({ deliveryKey: 'external-sync', event: { id: 'a-second' } });
  });

  it('blocks only an ordered key behind its oldest nonterminal delivery', async () => {
    registry.register({
      deliveryKey: 'time-accounting',
      eventNames: ['epic.created'],
      ordered: true,
      handle: async () => undefined,
    });
    registry.register({
      deliveryKey: 'external-sync',
      eventNames: ['epic.created'],
      handle: async () => undefined,
    });
    await store.appendCommitted(event('z-first'));
    await store.appendCommitted(event('a-second'));

    const orderedFirst = await store.claimNext('worker', 30_000);
    expect(orderedFirst).toMatchObject({
      deliveryKey: 'time-accounting',
      event: { id: 'z-first' },
    });
    await store.markRetry(orderedFirst!, new Date('2026-01-01T00:00:00.000Z'));

    const otherKey = await store.claimNext('worker', 30_000, new Date('2026-01-01T00:00:00.500Z'));
    expect(otherKey).toMatchObject({
      deliveryKey: 'external-sync',
      event: { id: 'z-first' },
    });
    await store.markDelivered(otherKey!);
    const otherKeySecond = await store.claimNext(
      'worker',
      30_000,
      new Date('2026-01-01T00:00:00.500Z'),
    );
    expect(otherKeySecond).toMatchObject({
      deliveryKey: 'external-sync',
      event: { id: 'a-second' },
    });

    const retry = await store.claimNext('worker', 30_000, new Date('2026-01-01T00:00:01.000Z'));
    expect(retry).toMatchObject({ deliveryKey: 'time-accounting', event: { id: 'z-first' } });
  });

  it('keeps a live ordered lease from blocking another key', async () => {
    registry.register({
      deliveryKey: 'time-accounting',
      eventNames: ['epic.created'],
      ordered: true,
      handle: async () => undefined,
    });
    registry.register({
      deliveryKey: 'external-sync',
      eventNames: ['epic.created'],
      handle: async () => undefined,
    });
    await store.appendCommitted(event('event-1'));

    const leased = await store.claimNext('worker', 30_000, new Date('2026-01-01T00:00:00.000Z'));
    expect(leased?.deliveryKey).toBe('time-accounting');

    await expect(
      store.claimNext('worker', 30_000, new Date('2026-01-01T00:00:00.500Z')),
    ).resolves.toMatchObject({ deliveryKey: 'external-sync', event: { id: 'event-1' } });
  });
});
