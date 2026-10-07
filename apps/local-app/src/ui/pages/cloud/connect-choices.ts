import { useQuery } from '@tanstack/react-query';
import type { ConnectChoicesDto } from '@/modules/remotes/connect-choices.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { readErrorMessage } from '@/ui/hooks/useRemotes';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';

export function useConnectChoices(projectId: string | null) {
  return useQuery(
    {
      queryKey: [HOME_BACKEND, 'connect-choices', projectId],
      queryFn: async ({ signal }): Promise<ConnectChoicesDto> => {
        const response = await apiFetch(
          `/api/projects/${encodeURIComponent(projectId!)}/connect-choices`,
          { signal },
          { backend: HOME_BACKEND },
        );
        if (!response.ok)
          throw new Error(await readErrorMessage(response, 'Could not read the Connect choices.'));
        const body = (await response.json()) as Partial<ConnectChoicesDto>;
        return {
          remoteId: typeof body.remoteId === 'string' ? body.remoteId : undefined,
          includeDocker: body.includeDocker === true,
          git: body.git === 'missing' ? 'missing' : 'present',
        };
      },
      enabled: projectId !== null,
      retry: false,
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnWindowFocus: false,
    },
    useHomeQueryClient(),
  );
}
