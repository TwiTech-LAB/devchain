import { useQuery } from '@tanstack/react-query';
import type { DockerPresence } from '@/modules/remotes/docker/docker-plan.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { dockerPresenceQueryKey } from './lib/remote-vm-query-keys';

/** What the Connect dialog knows about a project's Docker work. */
export type DockerPresenceState = DockerPresence['state'] | 'loading';

/** The project's Docker work: loading while any read runs, unknown when the read fails. */
export function useDockerPresence(projectId: string | null): DockerPresenceState {
  const api = useRemoteVmApi();
  const query = useQuery(
    {
      queryKey: dockerPresenceQueryKey(projectId),
      queryFn: ({ signal }) => api.readDockerPresence(projectId!, signal),
      enabled: projectId !== null,
      retry: false,
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
      // A refetch hides the section and resets its choices; a browser reconnect must not.
      refetchOnReconnect: false,
    },
    useHomeQueryClient(),
  );
  if (query.isPending || query.isFetching) return 'loading';
  if (query.isError) return 'unknown';
  return query.data.state;
}
