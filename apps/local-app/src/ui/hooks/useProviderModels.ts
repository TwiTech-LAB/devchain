import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { providerModelQueryKeys } from '@/ui/lib/provider-model-query-keys';

/**
 * Provider model catalog option. `id` is a stable composite when the API omits
 * one; `name` is the provider-native model identifier used verbatim in overrides.
 */
export interface ProviderModelOption {
  id: string;
  name: string;
}

/**
 * Tolerant parser for `GET /api/providers/:id/models`. Rejects non-array
 * payloads and entries without a usable `name`; synthesizes a stable id from
 * `providerId:name:index` when the entry lacks one. Behavior must stay
 * byte-identical to the inline parser this replaced (AgentFormDialog).
 */
export function parseProviderModels(payload: unknown, providerId: string): ProviderModelOption[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((rawModel, index) => {
      if (
        !rawModel ||
        typeof rawModel !== 'object' ||
        Array.isArray(rawModel) ||
        typeof (rawModel as { name?: unknown }).name !== 'string'
      ) {
        return null;
      }

      const model = rawModel as { id?: unknown; name: string };
      const name = model.name.trim();
      if (!name) {
        return null;
      }

      const id =
        typeof model.id === 'string' && model.id.trim().length > 0
          ? model.id
          : `${providerId}:${name}:${index}`;
      return { id, name };
    })
    .filter((model): model is ProviderModelOption => Boolean(model));
}

export interface UseProviderModelsOptions {
  providerId: string | null;
  /** Current model-override selection (`null` = Default). */
  modelOverride: string | null;
  /** Invoked with `null` when the selection is absent from the loaded catalog. */
  onStaleSelection: (next: string | null) => void;
}

export interface UseProviderModelsResult {
  models: ProviderModelOption[];
  isLoading: boolean;
}

/**
 * Fetches a provider's model catalog (5-min staleTime, enabled only with a
 * providerId) and clears a stale model-override selection when the resolved
 * catalog no longer contains it. The selection state itself is owned by the
 * caller (it lives in form state); this hook only reports staleness via
 * `onStaleSelection` so the caller can reset its field.
 */
export function useProviderModels(options: UseProviderModelsOptions): UseProviderModelsResult {
  const { providerId, modelOverride, onStaleSelection } = options;

  const { data: models = [], isLoading } = useQuery({
    queryKey: providerModelQueryKeys.main(providerId ?? 'none'),
    queryFn: async () => {
      if (!providerId) return [] as ProviderModelOption[];
      const res = await fetch(`/api/providers/${providerId}/models`);
      if (!res.ok) return [] as ProviderModelOption[];
      const payload = (await res.json().catch(() => [])) as unknown;
      return parseProviderModels(payload, providerId);
    },
    enabled: !!providerId,
    staleTime: 5 * 60 * 1000,
  });

  // Clear a stale model-override once the catalog it was picked from is gone or
  // no longer lists it. Skipped while loading so a half-arrived catalog can't
  // wipe a still-valid selection.
  useEffect(() => {
    if (!providerId || isLoading || !modelOverride) return;
    if (!models.some((model) => model.name === modelOverride)) {
      onStaleSelection(null);
    }
  }, [providerId, models, isLoading, modelOverride, onStaleSelection]);

  return { models, isLoading };
}
