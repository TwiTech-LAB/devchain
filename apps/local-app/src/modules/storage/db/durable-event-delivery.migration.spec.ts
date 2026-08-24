import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_PATH = join(__dirname, '../../../../drizzle/0074_black_drax.sql');

// Layer: backend integration. SQLite itself must prove the partial uniqueness
// and backwards-compatible audit-row shape introduced by this migration.
describe('0074 durable event delivery migration', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE events (id TEXT PRIMARY KEY NOT NULL);
      CREATE TABLE event_handlers (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        handler TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      INSERT INTO events (id) VALUES ('event-1');
      INSERT INTO event_handlers
        (id, event_id, handler, status, detail, started_at, ended_at)
      VALUES ('audit-1', 'event-1', 'AuditHandler', 'success', NULL, 'start', 'end');
    `);
    sqlite.exec(readFileSync(MIGRATION_PATH, 'utf8').replace(/--> statement-breakpoint/g, ''));
  });

  afterEach(() => sqlite.close());

  it('preserves audit rows and enforces one nullable delivery identity per event', () => {
    expect(
      sqlite.prepare('SELECT status, delivery_key, attempts FROM event_handlers').get(),
    ).toEqual({ status: 'success', delivery_key: null, attempts: 0 });

    const insert = sqlite.prepare(
      `INSERT INTO event_handlers
        (id, event_id, handler, status, delivery_key, attempts, started_at)
       VALUES (?, 'event-1', ?, ?, ?, ?, 'start')`,
    );
    insert.run('delivery-1', 'sync', 'pending', 'managed-subtask-sync', 0);
    expect(() => insert.run('delivery-2', 'sync', 'retry', 'managed-subtask-sync', 1)).toThrow(
      /UNIQUE constraint failed/,
    );
    expect(() => insert.run('audit-2', 'AuditAgain', 'failure', null, 0)).not.toThrow();
  });
});
