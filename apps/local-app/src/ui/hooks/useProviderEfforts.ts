import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { providerEffortQueryKeys } from '@/ui/lib/provider-effort-query-keys';

export interface ProviderEffortOption {
  id: string;
  name: string;
}

export interface ProviderEffortsCatalog {
  efforts: ProviderEffortOption[];
  supportsEffort: boolean;
  requiresModelForEffort: boolean;
}

function parseProviderEffortName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name || null;
}

/**
 * Tolerant parser for `GET /api/providers/:id/efforts` →
 * `{ efforts, supportsEffort, requiresModelForEffort }`. Effort entries are
 * either strings or `{ name }` objects; ids are synthesized as
 * `providerId:name:index`. Behavior must stay byte-identical to the inline
 * parser this replaced (AgentFormDialog).
 */
export function parseProviderEfforts(payload: unknown, providerId: string): ProviderEffortsCatalog {
  const empty: ProviderEffortsCatalog = {
    efforts: [],
    supportsEffort: false,
    requiresModelForEffort: false,
  };

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return empty;
  }

  const obj = payload as {
    efforts?: unknown;
    supportsEffort?: unknown;
    requiresModelForEffort?: unknown;
  };

  const efforts = Array.isArray(obj.efforts)
    ? obj.efforts
        .map((rawEffort, index) => {
          const name =
            typeof rawEffort === 'string'
              ? parseProviderEffortName(rawEffort)
              : parseProviderEffortName((rawEffort as { name?: unknown })?.name);
          if (!name) return null;
          return { id: `${providerId}:${name}:${index}`, name };
        })
        .filter((effort): effort is ProviderEffortOption => Boolean(effort))
    : [];

  return {
    efforts,
    supportsEffort: obj.supportsEffort === true,
    requiresModelForEffort: obj.requiresModelForEffort === true,
  };
}

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
  const { providerId, effortOverride, onStaleSelection } = options;

  const { data: catalog } = useQuery({
    queryKey: providerEffortQueryKeys.main(providerId ?? 'none'),
    queryFn: async (): Promise<ProviderEffortsCatalog> => {
      if (!providerId) {
        return { efforts: [], supportsEffort: false, requiresModelForEffort: false };
      }
      const res = await fetch(`/api/providers/${providerId}/efforts`);
      if (!res.ok) {
        return { efforts: [], supportsEffort: false, requiresModelForEffort: false };
      }
      const payload = (await res.json().catch(() => null)) as unknown;
      return parseProviderEfforts(payload, providerId);
    },
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
    if (!efforts.some((effort) => effort.name === effortOverride)) {
      onStaleSelection(null);
    }
  }, [supportsEffort, efforts, effortOverride, onStaleSelection]);

  return { efforts, supportsEffort, requiresModelForEffort };
}
