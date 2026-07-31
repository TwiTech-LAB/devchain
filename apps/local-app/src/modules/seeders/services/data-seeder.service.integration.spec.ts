// Backend integration: real SQLite is the cheapest reliable proof of this persisted contract.
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DataSeederService, type DataSeeder } from './data-seeder.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { WatchersService } from '../../watchers/services/watchers.service';
import type { ProviderEffortSeedingService } from '../../providers/services/provider-effort-seeding.service';
import { seedPreserveProjectEgressDefaultsSeeder } from '../seeders/0014_seed_preserve_project_egress_defaults';

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
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
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
    return new DataSeederService(
      {} as StorageService,
      {} as WatchersService,
      {} as ProviderEffortSeedingService,
      db,
      seeders,
    );
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

  function insertProject(id: string): void {
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, root_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, id, `/tmp/${id}`, '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z');
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

  it('retries safely when seeder data commits before the journal write fails', async () => {
    insertProject('existing-project');
    sqlite.exec(`
      CREATE TRIGGER fail_seeder_journal_insert
      BEFORE INSERT ON settings
      WHEN NEW.key = 'seeders.journal'
      BEGIN
        SELECT RAISE(ABORT, 'journal write failed');
      END;
    `);

    await createService([seedPreserveProjectEgressDefaultsSeeder]).onModuleInit();

    expect(loadJournal()).toBeNull();
    expect(
      JSON.parse(
        (
          sqlite
            .prepare("SELECT value FROM settings WHERE key = 'cloud.egress.enabledProjects'")
            .get() as { value: string }
        ).value,
      ),
    ).toEqual({ 'existing-project': false });
    expect(
      JSON.parse(
        (
          sqlite
            .prepare(
              "SELECT value FROM settings WHERE key = 'cloud.egress.newProjectsDefaultEnabled'",
            )
            .get() as { value: string }
        ).value,
      ),
    ).toBe(true);

    insertProject('project-created-between-attempts');
    sqlite.exec('DROP TRIGGER fail_seeder_journal_insert');
    await createService([seedPreserveProjectEgressDefaultsSeeder]).onModuleInit();

    expect(loadJournal()).toEqual({
      '0014_seed_preserve_project_egress_defaults': {
        version: 1,
        executedAt: expect.any(String),
      },
    });
    expect(
      JSON.parse(
        (
          sqlite
            .prepare("SELECT value FROM settings WHERE key = 'cloud.egress.enabledProjects'")
            .get() as { value: string }
        ).value,
      ),
    ).toEqual({ 'existing-project': false });
  });
});
