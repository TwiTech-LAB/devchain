import { randomUUID } from 'crypto';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import type { DataSeeder, SeederContext } from '../services/data-seeder.service';

const SEEDER_NAME = '0004_seed_disable_microsoft_source_default';
const SEEDER_VERSION = 1;
const SETTINGS_KEY = 'skills.sources';

const DEFAULT_SOURCE_SETTINGS: Record<string, boolean> = {
  microsoft: false,
};

export async function runSeedDisableMicrosoftSourceDefault(ctx: SeederContext): Promise<void> {
  const sqlite = getRawSqliteClient(ctx.db);
  const existing = sqlite.prepare('SELECT key FROM settings WHERE key = ?').get(SETTINGS_KEY) as
    | { key: string }
    | undefined;

  if (existing) {
    ctx.logger.info(
      {
        seederName: SEEDER_NAME,
        seederVersion: SEEDER_VERSION,
        created: 0,
        skipped: 1,
        reason: 'skills.sources already exists',
      },
      'Disable-microsoft-default source seeder completed',
    );
    return;
  }

  const now = new Date().toISOString();
  sqlite
    .prepare(
      `
        INSERT INTO settings (id, key, value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO NOTHING
      `,
    )
    .run(randomUUID(), SETTINGS_KEY, JSON.stringify(DEFAULT_SOURCE_SETTINGS), now, now);

  ctx.logger.info(
    {
      seederName: SEEDER_NAME,
      seederVersion: SEEDER_VERSION,
      created: 1,
      skipped: 0,
      key: SETTINGS_KEY,
      value: DEFAULT_SOURCE_SETTINGS,
    },
    'Disable-microsoft-default source seeder completed',
  );
}

export const seedDisableMicrosoftSourceDefaultSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedDisableMicrosoftSourceDefault,
};
