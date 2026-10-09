import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import { remoteReadinessQueryKey } from '@/ui/pages/cloud/lib/remote-vm-query-keys';

/** Whether this PC can set up a VM: Syncthing, identity and Docker. */
export function useRemoteReadiness() {
  const api = useRemoteVmApi();
  const query = useQuery(
    {
      queryKey: remoteReadinessQueryKey,
      queryFn: ({ signal }) => api.readReadiness(signal),
      staleTime: 60_000,
    },
    useHomeQueryClient(),
  );
  return {
    readiness: query.data ?? null,
    checking: query.isFetching,
    error: query.error,
    checkAgain: () => void query.refetch(),
  };
}
