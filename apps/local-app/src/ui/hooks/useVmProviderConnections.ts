import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import { vmProviderConnectionQueryKey } from '@/ui/pages/cloud/lib/remote-vm-query-keys';

export function useVmProviderConnections() {
  const api = useRemoteVmApi();
  const client = useHomeQueryClient();
  const query = useQuery(
    {
      queryKey: vmProviderConnectionQueryKey,
      queryFn: ({ signal }) => api.listVmProviders(signal),
      refetchInterval: 30_000,
    },
    client,
  );
  return { connections: query.data ?? [], loading: query.isLoading, error: query.error };
}
