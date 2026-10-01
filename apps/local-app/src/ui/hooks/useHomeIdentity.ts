import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';

export interface HomeIdentity {
  user: string;
  homePath: string;
}

/**
 * This PC's OS user and home folder from the identity endpoint. The values are
 * read-only everywhere: the VM always receives exactly this identity.
 */
export function useHomeIdentity(): HomeIdentity | undefined {
  const query = useQuery(
    {
      queryKey: [HOME_BACKEND, 'host-install-identity'],
      queryFn: async ({ signal }) => {
        const response = await apiFetch(
          '/api/remotes/host-install/identity',
          { signal },
          { backend: HOME_BACKEND },
        );
        if (!response.ok) throw new Error('identity unavailable');
        return (await response.json()) as HomeIdentity;
      },
      staleTime: 60_000,
    },
    useHomeQueryClient(),
  );
  return query.data && query.data.user !== '' && query.data.homePath !== ''
    ? query.data
    : undefined;
}
