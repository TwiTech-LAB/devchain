import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from '@/ui/pages/cloud/lib/remote-vm-api-context';
import { homeIdentityQueryKey } from '@/ui/pages/cloud/lib/remote-vm-query-keys';
import type { HomeIdentity } from '@/ui/pages/cloud/lib/remote-vm-contracts';

/**
 * This PC's OS user and home folder from the identity endpoint. The values are
 * read-only everywhere: the VM always receives exactly this identity.
 */
export function useHomeIdentity(): HomeIdentity | undefined {
  const api = useRemoteVmApi();
  const query = useQuery(
    {
      queryKey: homeIdentityQueryKey,
      queryFn: ({ signal }) => api.readHomeIdentity(signal),
      staleTime: 60_000,
    },
    useHomeQueryClient(),
  );
  return query.data && query.data.user !== '' && query.data.homePath !== ''
    ? query.data
    : undefined;
}
