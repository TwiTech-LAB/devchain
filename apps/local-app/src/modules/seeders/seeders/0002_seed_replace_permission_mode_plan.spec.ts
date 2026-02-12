import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { WatchersService } from '../../watchers/services/watchers.service';
import type { SeederContext } from '../services/data-seeder.service';
import {
  runSeedReplacePermissionModePlan,
  seedReplacePermissionModePlanSeeder,
} from './0002_seed_replace_permission_mode_plan';

describe('0002_seed_replace_permission_mode_plan', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE profile_provider_configs (
        id TEXT PRIMARY KEY,
        options TEXT,
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

  function insertConfig(id: string, options: string | null): void {
    sqlite
      .prepare(
        `INSERT INTO profile_provider_configs (id, options, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(id, options, '2024-01-01T00:00:00.000Z');
  }

  function getOptions(id: string): string | null {
    const row = sqlite
      .prepare('SELECT options FROM profile_provider_configs WHERE id = ?')
      .get(id) as { options: string | null } | undefined;
    return row?.options ?? null;
  }

  it('updates configs with --permission-mode plan, skips non-matching and null options, and logs counts', async () => {
    insertConfig(
      'cfg-1',
      '--model claude-opus-4-6 --dangerously-skip-permissions --permission-mode plan',
    );
    insertConfig('cfg-2', '--model claude-sonnet-4-5 --dangerously-skip-permissions');
    insertConfig('cfg-3', null);
    const info = jest.fn();

    await runSeedReplacePermissionModePlan(createContext(info));

    expect(getOptions('cfg-1')).toBe(
      '--model claude-opus-4-6 --dangerously-skip-permissions --disallowed-tools EnterPlanMode',
    );
    expect(getOptions('cfg-2')).toBe('--model claude-sonnet-4-5 --dangerously-skip-permissions');
    expect(getOptions('cfg-3')).toBeNull();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        seederName: '0002_seed_replace_permission_mode_plan',
        seederVersion: 1,
        scanned: 2,
        matched: 1,
        updated: 1,
      }),
      'Replace-permission-mode-plan seeder completed',
    );
  });

  it('is idempotent when re-run', async () => {
    insertConfig('cfg-1', '--permission-mode plan');
    const info = jest.fn();

    await runSeedReplacePermissionModePlan(createContext(info));
    await runSeedReplacePermissionModePlan(createContext(info));

    expect(getOptions('cfg-1')).toBe('--disallowed-tools EnterPlanMode');
    expect(info).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        scanned: 1,
        matched: 0,
        updated: 0,
      }),
      'Replace-permission-mode-plan seeder completed',
    );
  });

  it('exports seeder metadata and run function', () => {
    expect(seedReplacePermissionModePlanSeeder).toMatchObject({
      name: '0002_seed_replace_permission_mode_plan',
      version: 1,
      run: runSeedReplacePermissionModePlan,
    });
  });
});
