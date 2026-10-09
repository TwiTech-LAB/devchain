import { queryOptions } from '@tanstack/react-query';
import type { ProfileListItem, ProfilesResponse } from '@/modules/profiles/dto';
import type { FetchFn } from './api-transport';
import { fetchJsonOrThrow } from './sessions';

export type { ProfileListItem, ProfilesResponse };

export const profileQueryKeys = {
  project: (projectId: string | null | undefined) => ['profiles', projectId] as const,
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
};
