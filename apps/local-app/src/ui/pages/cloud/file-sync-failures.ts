import { useQuery } from '@tanstack/react-query';
export { isSelectableExclusion } from '@/modules/file-sync/sync-path-inspection.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { fileSyncFailuresQueryKey } from './lib/remote-vm-query-keys';

export function useProjectFileSyncFailures(projectId: string, enabled = true) {
  const api = useRemoteVmApi();
  return useQuery(
    {
      queryKey: fileSyncFailuresQueryKey(projectId),
      enabled,
      retry: false,
      refetchOnMount: 'always',
      queryFn: ({ signal }) => api.readProjectFileSyncFailures(projectId, signal),
    },
    useHomeQueryClient(),
  );
}
