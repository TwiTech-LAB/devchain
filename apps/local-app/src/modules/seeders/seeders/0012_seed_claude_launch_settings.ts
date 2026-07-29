import { and, eq, isNull, sql } from 'drizzle-orm';
import { DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON } from '@devchain/shared';
import { providers } from '../../storage/db/schema';
import type { DataSeeder, SeederContext } from '../types/seeder.types';

const SEEDER_NAME = '0012_seed_claude_launch_settings';
const SEEDER_VERSION = 1;

export async function runSeedClaudeLaunchSettings(ctx: SeederContext): Promise<void> {
  const result = ctx.db
    .update(providers)
    .set({ claudeLaunchSettingsJson: DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON })
    .where(
      and(eq(sql`lower(${providers.name})`, 'claude'), isNull(providers.claudeLaunchSettingsJson)),
    )
    .run();

  if (result.changes > 0) {
    ctx.logger.info(
      { seederName: SEEDER_NAME, updatedProviders: result.changes },
      'Seeded default Claude launch settings',
    );
  } else {
    ctx.logger.debug({ seederName: SEEDER_NAME }, 'No Claude launch settings to seed; skipping');
  }
}

export const seedClaudeLaunchSettingsSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedClaudeLaunchSettings,
};
