import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import { remoteOperationsKeys } from '@/ui/pages/cloud/lib/remote-vm-query-keys';
import type { RemoteOperationDto } from '@/ui/pages/cloud/lib/remote-vm-contracts';

/**
 * The newest operation of each given project, in any state: a cancelled
 * Connect records its cleanup error there. Under the operations key, so any
 * operation refresh reloads it.
 */
export function useProjectNewestOperations(
  projectIds: readonly string[],
): ReadonlyMap<string, RemoteOperationDto> {
  const api = useRemoteVmApi();
  const operations = useQueries(
    {
      queries: projectIds.map((projectId) => ({
        queryKey: remoteOperationsKeys.newestOfProject(projectId),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          api.readNewestOperation(projectId, signal),
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
