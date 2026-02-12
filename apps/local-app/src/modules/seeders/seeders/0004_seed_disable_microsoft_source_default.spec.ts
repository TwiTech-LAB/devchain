import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { WatchersService } from '../../watchers/services/watchers.service';
import type { SeederContext } from '../services/data-seeder.service';
import {
  runSeedDisableMicrosoftSourceDefault,
  seedDisableMicrosoftSourceDefaultSeeder,
} from './0004_seed_disable_microsoft_source_default';

describe('0004_seed_disable_microsoft_source_default', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db = drizzle(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  function createContext(info?: jest.Mock): SeederContext {
    return {
      storage: {} as StorageService,
      watchersService: {} as WatchersService,
      db,
      logger: {
        info: info ?? jest.fn(),
      } as unknown as SeederContext['logger'],
    };
  }

  function getSourceSettingsValue(): string | null {
    const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get('skills.sources') as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  it('seeds microsoft disabled defaults when skills.sources is missing', async () => {
    const info = jest.fn();

    await runSeedDisableMicrosoftSourceDefault(createContext(info));

    expect(getSourceSettingsValue()).toBe(JSON.stringify({ microsoft: false }));
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        seederName: '0004_seed_disable_microsoft_source_default',
        seederVersion: 1,
        created: 1,
        skipped: 0,
        key: 'skills.sources',
      }),
      'Disable-microsoft-default source seeder completed',
    );
  });

  it('does not override existing skills.sources settings', async () => {
    sqlite
      .prepare(
        `
          INSERT INTO settings (id, key, value, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        'settings-1',
        'skills.sources',
        JSON.stringify({ microsoft: true, openai: false }),
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z',
      );
    const info = jest.fn();

    await runSeedDisableMicrosoftSourceDefault(createContext(info));

    expect(getSourceSettingsValue()).toBe(JSON.stringify({ microsoft: true, openai: false }));
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        created: 0,
        skipped: 1,
        reason: 'skills.sources already exists',
      }),
      'Disable-microsoft-default source seeder completed',
    );
  });

  it('is idempotent across repeated runs', async () => {
    await runSeedDisableMicrosoftSourceDefault(createContext());
    await runSeedDisableMicrosoftSourceDefault(createContext());

    const countRow = sqlite
      .prepare('SELECT COUNT(*) as count FROM settings WHERE key = ?')
      .get('skills.sources') as { count: number };
    expect(countRow.count).toBe(1);
    expect(getSourceSettingsValue()).toBe(JSON.stringify({ microsoft: false }));
  });

  it('exports seeder metadata and run function', () => {
    expect(seedDisableMicrosoftSourceDefaultSeeder).toMatchObject({
      name: '0004_seed_disable_microsoft_source_default',
      version: 1,
      run: runSeedDisableMicrosoftSourceDefault,
    });
  });
});
