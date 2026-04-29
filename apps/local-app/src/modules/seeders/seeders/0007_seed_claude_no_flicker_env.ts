import type { DataSeeder, SeederContext } from '../services/data-seeder.service';

const SEEDER_NAME = '0007_seed_claude_no_flicker_env';
const SEEDER_VERSION = 1;

export async function runSeedClaudeNoFlickerEnv(ctx: SeederContext): Promise<void> {
  const { items } = await ctx.storage.listProviders();
  const claude = items.find((p) => p.name.toLowerCase() === 'claude');
  if (!claude) {
    ctx.logger.debug({ seederName: SEEDER_NAME }, 'No Claude provider; skipping');
    return;
  }
  const currentEnv = claude.env ?? {};
  if ('CLAUDE_CODE_NO_FLICKER' in currentEnv) {
    ctx.logger.debug(
      { seederName: SEEDER_NAME, providerId: claude.id },
      'NO_FLICKER already set; skipping',
    );
    return;
  }
  const updatedEnv = { ...currentEnv, CLAUDE_CODE_NO_FLICKER: '1' };
  await ctx.storage.updateProvider(claude.id, { env: updatedEnv });
  ctx.logger.info(
    { seederName: SEEDER_NAME, providerId: claude.id },
    'Backfilled NO_FLICKER on Claude provider',
  );
}

export const seedClaudeNoFlickerEnvSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedClaudeNoFlickerEnv,
};
