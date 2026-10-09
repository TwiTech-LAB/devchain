import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { connectChoicesQueryKey } from './lib/remote-vm-query-keys';

export function useConnectChoices(projectId: string | null) {
  const api = useRemoteVmApi();
  return useQuery(
    {
      queryKey: connectChoicesQueryKey(projectId),
      queryFn: ({ signal }) => api.readConnectChoices(projectId!, signal),
      enabled: projectId !== null,
      retry: false,
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
    },
    useHomeQueryClient(),
  );
}
