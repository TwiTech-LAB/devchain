import type { DataSeeder, SeederContext } from '../types/seeder.types';

const SEEDER_NAME = '0011_seed_remove_claude_1m_provider_env';
const SEEDER_VERSION = 1;
const AUTO_COMPACT_WINDOW_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const RETIRED_WINDOW_VALUE = '1000000';

export async function runSeedRemoveClaude1mProviderEnv(ctx: SeederContext): Promise<void> {
  const { items } = await ctx.storage.listProviders({ limit: 10_000 });
  const matches = items.filter(
    (provider) =>
      provider.name.toLowerCase() === 'claude' &&
      provider.env?.[AUTO_COMPACT_WINDOW_KEY] === RETIRED_WINDOW_VALUE,
  );

  for (const provider of matches) {
    const currentEnv = provider.env ?? {};
    const { [AUTO_COMPACT_WINDOW_KEY]: _removedEnv, ...remainingEnv } = currentEnv;
    const currentScopes =
      ctx.storage.listEnvScopesByProviderIds([provider.id]).get(provider.id) ?? {};
    const { [AUTO_COMPACT_WINDOW_KEY]: _removedScopes, ...remainingScopes } = currentScopes;
    const env = Object.keys(remainingEnv).length > 0 ? remainingEnv : null;

    await ctx.storage.updateProviderWithScopes(
      provider.id,
      { env },
      remainingScopes,
      Object.keys(remainingEnv),
    );

    ctx.logger.info(
      { seederName: SEEDER_NAME, providerId: provider.id },
      'Removed retired Claude provider auto-compact window',
    );
  }

  if (matches.length === 0) {
    ctx.logger.debug({ seederName: SEEDER_NAME }, 'No retired Claude provider window; skipping');
  }
}

export const seedRemoveClaude1mProviderEnvSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedRemoveClaude1mProviderEnv,
};
