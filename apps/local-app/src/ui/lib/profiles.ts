import { queryOptions } from '@tanstack/react-query';
import type { ProfileListItem, ProfilesResponse } from '@/modules/profiles/dto';
import type { FetchFn } from './api-transport';
import { fetchJsonOrThrow } from './http-json';

export type { ProfileListItem, ProfilesResponse };

export const profileQueryKeys = {
  project: (projectId: string | null | undefined) => ['profiles', projectId] as const,
  detail: (profileId: string) => ['profiles', 'detail', profileId] as const,
};

export function fetchProfiles(fetchFn: FetchFn, projectId: string): Promise<ProfilesResponse> {
  return fetchJsonOrThrow(
    `/api/profiles?projectId=${encodeURIComponent(projectId)}`,
    {},
    'Failed to fetch profiles',
    fetchFn,
  );
}

export const profileQueries = {
  list: (fetchFn: FetchFn, projectId: string | null | undefined) =>
    queryOptions({
      queryKey: profileQueryKeys.project(projectId),
      queryFn: () => fetchProfiles(fetchFn, projectId!),
    }),
  detail: (fetchFn: FetchFn, profileId: string) =>
    queryOptions({
      queryKey: profileQueryKeys.detail(profileId),
      queryFn: () =>
        fetchJsonOrThrow<Pick<ProfileListItem, 'id' | 'name'>>(
          `/api/profiles/${encodeURIComponent(profileId)}`,
          {},
          'Failed to fetch profile',
          fetchFn,
        ),
    }),
};
