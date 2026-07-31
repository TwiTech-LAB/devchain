// Backend integration: real SQLite is the cheapest reliable proof of this persisted contract.
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import type { SeederContext } from '../types/seeder.types';
import {
  runSeedPreserveProjectEgressDefaults,
  seedPreserveProjectEgressDefaultsSeeder,
} from './0014_seed_preserve_project_egress_defaults';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const ENABLED_PROJECTS_KEY = 'cloud.egress.enabledProjects';
const DEFAULT_ENABLED_KEY = 'cloud.egress.newProjectsDefaultEnabled';
const TS = '2026-07-31T00:00:00.000Z';

describe('0014_seed_preserve_project_egress_defaults', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sqlite.close();
  });

  function createContext(): SeederContext {
    return {
      storage: {} as SeederContext['storage'],
      watchersService: {} as SeederContext['watchersService'],
      providerEffortSeeding: {} as SeederContext['providerEffortSeeding'],
      db,
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
      } as unknown as SeederContext['logger'],
    };
  }

  function insertProject(name: string, createdAt = TS): string {
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, is_template, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(id, name, `/tmp/${id}`, createdAt, createdAt);
    return id;
  }

  function upsertRawSetting(key: string, value: string): void {
    sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), key, value, TS, TS);
  }

  function readRawSetting(key: string): string | undefined {
    return (
      sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  }

  function readSetting(key: string): unknown {
    const value = readRawSetting(key);
    return value === undefined ? undefined : JSON.parse(value);
  }

  it.each([
    ['a missing map', undefined],
    ['invalid JSON', '{not-json'],
  ])('baselines every live project when starting from %s', async (_case, initialValue) => {
    const firstProject = insertProject('first', '1999-01-01T00:00:00.000Z');
    const secondProject = insertProject('second', '2099-01-01T00:00:00.000Z');
    if (initialValue !== undefined) {
      upsertRawSetting(ENABLED_PROJECTS_KEY, initialValue);
    }

    await runSeedPreserveProjectEgressDefaults(createContext());

    expect(readSetting(ENABLED_PROJECTS_KEY)).toEqual({
      [firstProject]: false,
      [secondProject]: false,
    });
    expect(readSetting(DEFAULT_ENABLED_KEY)).toBe(true);
  });

  it('preserves valid booleans entry-by-entry and baselines missing or invalid live entries', async () => {
    const enabledProject = insertProject('enabled');
    const disabledProject = insertProject('disabled');
    const invalidProject = insertProject('invalid');
    const missingProject = insertProject('missing');
    const staleProjectId = randomUUID();
    upsertRawSetting(
      ENABLED_PROJECTS_KEY,
      JSON.stringify({
        [enabledProject]: true,
        [disabledProject]: false,
        [invalidProject]: 'true',
        [staleProjectId]: true,
        invalidStaleEntry: null,
      }),
    );

    await runSeedPreserveProjectEgressDefaults(createContext());

    expect(readSetting(ENABLED_PROJECTS_KEY)).toEqual({
      [enabledProject]: true,
      [disabledProject]: false,
      [staleProjectId]: true,
      [invalidProject]: false,
      [missingProject]: false,
    });
    expect(readSetting(DEFAULT_ENABLED_KEY)).toBe(true);
  });

  it('checks the durable marker first and leaves projects added afterward implicit', async () => {
    const existingProject = insertProject('existing');
    const ctx = createContext();
    const runImmediate = jest.spyOn(TransactionRunner.prototype, 'runImmediate');

    await runSeedPreserveProjectEgressDefaults(ctx);
    const projectAddedAfterMarker = insertProject('added-after-marker');
    await runSeedPreserveProjectEgressDefaults(ctx);

    expect(readSetting(ENABLED_PROJECTS_KEY)).toEqual({ [existingProject]: false });
    expect(readSetting(ENABLED_PROJECTS_KEY)).not.toHaveProperty(projectAddedAfterMarker);
    expect(readSetting(DEFAULT_ENABLED_KEY)).toBe(true);
    expect(ctx.logger.info).toHaveBeenCalledTimes(1);
    expect(ctx.logger.debug).toHaveBeenCalledTimes(1);
    expect(runImmediate).toHaveBeenCalledTimes(2);
  });

  it('writes an empty override map and the marker when there are no projects', async () => {
    await runSeedPreserveProjectEgressDefaults(createContext());

    expect(readSetting(ENABLED_PROJECTS_KEY)).toEqual({});
    expect(readSetting(DEFAULT_ENABLED_KEY)).toBe(true);
  });

  it('rolls back the override map when writing the marker fails', async () => {
    const preservedProject = insertProject('preserved');
    insertProject('needs-baseline');
    const originalMap = JSON.stringify({ [preservedProject]: true });
    upsertRawSetting(ENABLED_PROJECTS_KEY, originalMap);
    sqlite.exec(`
      CREATE TRIGGER fail_default_marker_insert
      BEFORE INSERT ON settings
      WHEN NEW.key = '${DEFAULT_ENABLED_KEY}'
      BEGIN
        SELECT RAISE(ABORT, 'marker write failed');
      END;
    `);

    await expect(runSeedPreserveProjectEgressDefaults(createContext())).rejects.toThrow(
      'marker write failed',
    );

    expect(readRawSetting(ENABLED_PROJECTS_KEY)).toBe(originalMap);
    expect(readRawSetting(DEFAULT_ENABLED_KEY)).toBeUndefined();
  });

  it('has the permanent version-1 journal identity', () => {
    expect(seedPreserveProjectEgressDefaultsSeeder).toMatchObject({
      name: '0014_seed_preserve_project_egress_defaults',
      version: 1,
    });
  });
});
