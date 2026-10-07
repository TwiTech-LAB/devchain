import { useQuery } from '@tanstack/react-query';
import type { DockerPresence } from '@/modules/remotes/docker/docker-plan.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { readErrorMessage } from '@/ui/hooks/useRemotes';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';

/** What the Connect dialog knows about a project's Docker work. */
export type DockerPresenceState = DockerPresence['state'] | 'loading';

/** The project's Docker work: loading while any read runs, unknown when the read fails. */
export function useDockerPresence(projectId: string | null): DockerPresenceState {
  const query = useQuery(
    {
      queryKey: [HOME_BACKEND, 'docker-presence', projectId],
      queryFn: async ({ signal }): Promise<DockerPresence> => {
        const response = await apiFetch(
          `/api/projects/${encodeURIComponent(projectId!)}/docker/presence`,
          { signal },
          { backend: HOME_BACKEND },
        );
        if (!response.ok)
          throw new Error(await readErrorMessage(response, 'Could not read Docker presence.'));
        return (await response.json()) as DockerPresence;
      },
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
