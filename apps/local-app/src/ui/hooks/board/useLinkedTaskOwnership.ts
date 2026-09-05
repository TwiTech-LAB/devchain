import { useQuery } from '@tanstack/react-query';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';

interface LinkedTaskEpicOwnership {
  id: string;
  projectId: string;
}

export interface LinkedTaskProjectOwnership {
  id: string;
  workspaceId: string;
  name: string;
}

export function useLinkedTaskOwnership(
  epicId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const apiFetch = useFetchFactory();
  const epic = useQuery({
    queryKey: ['epic', epicId],
    queryFn: async ({ signal }): Promise<LinkedTaskEpicOwnership> => {
      const response = await apiFetch(`/api/epics/${encodeURIComponent(epicId)}`, { signal });
      if (!response.ok) throw new Error('The DevChain task could not be loaded.');
      return response.json();
    },
    enabled: enabled && epicId !== '',
    retry: false,
  });
  const projectId = epic.data?.projectId;
  const project = useQuery({
    queryKey: projectsQueryKeys.detail({ id: projectId }),
    queryFn: async ({ signal }): Promise<LinkedTaskProjectOwnership> => {
      const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId!)}`, {
        signal,
      });
      if (!response.ok) throw new Error('The owning DevChain project could not be loaded.');
      return response.json();
    },
    enabled: enabled && Boolean(projectId),
    retry: false,
  });

  return {
    epic: enabled ? epic.data : undefined,
    project: enabled ? project.data : undefined,
    isLoading: enabled && (epic.isLoading || (Boolean(projectId) && project.isLoading)),
    isError: enabled && (epic.isError || project.isError),
    error: epic.error ?? project.error,
    refetch: async () => {
      if (epic.data === undefined) {
        await epic.refetch();
      } else {
        await project.refetch();
      }
    },
  };
}
