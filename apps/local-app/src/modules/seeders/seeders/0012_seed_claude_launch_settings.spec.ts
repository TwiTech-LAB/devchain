import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON } from '@devchain/shared';
import type { SeederContext } from '../types/seeder.types';
import {
  runSeedClaudeLaunchSettings,
  seedClaudeLaunchSettingsSeeder,
} from './0012_seed_claude_launch_settings';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const TS = '2026-07-27T00:00:00.000Z';

describe('0012_seed_claude_launch_settings', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  });

  afterEach(() => {
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

  function insertProvider(name: string, claudeLaunchSettingsJson: string | null): string {
    const id = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO providers
         (id, name, mcp_configured, claude_launch_settings_json, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?)`,
      )
      .run(id, name, claudeLaunchSettingsJson, TS, TS);
    return id;
  }

  function readSettings(providerId: string): string | null {
    return (
      sqlite
        .prepare('SELECT claude_launch_settings_json FROM providers WHERE id = ?')
        .get(providerId) as { claude_launch_settings_json: string | null }
    ).claude_launch_settings_json;
  }

  it('backfills only null Claude rows and preserves all other rows verbatim', async () => {
    const claudeNull = insertProvider('Claude', null);
    const custom = '{"futureSetting":true}';
    const claudeCustom = insertProvider('claude', custom);
    const codexNull = insertProvider('codex', null);

    await runSeedClaudeLaunchSettings(createContext());

    expect(readSettings(claudeNull)).toBe(DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON);
    expect(readSettings(claudeCustom)).toBe(custom);
    expect(readSettings(codexNull)).toBeNull();
  });

  it('is idempotent at the data layer', async () => {
    const claude = insertProvider('claude', null);
    const ctx = createContext();

    await runSeedClaudeLaunchSettings(ctx);
    await runSeedClaudeLaunchSettings(ctx);

    expect(readSettings(claude)).toBe(DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON);
    expect(ctx.logger.info).toHaveBeenCalledTimes(1);
  });

  it('is permanently journaled at version 1', () => {
    expect(seedClaudeLaunchSettingsSeeder).toMatchObject({
      name: '0012_seed_claude_launch_settings',
      version: 1,
    });
  });
});
