import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import { syncStatusQueryKey } from '@/ui/pages/cloud/lib/remote-vm-query-keys';

export interface UseSyncStatusOptions {
  /** Limits the read to one project; omit for every project on a VM. */
  projectId?: string;
  details?: boolean;
  pollMs: number;
  /** Keeps the last answer on screen while a changed option loads its first answer. */
  keepPrevious?: boolean;
}

/**
 * The measured file sync status, always on the home client: the dock renders inside
 * `BackendBoundary`, whose ambient client is the VM's while a remote project is active.
 */
export function useSyncStatus({
  projectId,
  details = false,
  pollMs,
  keepPrevious = false,
}: UseSyncStatusOptions) {
  const api = useRemoteVmApi();
  const queryClient = useHomeQueryClient();
  return useQuery(
    {
      queryKey: syncStatusQueryKey(projectId ?? null, details),
      queryFn: ({ signal }) => api.readSyncStatus({ projectId, details }, signal),
      refetchInterval: pollMs,
      placeholderData: keepPrevious ? keepPreviousData : undefined,
    },
    queryClient,
  );
}
