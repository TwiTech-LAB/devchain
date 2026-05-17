import type { DataSeeder, SeederContext } from '../types/seeder.types';

const SEEDER_NAME = '0008_seed_remove_claude_no_flicker_env';
const SEEDER_VERSION = 1;
const NO_FLICKER_ENV_KEY = 'CLAUDE_CODE_NO_FLICKER';

export async function runSeedRemoveClaudeNoFlickerEnv(ctx: SeederContext): Promise<void> {
  const { items } = await ctx.storage.listProviders();
  const claude = items.find((p) => p.name.toLowerCase() === 'claude');
  if (!claude) {
    ctx.logger.debug({ seederName: SEEDER_NAME }, 'No Claude provider; skipping');
    return;
  }

  const currentEnv = claude.env ?? {};
  if (!(NO_FLICKER_ENV_KEY in currentEnv)) {
    ctx.logger.debug(
      { seederName: SEEDER_NAME, providerId: claude.id },
      'NO_FLICKER not set; skipping',
    );
    return;
  }

  const { [NO_FLICKER_ENV_KEY]: _removed, ...remainingEnv } = currentEnv;
  const updatedEnv = Object.keys(remainingEnv).length > 0 ? remainingEnv : null;

  await ctx.storage.updateProvider(claude.id, { env: updatedEnv });
  ctx.logger.info(
    { seederName: SEEDER_NAME, providerId: claude.id },
    'Removed NO_FLICKER from Claude provider',
  );
}

export const seedRemoveClaudeNoFlickerEnvSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedRemoveClaudeNoFlickerEnv,
};
