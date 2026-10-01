import { useQuery } from '@tanstack/react-query';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';
import type {
  Project,
  ProjectWorkspace,
  ProjectsQueryData,
} from '@/ui/pages/projects/lib/project-contracts';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';

/**
 * One request for every project: the list endpoint has no stable order, so
 * paging with offsets could skip or repeat projects.
 */
const ALL_PROJECTS_LIMIT = 1000;

async function fetchAllProjects(signal: AbortSignal): Promise<ProjectsQueryData> {
  const res = await apiFetch(
    `/api/projects?limit=${ALL_PROJECTS_LIMIT}`,
    { signal },
    { backend: HOME_BACKEND },
  );
  if (!res.ok) throw new Error(`Failed to load projects (${res.status})`);
  return res.json();
}

async function fetchWorkspaces(signal: AbortSignal): Promise<ProjectWorkspace[]> {
  const res = await apiFetch('/api/workspaces', { signal }, { backend: HOME_BACKEND });
  if (!res.ok) throw new Error(`Failed to load workspaces (${res.status})`);
  return res.json();
}

/** Every project of every workspace on this PC, without per-project stats. */
export function useAllProjects() {
  const query = useQuery(
    {
      queryKey: projectsQueryKeys.allWorkspaces(),
      queryFn: ({ signal }) => fetchAllProjects(signal),
    },
    useHomeQueryClient(),
  );
  const items = query.data?.items;
  const projects: Project[] = Array.isArray(items) ? items : [];
  const total = query.data?.total ?? projects.length;
  return {
    projects,
    total,
    /** The server holds more projects than the one request returned. */
    truncated: total > projects.length,
    loading: query.isLoading,
    error: query.error,
  };
}

/** Every workspace on this PC. */
export function useWorkspaces() {
  const query = useQuery(
    {
      queryKey: projectsQueryKeys.workspaces(),
      queryFn: ({ signal }) => fetchWorkspaces(signal),
    },
    useHomeQueryClient(),
  );
  // The key is shared with project selection, whose cache entry may hold its own answer.
  return {
    workspaces: Array.isArray(query.data) ? query.data : [],
    loading: query.isLoading,
    error: query.error,
  };
}
