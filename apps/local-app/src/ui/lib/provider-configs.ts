import { queryOptions, type Query } from '@tanstack/react-query';
import type { ProfileProviderConfig } from '@/modules/storage/models/domain.models';
import type { FetchFn } from './api-transport';
import { fetchJsonOrThrow } from './sessions';

export type { ProfileProviderConfig };

function sortedProfileIds(profileIds: readonly (string | null | undefined)[]): string[] {
  return [...new Set(profileIds.filter((id): id is string => id != null))].sort();
}

export const providerConfigQueryKeys = {
  profile: (profileId: string | null) => ['provider-configs', profileId] as const,
  byProfiles: (projectId: string | null, profileIds: readonly (string | null | undefined)[]) =>
    ['provider-configs-by-profile', projectId, sortedProfileIds(profileIds)] as const,
};

export function fetchProviderConfigs(
  fetchFn: FetchFn,
  profileId: string,
): Promise<ProfileProviderConfig[]> {
  return fetchJsonOrThrow(
    `/api/profiles/${encodeURIComponent(profileId)}/provider-configs`,
    {},
    'Failed to fetch provider configs',
    fetchFn,
  );
}

export async function fetchProviderConfigsByProfiles(
  fetchFn: FetchFn,
  profileIds: readonly (string | null | undefined)[],
): Promise<Map<string, ProfileProviderConfig[]>> {
  const entries = await Promise.all(
    sortedProfileIds(profileIds).map(async (profileId) => {
      try {
        return [profileId, await fetchProviderConfigs(fetchFn, profileId)] as const;
      } catch {
        return [profileId, [] as ProfileProviderConfig[]] as const;
      }
    }),
  );
  return new Map(entries);
}

export const providerConfigQueries = {
  profile: (fetchFn: FetchFn, profileId: string | null) =>
    queryOptions({
      queryKey: providerConfigQueryKeys.profile(profileId),
      queryFn: () => fetchProviderConfigs(fetchFn, profileId!),
    }),
  byProfiles: (
    fetchFn: FetchFn,
    projectId: string | null,
    profileIds: readonly (string | null | undefined)[],
  ) => {
    const queryKey = providerConfigQueryKeys.byProfiles(projectId, profileIds);
    return queryOptions({
      queryKey,
      queryFn: () => fetchProviderConfigsByProfiles(fetchFn, queryKey[2]),
    });
  },
};

export const providerConfigQueryPredicates = {
  all: (query: Pick<Query, 'queryKey'>): boolean =>
    query.queryKey[0] === 'provider-configs' || query.queryKey[0] === 'provider-configs-by-profile',
  aggregatesForProfile:
    (profileId: string) =>
    (query: Pick<Query, 'queryKey'>): boolean => {
      const [root, , profileIds] = query.queryKey;
      return (
        root === 'provider-configs-by-profile' &&
        Array.isArray(profileIds) &&
        profileIds.includes(profileId)
      );
    },
};
