import { createTestDatabase } from '../../common/test/test-database.helper';
/**
 * Persistence of the managed Docker exclusions in the settings map: a
 * changed or empty selection recomputes them, they survive an app restart,
 * and a corrupt stored map blocks reads and writes without losing records. Test layer:
 * integration against a real migrated SQLite database.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  FileSyncManagedExclusionsStore,
  InvalidManagedExclusionsError,
} from './file-sync-managed-exclusions.store';

const SETTINGS_KEY = 'fileSync.managedExclusions';

function openStore(): { store: FileSyncManagedExclusionsStore; sqlite: Database.Database } {
  const { sqlite, db } = createTestDatabase();
  sqlite.pragma('foreign_keys = ON');
  return { store: new FileSyncManagedExclusionsStore(db), sqlite };
}

describe('FileSyncManagedExclusionsStore', () => {
  it('has no managed patterns for a project DevChain owns none for', () => {
    const { store } = openStore();
    expect(store.get('p1')).toEqual([]);
  });

  it('replaces the patterns when the selection changes', () => {
    const { store } = openStore();
    store.set('p1', ['/state/db', '/manual-data']);
    expect(store.get('p1')).toEqual(['/state/db', '/manual-data']);

    store.set('p1', ['/state/db']);
    expect(store.get('p1')).toEqual(['/state/db']);
  });

  it('clears the entry on an empty selection and on null', () => {
    const { store } = openStore();
    store.set('p1', ['/state/db']);

    expect(store.set('p1', [])).toEqual([]);
    expect(store.get('p1')).toEqual([]);

    store.set('p1', ['/state/db']);
    expect(store.set('p1', null)).toEqual([]);
    expect(store.get('p1')).toEqual([]);
  });

  it('keeps each project to itself', () => {
    const { store } = openStore();
    store.set('p1', ['/state/db']);
    store.set('p2', ['/uploads']);

    expect(store.get('p1')).toEqual(['/state/db']);
    expect(store.get('p2')).toEqual(['/uploads']);
    store.set('p1', null);
    expect(store.get('p2')).toEqual(['/uploads']);
  });

  it('survives an app restart on the same database', () => {
    const { store, sqlite } = openStore();
    store.set('p1', ['/state/db']);
    const db = drizzle(sqlite);

    const reopened = new FileSyncManagedExclusionsStore(db);
    expect(reopened.get('p1')).toEqual(['/state/db']);
  });

  it('refuses patterns the ignore schema rejects', () => {
    const { store } = openStore();
    expect(() => store.set('p1', ['x'.repeat(257)])).toThrow();
  });

  it.each([
    '{not json',
    'null',
    '[]',
    '42',
    '"text"',
    JSON.stringify({ p1: 'not-a-list', p2: ['/uploads'] }),
    JSON.stringify({ p1: [123], p2: ['/uploads'] }),
    JSON.stringify({ p1: [''], p2: ['/uploads'] }),
    JSON.stringify({ p1: ['x'.repeat(257)], p2: ['/uploads'] }),
  ])('refuses corrupt persisted records without rewriting them (%#)', (raw) => {
    const { store, sqlite } = openStore();
    try {
      store.set('p1', ['/state/db']);
      sqlite.prepare('UPDATE settings SET value = ? WHERE key = ?').run(raw, SETTINGS_KEY);
      for (const projectId of ['p1', 'p2', 'absent']) {
        expect(() => store.get(projectId)).toThrow(InvalidManagedExclusionsError);
        expect(() => store.set(projectId, ['/replacement'])).toThrow(InvalidManagedExclusionsError);
        expect(() => store.set(projectId, null)).toThrow(InvalidManagedExclusionsError);
      }
      expect(sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY)).toEqual({
        value: raw,
      });
    } finally {
      sqlite.close();
    }
  });

  it('accepts explicitly empty persisted maps and project lists', () => {
    const { store, sqlite } = openStore();
    try {
      store.set('p1', ['/state/db']);
      for (const raw of ['{}', '{"p1":[]}']) {
        sqlite.prepare('UPDATE settings SET value = ? WHERE key = ?').run(raw, SETTINGS_KEY);
        expect(store.get('p1')).toEqual([]);
        expect(store.get('absent')).toEqual([]);
      }
    } finally {
      sqlite.close();
    }
  });
});
