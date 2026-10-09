import { queryOptions } from '@tanstack/react-query';
import type { ProviderEffortsResponse } from '@/modules/providers/controllers/provider-efforts.controller';
import type { ProviderEffort } from '@/modules/storage/models/domain.models';
import type { FetchFn } from './api-transport';
import { fetchJsonOrThrow } from './sessions';

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
  catalog: (providerId: string | null) => ['provider-efforts', providerId] as const,
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
  catalog: (fetchFn: FetchFn, providerId: string | null) =>
    queryOptions({
      queryKey: providerEffortQueryKeys.catalog(providerId),
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
