import type { DataSeeder, SeederContext } from '../types/seeder.types';

const SEEDER_NAME = '0010_seed_provider_effort_defaults';
const SEEDER_VERSION = 1;

/**
 * One-time backfill of provider effort catalogs for providers that existed
 * before the effort-levels feature. Delegates to the SAME shared seeding service
 * the provider-creation hook uses (`ProviderEffortSeedingService`), so defaults
 * can never diverge between creation-time and backfill.
 *
 * Idempotent + additive-only: `bulkCreateProviderEfforts` skips values already
 * present and never deletes user-edited rows, and this seeder is recorded in the
 * journal so it runs exactly once (not every boot). Non-effort-capable providers
 * (agy) and unsupported names seed nothing.
 */
export async function runSeedProviderEffortDefaults(ctx: SeederContext): Promise<void> {
  const result = await ctx.providerEffortSeeding.backfillAll();

  ctx.logger.info(
    {
      seederName: SEEDER_NAME,
      seederVersion: SEEDER_VERSION,
      providersScanned: result.providers,
      providersSeeded: result.seededProviders,
    },
    'Backfilled provider effort defaults',
  );
}

export const seedProviderEffortDefaultsSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedProviderEffortDefaults,
};
