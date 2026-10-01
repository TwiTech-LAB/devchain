/**
 * Persistence of the Docker import inventory in the settings map: entries
 * are keyed by (projectId, remoteId), survive unbind and app restarts, and
 * the strict schema keeps container settings and Env out. Test layer:
 * integration against a real migrated SQLite database.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import {
  DockerImportInventoryStore,
  type DockerImportInventory,
} from './docker-import-inventory.store';

function openStore(): DockerImportInventoryStore {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite);
  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder: join(__dirname, '../../../../drizzle') });
  sqlite.pragma('foreign_keys = ON');
  return new DockerImportInventoryStore(db);
}

const IMPORTED_AT = '2026-09-27T12:00:00.000Z';

function inventory(overrides: Partial<DockerImportInventory> = {}): DockerImportInventory {
  return {
    items: [
      {
        name: 'web',
        imageId: 'sha256:5f1c7b',
        volumes: [{ name: 'web-data', sizeBytes: 4096 }],
        bindPaths: ['/state/db'],
        sizeBytes: 4096,
      },
    ],
    importedAt: IMPORTED_AT,
    ...overrides,
  };
}

describe('DockerImportInventoryStore', () => {
  it('reads null when nothing was imported for the pair', () => {
    const store = openStore();
    expect(store.get('p1', 'r1')).toBeNull();
  });

  it('stores and reads by (projectId, remoteId)', () => {
    const store = openStore();
    const entry = inventory();
    store.set('p1', 'r1', entry);

    expect(store.get('p1', 'r1')).toEqual(entry);
    expect(store.get('p1', 'r2')).toBeNull();
    expect(store.get('p2', 'r1')).toBeNull();
  });

  it('replaces the pair entry on a re-import', () => {
    const store = openStore();
    store.set('p1', 'r1', inventory());
    const replacement = inventory({
      items: [{ name: 'db', imageId: 'sha256:9a2', volumes: [], bindPaths: [], sizeBytes: null }],
      importedAt: '2026-09-28T09:00:00.000Z',
    });

    store.set('p1', 'r1', replacement);

    expect(store.get('p1', 'r1')).toEqual(replacement);
  });

  it('deletes only the addressed pair', () => {
    const store = openStore();
    store.set('p1', 'r1', inventory());
    store.set('p1', 'r2', inventory());
    store.set('p2', 'r1', inventory());

    store.delete('p1', 'r1');

    expect(store.get('p1', 'r1')).toBeNull();
    expect(store.get('p1', 'r2')).toEqual(inventory());
    expect(store.get('p2', 'r1')).toEqual(inventory());
  });

  it('survives unbind and app restarts on the same database', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    const db = drizzle(sqlite);
    sqlite.pragma('foreign_keys = OFF');
    migrate(db, { migrationsFolder: join(__dirname, '../../../../drizzle') });
    sqlite.pragma('foreign_keys = ON');
    new DockerImportInventoryStore(db).set('p1', 'r1', inventory());
    // `unbind` removes the binding, never the inventory; a restart reopens
    // the same database.
    sqlite.prepare('DELETE FROM remote_project_bindings').run();

    const reopened = new DockerImportInventoryStore(db);
    expect(reopened.get('p1', 'r1')).toEqual(inventory());
  });

  it('refuses Env and other container settings loudly', () => {
    const store = openStore();
    const withEnv = {
      ...inventory(),
      items: [{ ...inventory().items[0], env: ['SECRET=1'] }],
    } as unknown;

    expect(() => store.set('p1', 'r1', withEnv)).toThrow();

    const withSettings = {
      ...inventory(),
      items: [{ ...inventory().items[0], config: { privileged: true } }],
    } as unknown;

    expect(() => store.set('p1', 'r1', withSettings)).toThrow();
    expect(store.get('p1', 'r1')).toBeNull();
  });

  it('drops a malformed stored entry and keeps the valid ones', () => {
    const store = openStore();
    store.set('p1', 'r1', inventory());
    store.set('p1', 'r2', inventory());
    const raw = JSON.stringify({
      p1: {
        r1: { items: [{ name: 'web', env: ['SECRET=1'] }], importedAt: IMPORTED_AT },
        r2: inventory(),
      },
    });
    store['sqlite']
      .prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run(raw, 'docker.importInventory');

    expect(store.get('p1', 'r1')).toBeNull();
    expect(store.get('p1', 'r2')).toEqual(inventory());
  });
});

it('persists group baselines and deletes all records of a reset VM, including disconnected projects', () => {
  const store = openStore();
  const entry = inventory({
    groups: [
      {
        volumes: ['data'],
        bindPaths: ['/home/state'],
        lastSyncedAt: IMPORTED_AT,
        lastSyncDirection: 'to-home',
        homeDiscardedAt: IMPORTED_AT,
        vmDiscardedAt: IMPORTED_AT,
      },
    ],
  });
  store.set('p1', 'r1', entry);
  store.set('p2', 'r1', entry);
  store.set('p1', 'r2', entry);
  expect(store.get('p1', 'r1')).toEqual(entry);
  store.deleteRemote('r1');
  expect(store.get('p1', 'r1')).toBeNull();
  expect(store.get('p2', 'r1')).toBeNull();
  expect(store.get('p1', 'r2')).toEqual(entry);
});

it('stores an explicit discard without fabricating a verified copy baseline', () => {
  const store = openStore();
  const entry = inventory({
    groups: [{ volumes: ['data'], bindPaths: [], homeDiscardedAt: IMPORTED_AT }],
  });
  store.set('p1', 'r1', entry);
  expect(store.get('p1', 'r1')?.groups).toEqual(entry.groups);
  expect(() =>
    store.set('p1', 'r1', inventory({ groups: [{ volumes: ['data'], bindPaths: [] }] })),
  ).toThrow();
});
