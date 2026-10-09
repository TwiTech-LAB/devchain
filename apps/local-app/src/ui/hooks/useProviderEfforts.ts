import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  providerEffortQueries,
  selectProviderEffortOptions,
  type ProviderEffortOption,
} from '@/ui/lib/provider-efforts';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { sameCatalogName } from '@/ui/hooks/useProviderModels';

export interface UseProviderEffortsOptions {
  providerId: string | null;
  /** Current effort-override selection (`null` = Default). */
  effortOverride: string | null;
  /** Invoked with `null` when the selection is absent from the loaded catalog. */
  onStaleSelection: (next: string | null) => void;
}

export interface UseProviderEffortsResult {
  efforts: ProviderEffortOption[];
  supportsEffort: boolean;
  requiresModelForEffort: boolean;
}

/**
 * Fetches a provider's effort catalog + capability flags (5-min staleTime,
 * enabled only with a providerId) and clears a stale effort-override selection
 * when the resolved catalog no longer contains it. The three gating states
 * consumed by UIs derive from the returned flags + catalog size + an external
 * "resolvable model" check (kept at the call site because it depends on form
 * state): hidden when `!supportsEffort`; disabled "No effort levels configured"
 * when supported-but-empty; disabled "Select a model first" when
 * `requiresModelForEffort` and no model is resolvable.
 */
export function useProviderEfforts(options: UseProviderEffortsOptions): UseProviderEffortsResult {
  const fetchFn = useFetchFactory();
  const { providerId, effortOverride, onStaleSelection } = options;

  const { data: catalog } = useQuery({
    ...providerEffortQueries.catalog(fetchFn, providerId),
    select: selectProviderEffortOptions,
    enabled: !!providerId,
    staleTime: 5 * 60 * 1000,
  });

  const supportsEffort = catalog?.supportsEffort ?? false;
  const requiresModelForEffort = catalog?.requiresModelForEffort ?? false;
  const efforts = catalog?.efforts ?? [];

  // Clear a stale effort-override once the catalog no longer lists it. Only
  // active when effort is supported; a non-capable provider never carries a
  // meaningful catalog and the UI hides the control entirely.
  useEffect(() => {
    if (!supportsEffort || !effortOverride) return;
    if (!efforts.some((effort) => sameCatalogName(effort.name, effortOverride))) {
      onStaleSelection(null);
    }
  }, [supportsEffort, efforts, effortOverride, onStaleSelection]);

  return { efforts, supportsEffort, requiresModelForEffort };
}
