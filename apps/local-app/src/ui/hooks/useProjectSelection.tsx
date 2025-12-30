import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';

const PROJECT_STORAGE_KEY = 'devchain:selectedProjectId';

interface Project {
  id: string;
  name: string;
  description?: string | null;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectStats {
  epicsCount: number;
  agentsCount: number;
}

export interface ProjectWithStats extends Project {
  stats?: ProjectStats;
}

interface ProjectsResponse {
  items: ProjectWithStats[];
  total?: number;
}

interface ProjectSelectionContextValue {
  projects: ProjectWithStats[];
  projectsLoading: boolean;
  projectsError: boolean;
  refetchProjects: () => Promise<void>;
  selectedProjectId?: string;
  selectedProject?: ProjectWithStats;
  setSelectedProjectId: (projectId?: string) => void;
}

const ProjectSelectionContext = createContext<ProjectSelectionContextValue | undefined>(undefined);

async function fetchProjects(): Promise<ProjectsResponse> {
  const res = await fetch('/api/projects');
  if (!res.ok) throw new Error('Failed to fetch projects');
  const data = await res.json();

  const projectsWithStats = await Promise.all(
    data.items.map(async (project: Project) => {
      try {
        const statsRes = await fetch(`/api/projects/${project.id}/stats`);
        if (statsRes.ok) {
          const stats = await statsRes.json();
          return { ...project, stats };
        }
      } catch {
        // Ignore stats fetch errors; return project without stats.
      }
      return project;
    }),
  );

  return { ...data, items: projectsWithStats };
}

function persistSelectedProject(projectId?: string) {
  if (typeof window === 'undefined') return;
  if (projectId) {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
  } else {
    window.localStorage.removeItem(PROJECT_STORAGE_KEY);
  }
}

export function ProjectSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    return window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? undefined;
  });
  const appliedFromQueryRef = useRef(false);

  const {
    data: projectsData,
    isLoading: projectsLoading,
    isError: projectsError,
    refetch,
  } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });

  // Apply URL-driven selection once per load
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!projectsData || appliedFromQueryRef.current) return;

    const params = new URLSearchParams(window.location.search || '');
    const byId = params.get('projectId');
    const byPath = params.get('projectPath');

    const items = projectsData.items ?? [];
    const normalize = (p: string) => p.replace(/\/+$/, '');

    if (byId) {
      const exists = items.some((p) => p.id === byId);
      if (exists) {
        setSelectedProjectIdState(byId);
        persistSelectedProject(byId);
        appliedFromQueryRef.current = true;
        return;
      }
    }

    if (byPath) {
      const target = normalize(byPath);
      const match = items.find((p) => normalize(p.rootPath) === target);
      if (match) {
        setSelectedProjectIdState(match.id);
        persistSelectedProject(match.id);
        appliedFromQueryRef.current = true;
        return;
      }
    }
  }, [projectsData]);

  useEffect(() => {
    if (!projectsData) return;

    const projectItems = projectsData.items ?? [];

    if (projectItems.length === 1) {
      const onlyProjectId = projectItems[0].id;
      if (selectedProjectId !== onlyProjectId) {
        setSelectedProjectIdState(onlyProjectId);
        persistSelectedProject(onlyProjectId);
      }
      return;
    }

    if (selectedProjectId && !projectItems.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectIdState(undefined);
      persistSelectedProject(undefined);
    }
  }, [projectsData, selectedProjectId]);

  const setSelectedProjectId = useCallback((projectId?: string) => {
    setSelectedProjectIdState(projectId);
    persistSelectedProject(projectId);
  }, []);

  const selectedProject = useMemo(
    () => projectsData?.items?.find((project) => project.id === selectedProjectId),
    [projectsData, selectedProjectId],
  );

  const refetchProjects = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const value = useMemo(
    () => ({
      projects: projectsData?.items ?? [],
      projectsLoading,
      projectsError,
      refetchProjects,
      selectedProjectId,
      selectedProject,
      setSelectedProjectId,
    }),
    [
      projectsData,
      projectsLoading,
      projectsError,
      refetchProjects,
      selectedProjectId,
      selectedProject,
      setSelectedProjectId,
    ],
  );

  return (
    <ProjectSelectionContext.Provider value={value}>{children}</ProjectSelectionContext.Provider>
  );
}

export function useSelectedProject() {
  const context = useContext(ProjectSelectionContext);
  if (!context) {
    throw new Error('useSelectedProject must be used within a ProjectSelectionProvider');
  }
  return context;
}

export { PROJECT_STORAGE_KEY, fetchProjects };
