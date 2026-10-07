import Database from 'better-sqlite3';
import { SkillsSettingsDelegate, DEFAULT_SKILLS_SYNC_ON_STARTUP } from './skills-settings.delegate';
import { ValidationError } from '../../../../common/errors/error-types';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function createDelegate(db: Database.Database): SkillsSettingsDelegate {
  return new SkillsSettingsDelegate({ sqlite: db });
}

function upsert(db: Database.Database, key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run('test-id', key, value, now, now);
}

describe('SkillsSettingsDelegate', () => {
  let db: Database.Database;
  let delegate: SkillsSettingsDelegate;

  beforeEach(() => {
    db = createTestDb();
    delegate = createDelegate(db);
  });
  afterEach(() => db.close());

  describe('completed source sync records', () => {
    it('persists entries independently and replaces only the named source', () => {
      expect(delegate.getSkillsCompletedSyncs()).toEqual({});
      delegate.setSkillCompletedSync('OpenAI', { commit: 'first', skillCount: 2 });
      delegate.setSkillCompletedSync('anthropic', { commit: 'other', skillCount: 3 });
      delegate.setSkillCompletedSync('openai', { commit: 'latest', skillCount: 1 });
      expect(createDelegate(db).getSkillsCompletedSyncs()).toEqual({
        openai: { commit: 'latest', skillCount: 1 },
        anthropic: { commit: 'other', skillCount: 3 },
      });
    });

    it.each([
      'not-json',
      '[]',
      'null',
      '{"bad":{"commit":1,"skillCount":2}}',
      '{"bad":{"commit":"sha","skillCount":-1}}',
    ])('ignores invalid completion data: %s', (raw) => {
      upsert(db, 'skills.completedSyncs', raw);
      expect(delegate.getSkillsCompletedSyncs()).toEqual({});
    });
  });

  describe('Invariant: syncOnStartup gate', () => {
    it('defaults to true when no setting exists', () => {
      expect(delegate.getSkillsSyncOnStartup()).toBe(DEFAULT_SKILLS_SYNC_ON_STARTUP);
      expect(DEFAULT_SKILLS_SYNC_ON_STARTUP).toBe(true);
    });

    it('returns false when explicitly set to false', () => {
      upsert(db, 'skills.syncOnStartup', 'false');
      expect(delegate.getSkillsSyncOnStartup()).toBe(false);
    });

    it('returns true when explicitly set to true', () => {
      upsert(db, 'skills.syncOnStartup', 'true');
      expect(delegate.getSkillsSyncOnStartup()).toBe(true);
    });

    it('returns true for empty/whitespace value', () => {
      upsert(db, 'skills.syncOnStartup', '   ');
      expect(delegate.getSkillsSyncOnStartup()).toBe(true);
    });

    it('persists syncOnStartup via setSkillsSyncOnStartup', () => {
      delegate.setSkillsSyncOnStartup(false);
      expect(delegate.getSkillsSyncOnStartup()).toBe(false);

      delegate.setSkillsSyncOnStartup(true);
      expect(delegate.getSkillsSyncOnStartup()).toBe(true);
    });

    it('decodes JSON-wrapped syncOnStartup value', () => {
      upsert(db, 'skills.syncOnStartup', JSON.stringify('false'));
      expect(delegate.getSkillsSyncOnStartup()).toBe(false);
    });
  });

  describe('Invariant: blacklist is discovery-only (not access-control)', () => {
    it('disabled source affects discovery only — source key is stored as false, not removed', async () => {
      await delegate.setSkillSourceEnabled('github', true);
      await delegate.setSkillSourceEnabled('github', false);

      const sources = delegate.getSkillSourcesEnabled();
      expect(sources['github']).toBe(false);
      expect('github' in sources).toBe(true);
    });

    it('multiple sources can be independently toggled', async () => {
      await delegate.setSkillSourceEnabled('github', false);
      await delegate.setSkillSourceEnabled('npm', true);
      await delegate.setSkillSourceEnabled('local', false);

      const sources = delegate.getSkillSourcesEnabled();
      expect(sources).toEqual({
        github: false,
        npm: true,
        local: false,
      });
    });

    it('setSkillSourceEnabled normalizes source name to lowercase', async () => {
      await delegate.setSkillSourceEnabled('GitHub/Skills', true);

      const sources = delegate.getSkillSourcesEnabled();
      expect(sources['github/skills']).toBe(true);
      expect(sources['GitHub/Skills']).toBeUndefined();
    });
  });

  describe('Invariant: normalizeSkillSourcesMap', () => {
    it('normalizes keys to lowercase and trims whitespace', () => {
      const result = delegate.normalizeSkillSourcesMap({
        '  GitHub  ': true,
        NPM: false,
      });
      expect(result).toEqual({ github: true, npm: false });
    });

    it('filters out non-boolean values', () => {
      const result = delegate.normalizeSkillSourcesMap({
        valid: true,
        invalid: 'yes' as unknown as boolean,
        alsoInvalid: 1 as unknown as boolean,
      });
      expect(result).toEqual({ valid: true });
    });

    it('filters out empty/whitespace-only keys', () => {
      const result = delegate.normalizeSkillSourcesMap({
        '': true,
        '   ': true,
        valid: false,
      });
      expect(result).toEqual({ valid: false });
    });

    it('returns empty object for empty input', () => {
      expect(delegate.normalizeSkillSourcesMap({})).toEqual({});
    });
  });

  describe('Invariant: getSkillSourcesEnabled handles edge cases', () => {
    it('returns empty object when no sources stored', () => {
      expect(delegate.getSkillSourcesEnabled()).toEqual({});
    });

    it('returns empty object for invalid JSON', () => {
      upsert(db, 'skills.sources', 'not-json');
      expect(delegate.getSkillSourcesEnabled()).toEqual({});
    });

    it('returns empty object for JSON array instead of object', () => {
      upsert(db, 'skills.sources', '[1,2,3]');
      expect(delegate.getSkillSourcesEnabled()).toEqual({});
    });

    it('reads JSON-wrapped sources value', () => {
      upsert(db, 'skills.sources', JSON.stringify(JSON.stringify({ github: true })));
      const result = delegate.getSkillSourcesEnabled();
      expect(result['github']).toBe(true);
    });

    it('filters out non-boolean entries from stored sources', () => {
      upsert(db, 'skills.sources', JSON.stringify({ valid: true, invalid: 'yes' }));
      const result = delegate.getSkillSourcesEnabled();
      expect(result).toEqual({ valid: true });
    });
  });

  describe('setSkillSourceEnabled validation', () => {
    it('rejects whitespace-only sourceName', async () => {
      await expect(delegate.setSkillSourceEnabled('   ', true)).rejects.toThrow(ValidationError);
    });
  });

  describe('setSkillSourceEnabled persistence', () => {
    it('persists via direct sqlite write (no updateSettings routing)', async () => {
      await delegate.setSkillSourceEnabled('test-source', true);

      const row = db.prepare("SELECT value FROM settings WHERE key = 'skills.sources'").get() as
        | { value: string }
        | undefined;
      expect(row).toBeDefined();

      const parsed = JSON.parse(row!.value);
      expect(parsed['test-source']).toBe(true);
    });
  });

  describe('Invariant: the built-in devchain source is always enabled', () => {
    const storedRow = (): Record<string, boolean> =>
      JSON.parse(
        (
          db.prepare("SELECT value FROM settings WHERE key = 'skills.sources'").get() as {
            value: string;
          }
        ).value,
      );

    it('normalization drops the devchain key and keeps devchain-local', () => {
      expect(
        delegate.normalizeSkillSourcesMap({ DevChain: false, 'devchain-local': false, a: true }),
      ).toEqual({ 'devchain-local': false, a: true });
    });

    it('reads a legacy stored devchain=false as absent; the stored read keeps it', () => {
      upsert(db, 'skills.sources', JSON.stringify({ devchain: false, other: false }));

      expect(delegate.getSkillSourcesEnabled()).toEqual({ other: false });
      expect(delegate.getStoredSkillSourcesEnabled()).toEqual({ devchain: false, other: false });
    });

    it('setSkillSourceEnabled never stores devchain=false and drops a legacy value', async () => {
      upsert(db, 'skills.sources', JSON.stringify({ devchain: false }));

      await delegate.setSkillSourceEnabled('DevChain', false);
      expect(storedRow()).toEqual({});

      await delegate.setSkillSourceEnabled('other', false);
      expect(storedRow()).toEqual({ other: false });
    });

    it('mergeSkillSourcesEnabled rewrites a legacy devchain=false as true', () => {
      upsert(db, 'skills.sources', JSON.stringify({ devchain: false, vm: false }));

      delegate.mergeSkillSourcesEnabled({ devchain: true, home: true });
      expect(storedRow()).toEqual({ devchain: true, vm: false, home: true });

      upsert(db, 'skills.sources', JSON.stringify({ devchain: false }));
      delegate.mergeSkillSourcesEnabled({ devchain: false });
      expect(storedRow()).toEqual({ devchain: true });
    });
  });
});
