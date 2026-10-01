import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import { remoteOperationsKeys, type RemoteOperationDto } from './useRemoteOperations';

async function fetchNewest(projectId: string, signal: AbortSignal) {
  const res = await apiFetch(
    `/api/remotes/operations?projectId=${encodeURIComponent(projectId)}&limit=1`,
    { signal },
    { backend: HOME_BACKEND },
  );
  if (!res.ok) throw new Error(`Could not load the project's last operation (${res.status})`);
  const body = (await res.json()) as { items?: RemoteOperationDto[] };
  return body.items?.[0] ?? null;
}

/**
 * The newest operation of each given project, in any state: a cancelled
 * Connect records its cleanup error there. Under the operations key, so any
 * operation refresh reloads it.
 */
export function useProjectNewestOperations(
  projectIds: readonly string[],
): ReadonlyMap<string, RemoteOperationDto> {
  const operations = useQueries(
    {
      queries: projectIds.map((projectId) => ({
        queryKey: remoteOperationsKeys.newestOfProject(projectId),
        queryFn: ({ signal }: { signal: AbortSignal }) => fetchNewest(projectId, signal),
      })),
      // Structurally shared, so the map below changes only when an answer does.
      combine: (results) => results.map((result) => result.data ?? null),
    },
    useHomeQueryClient(),
  );
  return useMemo(() => {
    const map = new Map<string, RemoteOperationDto>();
    for (const operation of operations) {
      if (operation?.projectId) map.set(operation.projectId, operation);
    }
    return map;
  }, [operations]);
}
