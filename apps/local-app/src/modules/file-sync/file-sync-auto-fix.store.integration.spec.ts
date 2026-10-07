import { createTestDatabase } from '../../common/test/test-database.helper';
import { FileSyncAutoFixStore } from './file-sync-auto-fix.store';
import { FileSyncIgnoresStore, DEFAULT_FILE_SYNC_IGNORES } from './file-sync-ignores.store';

// Real SQLite proves separate settings maps, persistence and atomic list/revision writes.
it('keeps automatic settings and the last ten actions separate from legacy ignore lists', () => {
  const { sqlite, db } = createTestDatabase();
  try {
    const ignores = new FileSyncIgnoresStore(db);
    const auto = new FileSyncAutoFixStore(db);
    expect(auto.get('p')).toEqual({ enabled: true, actions: [] });
    ignores.set('p', ['/kept']);
    auto.setEnabled('p', false);
    for (let index = 0; index < 12; index++)
      auto.record('p', {
        at: new Date(index * 1000).toISOString(),
        kind: 'exclude',
        side: 'vm',
        patterns: [`/output-${index}`],
      });
    auto.record('p', {
      at: new Date(12_000).toISOString(),
      kind: 'chown',
      side: 'home',
      paths: ['output'],
    });
    const reopened = new FileSyncAutoFixStore(db);
    expect(reopened.get('p').enabled).toBe(false);
    expect(reopened.get('p').actions).toHaveLength(10);
    expect(reopened.get('p').actions[0]).toMatchObject({ patterns: ['/output-3'] });
    expect(reopened.get('p').actions[9]).toMatchObject({ kind: 'chown', paths: ['output'] });
    expect(reopened.get('other')).toEqual({ enabled: true, actions: [] });
    expect(new FileSyncIgnoresStore(db).get('p')).toEqual(['/kept']);
    const row = sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('fileSync.ignores') as { value: string };
    expect(JSON.parse(row.value)).toEqual({ p: ['/kept'] });
  } finally {
    sqlite.close();
  }
});

it('increments every list write, rejects a stale revision and restores defaults without resetting it', () => {
  const { sqlite, db } = createTestDatabase();
  try {
    const store = new FileSyncIgnoresStore(db);
    expect(store.revision('p')).toBe(0);
    store.set('p', ['/manual'], 0);
    store.set('p', ['/manual', '/automatic'], 1);
    expect(() => store.set('p', ['/stale'], 1)).toThrow('The file list changed. Review it again.');
    expect(store.get('p')).toEqual(['/manual', '/automatic']);
    expect(store.revision('p')).toBe(2);
    store.set('p', null, 2);
    expect(store.get('p')).toEqual(DEFAULT_FILE_SYNC_IGNORES);
    expect(new FileSyncIgnoresStore(db).revision('p')).toBe(3);
    expect(store.revision('other')).toBe(0);
  } finally {
    sqlite.close();
  }
});

it('rolls back the list when its revision cannot be written', () => {
  const { sqlite, db } = createTestDatabase();
  try {
    const store = new FileSyncIgnoresStore(db);
    sqlite.exec(`CREATE TRIGGER reject_revision BEFORE INSERT ON settings
      WHEN NEW.key = 'fileSync.ignoreRevisions' BEGIN SELECT RAISE(ABORT, 'revision failed'); END`);
    expect(() => store.set('p', ['/would-be-lost'], 0)).toThrow('revision failed');
    expect(store.revision('p')).toBe(0);
    expect(store.get('p')).toEqual(DEFAULT_FILE_SYNC_IGNORES);
  } finally {
    sqlite.close();
  }
});
