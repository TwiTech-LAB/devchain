import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DataSeederService, type DataSeeder } from './data-seeder.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { WatchersService } from '../../watchers/services/watchers.service';

describe('DataSeederService', () => {
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

  function createService(seeders: DataSeeder[]): DataSeederService {
    return new DataSeederService({} as StorageService, {} as WatchersService, db, seeders);
  }

  function upsertJournal(rawValue: string): void {
    sqlite
      .prepare(
        `
        INSERT INTO settings (id, key, value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        'settings-1',
        'seeders.journal',
        rawValue,
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z',
      );
  }

  function loadJournal(): Record<string, { version: number; executedAt: string }> | null {
    const row = sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('seeders.journal') as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value);
  }

  it('does nothing when no seeders are registered', async () => {
    const service = createService([]);

    await service.onModuleInit();

    const row = sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('seeders.journal') as { value: string } | undefined;
    expect(row).toBeUndefined();
  });

  it('runs pending seeders and writes journal entries', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const service = createService([
      {
        name: 'seed-alpha',
        version: 1,
        run,
      },
    ]);

    await service.onModuleInit();

    expect(run).toHaveBeenCalledTimes(1);
    const journal = loadJournal();
    expect(journal).toEqual(
      expect.objectContaining({
        'seed-alpha': expect.objectContaining({
          version: 1,
          executedAt: expect.any(String),
        }),
      }),
    );
  });

  it('skips seeders that are already executed for the same version', async () => {
    upsertJournal(
      JSON.stringify({ 'seed-alpha': { version: 1, executedAt: '2024-01-01T00:00:00.000Z' } }),
    );

    const run = jest.fn().mockResolvedValue(undefined);
    const service = createService([
      {
        name: 'seed-alpha',
        version: 1,
        run,
      },
    ]);

    await service.onModuleInit();

    expect(run).not.toHaveBeenCalled();
    const journal = loadJournal();
    expect(journal?.['seed-alpha'].version).toBe(1);
    expect(journal?.['seed-alpha'].executedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('re-runs a seeder when the registered version changes', async () => {
    upsertJournal(
      JSON.stringify({ 'seed-alpha': { version: 1, executedAt: '2024-01-01T00:00:00.000Z' } }),
    );

    const run = jest.fn().mockResolvedValue(undefined);
    const service = createService([
      {
        name: 'seed-alpha',
        version: 2,
        run,
      },
    ]);

    await service.onModuleInit();

    expect(run).toHaveBeenCalledTimes(1);
    const journal = loadJournal();
    expect(journal?.['seed-alpha'].version).toBe(2);
  });

  it('continues after a failure and does not mark failed seeders as executed', async () => {
    const failingRun = jest.fn().mockRejectedValue(new Error('boom'));
    const successfulRun = jest.fn().mockResolvedValue(undefined);
    const service = createService([
      {
        name: 'seed-fail',
        version: 1,
        run: failingRun,
      },
      {
        name: 'seed-success',
        version: 1,
        run: successfulRun,
      },
    ]);

    await service.onModuleInit();

    expect(failingRun).toHaveBeenCalledTimes(1);
    expect(successfulRun).toHaveBeenCalledTimes(1);

    const journal = loadJournal();
    expect(journal).toEqual(
      expect.objectContaining({
        'seed-success': expect.objectContaining({ version: 1 }),
      }),
    );
    expect(journal?.['seed-fail']).toBeUndefined();
  });
});
