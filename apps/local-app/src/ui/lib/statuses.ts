import { queryOptions } from '@tanstack/react-query';
import type { Status } from '@/modules/storage/models/domain.models';
import type { ListResult } from '@/modules/storage/interfaces/storage.interface';
import type { FetchFn } from './api-transport';
import { fetchJsonOrThrow } from './sessions';

export type { Status };

export const statusQueryKeys = {
  project: (projectId: string | null | undefined) => ['statuses', projectId] as const,
};

export function fetchStatuses(
  fetchFn: FetchFn,
  projectId: string,
  signal?: AbortSignal,
): Promise<ListResult<Status>> {
  return fetchJsonOrThrow(
    `/api/statuses?projectId=${encodeURIComponent(projectId)}`,
    signal ? { signal } : {},
    'Failed to fetch statuses',
    fetchFn,
  );
}

export const statusQueries = {
  list: (fetchFn: FetchFn, projectId: string | null | undefined) =>
    queryOptions({
      queryKey: statusQueryKeys.project(projectId),
      queryFn: ({ signal }) => fetchStatuses(fetchFn, projectId!, signal),
    }),
};
