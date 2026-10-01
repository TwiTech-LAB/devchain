import Database from 'better-sqlite3';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import {
  PROVIDER_CLI_VERSIONS_SETTING_KEY,
  ProviderCliSettingsDelegate,
  defaultProviderCliEntry,
} from './provider-cli-settings.delegate';
import { CoreSettingsDelegate } from './core-settings.delegate';
import { SettingsSchema } from '../../dtos/settings.dto';
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

function createMockEventEmitter(): EventEmitter2 {
  return { emit: jest.fn() } as unknown as EventEmitter2;
}

function readRawRow(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

describe('ProviderCliSettingsDelegate', () => {
  let db: Database.Database;
  let delegate: ProviderCliSettingsDelegate;

  beforeEach(() => {
    db = createTestDb();
    delegate = new ProviderCliSettingsDelegate({ sqlite: db });
  });
  afterEach(() => db.close());

  describe('defaults', () => {
    it('returns latest + not home-managed for every allowlisted provider when nothing is stored', () => {
      const result = delegate.getProviderCliVersions();
      expect(result).toEqual({
        claude: { version: 'latest', homeManaged: false },
        codex: { version: 'latest', homeManaged: false },
        copilot: { version: 'latest', homeManaged: false },
        opencode: { version: 'latest', homeManaged: false },
      });
      expect(defaultProviderCliEntry()).toEqual({ version: 'latest', homeManaged: false });
    });
  });

  describe('setProviderCliVersion', () => {
    it('persists one provider and keeps the others at their defaults', () => {
      delegate.setProviderCliVersion('claude', { version: '2.1.281', homeManaged: true });

      const result = delegate.getProviderCliVersions();
      expect(result.claude).toEqual({ version: '2.1.281', homeManaged: true });
      expect(result.codex).toEqual({ version: 'latest', homeManaged: false });
      expect(result.opencode).toEqual({ version: 'latest', homeManaged: false });
    });

    it('survives a delegate rebuild over the same database (restart persistence)', () => {
      delegate.setProviderCliVersion('opencode', { version: '1.18.32', homeManaged: true });
      const reopened = new ProviderCliSettingsDelegate({ sqlite: db });
      expect(reopened.getProviderCliVersions().opencode).toEqual({
        version: '1.18.32',
        homeManaged: true,
      });
    });

    it('updates only the named provider on a later save', () => {
      delegate.setProviderCliVersion('claude', { version: '2.1.281', homeManaged: true });
      delegate.setProviderCliVersion('codex', { version: '0.156.1', homeManaged: false });

      const result = delegate.getProviderCliVersions();
      expect(result.claude).toEqual({ version: '2.1.281', homeManaged: true });
      expect(result.codex).toEqual({ version: '0.156.1', homeManaged: false });
    });

    it.each(['agy', 'gemini', '', 'CLAUDE'])('rejects unknown provider %s', (provider) => {
      expect(() =>
        delegate.setProviderCliVersion(provider, { version: 'latest', homeManaged: false }),
      ).toThrow(ValidationError);
    });

    it.each(['1.2', '1.2.3-beta.1', 'v1.2.3', '01.2.3', 'newest', ''])(
      'rejects non-exact version %s',
      (version) => {
        expect(() =>
          delegate.setProviderCliVersion('claude', { version, homeManaged: false }),
        ).toThrow(ValidationError);
      },
    );

    it('rejects a non-boolean homeManaged', () => {
      expect(() =>
        delegate.setProviderCliVersion('claude', {
          version: 'latest',
          homeManaged: 'yes' as unknown as boolean,
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('stored-map tolerance', () => {
    it('drops unknown providers and invalid entries from a stored map instead of failing', () => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'row-1',
        PROVIDER_CLI_VERSIONS_SETTING_KEY,
        JSON.stringify({
          claude: { version: '2.1.281', homeManaged: true },
          agy: { version: 'latest', homeManaged: false },
          codex: { version: 'preview', homeManaged: false },
        }),
        now,
        now,
      );

      const result = delegate.getProviderCliVersions();
      expect(result.claude).toEqual({ version: '2.1.281', homeManaged: true });
      expect(result.agy).toBeUndefined();
      expect(result.codex).toEqual({ version: 'latest', homeManaged: false });
    });

    it('falls back to defaults for malformed stored JSON', () => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run('row-1', PROVIDER_CLI_VERSIONS_SETTING_KEY, '{not json', now, now);

      expect(delegate.getProviderCliVersions().claude).toEqual({
        version: 'latest',
        homeManaged: false,
      });
    });
  });

  describe('isolation from the generic settings save path', () => {
    it('a PUT /api/settings body cannot carry the providers key through SettingsSchema', () => {
      const parsed = SettingsSchema.parse({
        providers: { cliVersions: { claude: { version: '0.0.1', homeManaged: true } } },
      });
      expect(parsed).not.toHaveProperty('providers');
    });

    it('a CoreSettingsDelegate.updateSettings save leaves the stored providers.cliVersions row untouched', async () => {
      delegate.setProviderCliVersion('claude', { version: '2.1.281', homeManaged: true });
      const before = readRawRow(db, PROVIDER_CLI_VERSIONS_SETTING_KEY);

      const core = new CoreSettingsDelegate({ sqlite: db, eventEmitter: createMockEventEmitter() });
      await core.updateSettings({ terminal: { scrollbackLines: 5000 } });

      expect(readRawRow(db, PROVIDER_CLI_VERSIONS_SETTING_KEY)).toBe(before);
      expect(
        new ProviderCliSettingsDelegate({ sqlite: db }).getProviderCliVersions().claude,
      ).toEqual({ version: '2.1.281', homeManaged: true });
    });
  });
});
