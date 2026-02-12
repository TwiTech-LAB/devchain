import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import type { DataSeeder, SeederContext } from '../services/data-seeder.service';

const SEEDER_NAME = '0002_seed_replace_permission_mode_plan';
const SEEDER_VERSION = 1;
const OLD_OPTION = '--permission-mode plan';
const NEW_OPTION = '--disallowed-tools EnterPlanMode';

interface ProfileProviderConfigRow {
  id: string;
  options: string;
}

export async function runSeedReplacePermissionModePlan(ctx: SeederContext): Promise<void> {
  const sqlite = getRawSqliteClient(ctx.db);
  const rows = sqlite
    .prepare('SELECT id, options FROM profile_provider_configs WHERE options IS NOT NULL')
    .all() as ProfileProviderConfigRow[];

  const scanned = rows.length;
  let matched = 0;
  let updated = 0;
  const now = new Date().toISOString();
  const updateStatement = sqlite.prepare(
    'UPDATE profile_provider_configs SET options = ?, updated_at = ? WHERE id = ?',
  );

  for (const row of rows) {
    if (!row.options.includes(OLD_OPTION)) {
      continue;
    }

    matched++;
    const nextOptions = row.options.replace(OLD_OPTION, NEW_OPTION);
    if (nextOptions === row.options) {
      continue;
    }

    updateStatement.run(nextOptions, now, row.id);
    updated++;
  }

  ctx.logger.info(
    {
      seederName: SEEDER_NAME,
      seederVersion: SEEDER_VERSION,
      scanned,
      matched,
      updated,
    },
    'Replace-permission-mode-plan seeder completed',
  );
}

export const seedReplacePermissionModePlanSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedReplacePermissionModePlan,
};
