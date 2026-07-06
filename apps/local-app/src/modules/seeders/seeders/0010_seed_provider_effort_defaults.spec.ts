import {
  runSeedProviderEffortDefaults,
  seedProviderEffortDefaultsSeeder,
} from './0010_seed_provider_effort_defaults';
import type { SeederContext } from '../types/seeder.types';

describe('0010_seed_provider_effort_defaults', () => {
  it('declares the expected recorded name and version (one-shot journal key)', () => {
    expect(seedProviderEffortDefaultsSeeder.name).toBe('0010_seed_provider_effort_defaults');
    expect(seedProviderEffortDefaultsSeeder.version).toBe(1);
  });

  it('delegates the backfill to the shared ProviderEffortSeedingService', async () => {
    const backfillAll = jest.fn().mockResolvedValue({ providers: 3, seededProviders: 2 });
    const info = jest.fn();
    const ctx = {
      providerEffortSeeding: { backfillAll },
      logger: { info, warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
    } as unknown as SeederContext;

    await runSeedProviderEffortDefaults(ctx);

    expect(backfillAll).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ providersScanned: 3, providersSeeded: 2 }),
      expect.any(String),
    );
  });
});
