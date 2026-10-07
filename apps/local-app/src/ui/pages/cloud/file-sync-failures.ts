import { useQuery } from '@tanstack/react-query';
export { isSelectableExclusion } from '@/modules/file-sync/sync-path-inspection.dto';
import type { ProjectFileSyncFailures } from '@/modules/remotes/sync/remote-file-sync.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { readErrorMessage } from '@/ui/hooks/useRemotes';
import { apiFetch, HOME_BACKEND } from '@/ui/lib/api-transport';

export function useProjectFileSyncFailures(projectId: string, enabled = true) {
  return useQuery(
    {
      queryKey: [HOME_BACKEND, 'file-sync-failed', projectId],
      enabled,
      retry: false,
      refetchOnMount: 'always',
      queryFn: async ({ signal }) => {
        const response = await apiFetch(
          `/api/projects/${encodeURIComponent(projectId)}/file-sync/failed`,
          { signal },
          { backend: HOME_BACKEND },
        );
        if (!response.ok)
          throw new Error(await readErrorMessage(response, 'Could not read file sync failures.'));
        const body = (await response.json()) as ProjectFileSyncFailures;
        if (
          !Array.isArray(body.home?.entries) ||
          !Array.isArray(body.vm?.entries) ||
          !Array.isArray(body.installedPrefix) ||
          !Array.isArray(body.groups)
        ) {
          throw new Error('The server returned no failed-file list.');
        }
        return body;
      },
    },
    useHomeQueryClient(),
  );
}
