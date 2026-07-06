import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { ProviderAdapterFactory, isEffortCapable } from '../adapters';

const logger = createLogger('ProviderEffortSeeding');

export interface EffortSeedResult {
  added: string[];
  existing: string[];
}

/**
 * Single shared entry point for seeding provider effort catalogs from adapter
 * defaults. Both call sites — the provider-CREATION hook (manual add / rescan /
 * sync) and the ONE-TIME startup backfill seeder — funnel through here so the
 * defaults can never diverge.
 *
 * The defaults are read from the adapter's `defaultEffortValues` (Task 2
 * capability metadata — the single source of truth; no literals are duplicated
 * here). Seeding is always idempotent + additive-only via
 * `bulkCreateProviderEfforts` (skip existing, never overwrite or delete
 * user-edited rows). Providers whose adapter is not effort-capable (agy) or is
 * unsupported seed nothing.
 */
@Injectable()
export class ProviderEffortSeedingService {
  constructor(
    private readonly adapterFactory: ProviderAdapterFactory,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  /**
   * Seed one provider's effort catalog from its adapter defaults. Idempotent:
   * existing values are skipped, nothing is deleted. No-op for unsupported names
   * and non-effort-capable adapters (returns empty added/existing).
   */
  async seedForProvider(provider: { id: string; name: string }): Promise<EffortSeedResult> {
    const empty: EffortSeedResult = { added: [], existing: [] };

    if (!this.adapterFactory.isSupported(provider.name)) {
      return empty;
    }
    const adapter = this.adapterFactory.getAdapter(provider.name);
    if (!isEffortCapable(adapter)) {
      return empty;
    }
    const defaults = adapter.defaultEffortValues;
    if (defaults.length === 0) {
      return empty;
    }

    return this.storage.bulkCreateProviderEfforts(provider.id, [...defaults]);
  }

  /**
   * Backfill effort catalogs for EVERY existing provider (startup seeder path).
   * Each provider funnels through `seedForProvider`, so the defaults match the
   * creation hook exactly. Per-provider failures are isolated so one bad row
   * never aborts the whole backfill.
   */
  async backfillAll(): Promise<{ providers: number; seededProviders: number }> {
    // Providers are one-row-per-installed-CLI; a high ceiling defensively covers
    // every row without pagination.
    const { items } = await this.storage.listProviders({ limit: 10_000 });
    let seededProviders = 0;

    for (const provider of items) {
      try {
        const { added } = await this.seedForProvider(provider);
        if (added.length > 0) {
          seededProviders += 1;
        }
      } catch (error) {
        logger.warn(
          { error, providerId: provider.id, providerName: provider.name },
          'Failed to seed effort defaults for provider during backfill; continuing',
        );
      }
    }

    return { providers: items.length, seededProviders };
  }
}
