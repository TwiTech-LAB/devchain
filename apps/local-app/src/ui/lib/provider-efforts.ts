import { queryOptions } from '@tanstack/react-query';
import type { ProviderEffortsResponse } from '@/modules/providers/controllers/provider-efforts.controller';
import type { ProviderEffort } from '@/modules/storage/models/domain.models';
import { extractModelFromProfileOptions } from '@/modules/providers/utils/profile-options';
import type { BackendId, FetchFn } from './api-transport';
import { fetchJsonOrThrow } from './http-json';

export type { ProviderEffort, ProviderEffortsResponse };
export type ProviderEffortOption = Pick<ProviderEffort, 'id' | 'name'>;
export type ProviderEffortOptionsCatalog = Omit<ProviderEffortsResponse, 'efforts'> & {
  efforts: ProviderEffortOption[];
};
export type ProviderEffortNamesCatalog = Omit<ProviderEffortsResponse, 'efforts'> & {
  efforts: string[];
};

export const providerEffortQueryKeys = {
  all: ['provider-efforts'] as const,
  /** Provider ids are per instance, so the backend that answers is part of the key. */
  catalog: (providerId: string | null, backend: BackendId) =>
    ['provider-efforts', providerId, backend] as const,
};

export function fetchProviderEfforts(
  fetchFn: FetchFn,
  providerId: string,
): Promise<ProviderEffortsResponse> {
  return fetchJsonOrThrow(
    `/api/providers/${encodeURIComponent(providerId)}/efforts`,
    {},
    'Failed to fetch provider efforts',
    fetchFn,
  );
}

export const providerEffortQueries = {
  /** `backend` must be the backend that `fetchFn` sends the request to. */
  catalog: (fetchFn: FetchFn, providerId: string | null, backend: BackendId) =>
    queryOptions({
      queryKey: providerEffortQueryKeys.catalog(providerId, backend),
      queryFn: () => fetchProviderEfforts(fetchFn, providerId!),
    }),
};

export function selectProviderEffortOptions(
  catalog: ProviderEffortsResponse,
): ProviderEffortOptionsCatalog {
  return {
    ...catalog,
    efforts: catalog.efforts.flatMap((effort, index) => {
      const name = effort.name.trim();
      return name ? [{ id: `${effort.providerId}:${name}:${index}`, name }] : [];
    }),
  };
}

export function selectProviderEffortNames(
  catalog: ProviderEffortsResponse,
): ProviderEffortNamesCatalog {
  return {
    ...catalog,
    efforts: catalog.efforts.map((effort) => effort.name.trim()).filter(Boolean),
  };
}

/** The fields of a provider config that can give a launch its model. */
export interface LaunchModelSource {
  model?: string | null;
  options?: string | null;
}

/**
 * The model a launch uses: the agent's model override, else the config's model, else the
 * `--model` of the config's raw options. The same order as the launch
 * (provider-runtime-preparation.service.ts). A provider with `requiresModelForEffort` fails the
 * launch when an effort applies and this is null.
 */
export function launchModelOf(
  modelOverride: string | null | undefined,
  config: LaunchModelSource | undefined,
): string | null {
  return (
    modelOverride ||
    config?.model ||
    extractModelFromProfileOptions(config?.options ?? null) ||
    null
  );
}
