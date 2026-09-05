import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';
import { useOptionalWorktreeTab } from './useWorktreeTab';

const PROJECT_STORAGE_KEY = 'devchain:selectedProjectId';
const WORKSPACE_STORAGE_KEY = 'devchain:selectedWorkspaceId';
const WORKSPACE_PROJECTS_STORAGE_KEY = 'devchain:selectedProjectIdsByWorkspace';

interface Project {
  id: string;
  workspaceId: string;
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

export interface ProjectWorkspace {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  projectCount: number;
  deviceGrantCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ProjectsResponse {
  items: ProjectWithStats[];
  total?: number;
}

type ProjectSelectionsByWorkspace = Record<string, string | undefined>;

interface PendingProjectActivation {
  workspaceId: string;
  projectId: string;
  previousDataUpdateCount: number;
}

interface ProjectActivationState {
  workspaceId: string;
  projectId: string;
  status: 'pending' | 'confirmed' | 'failed';
}

interface ProjectSelectionContextValue {
  workspaces: ProjectWorkspace[];
  workspacesLoading: boolean;
  workspacesError: boolean;
  selectedWorkspaceId?: string;
  selectedWorkspace?: ProjectWorkspace;
  setSelectedWorkspaceId: (workspaceId: string) => void;
  isWorkspaceSelectionLocked: boolean;
  projects: ProjectWithStats[];
  projectsLoading: boolean;
  projectsError: boolean;
  refetchProjects: () => Promise<void>;
  selectedProjectId?: string;
  selectedProject?: ProjectWithStats;
  setSelectedProjectId: (projectId?: string) => void;
  projectActivation: ProjectActivationState | null;
  activateProject: (project: Pick<Project, 'id' | 'workspaceId'>) => void;
}

const ProjectSelectionContext = createContext<ProjectSelectionContextValue | undefined>(undefined);

const STATS_TIMEOUT_MS = 5000;

async function fetchWorkspaces({ signal }: { signal?: AbortSignal } = {}): Promise<
  ProjectWorkspace[]
> {
  const response = await fetch('/api/workspaces', { signal });
  if (!response.ok) throw new Error('Failed to fetch workspaces');
  return response.json();
}

async function fetchProjects({
  signal,
  workspaceId,
}: { signal?: AbortSignal; workspaceId?: string } = {}): Promise<ProjectsResponse> {
  const projectsUrl = workspaceId
    ? `/api/projects?workspaceId=${encodeURIComponent(workspaceId)}`
    : '/api/projects';
  const res = await fetch(projectsUrl, { signal });
  if (!res.ok) throw new Error('Failed to fetch projects');
  const data = (await res.json()) as ProjectsResponse;

  const projectsWithStats = await Promise.all(
    data.items.map(async (project) => {
      try {
        const timeoutSignal =
          typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(STATS_TIMEOUT_MS)
            : undefined;
        const statsSignal =
          signal && timeoutSignal && typeof AbortSignal.any === 'function'
            ? AbortSignal.any([signal, timeoutSignal])
            : (signal ?? timeoutSignal);
        const statsRes = await fetch(`/api/projects/${project.id}/stats`, {
          signal: statsSignal,
        });
        if (statsRes.ok) {
          const stats = (await statsRes.json()) as ProjectStats;
          return { ...project, stats };
        }
      } catch {
        // Stats are optional; project selection must remain available if enrichment fails.
      }
      return project;
    }),
  );

  return { ...data, items: projectsWithStats };
}

async function fetchProjectDetail(
  selector: { id?: string; path?: string },
  signal?: AbortSignal,
): Promise<ProjectWithStats> {
  const urls = [
    selector.id ? `/api/projects/${encodeURIComponent(selector.id)}` : undefined,
    selector.path ? `/api/projects/by-path?path=${encodeURIComponent(selector.path)}` : undefined,
  ].filter((url): url is string => Boolean(url));

  for (const url of urls) {
    const response = await fetch(url, { signal });
    if (response.ok) return response.json();
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
  }

  throw new Error('Failed to resolve project selection');
}

function readHybridStorageValue(key: string): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(key) ?? window.localStorage.getItem(key);
}

function readSelectedProjectId(): string | null {
  return readHybridStorageValue(PROJECT_STORAGE_KEY);
}

function readSelectedWorkspaceId(): string | null {
  return readHybridStorageValue(WORKSPACE_STORAGE_KEY);
}

function readProjectSelectionMap(storage: Storage): Record<string, string> {
  const raw = storage.getItem(WORKSPACE_PROJECTS_STORAGE_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          entry[0].length > 0 && typeof entry[1] === 'string' && entry[1].length > 0,
      ),
    );
  } catch {
    return {};
  }
}

function readSelectedProjectsByWorkspace(): ProjectSelectionsByWorkspace {
  if (typeof window === 'undefined') return {};
  return {
    ...readProjectSelectionMap(window.localStorage),
    ...readProjectSelectionMap(window.sessionStorage),
  };
}

function writeProjectSelectionMap(storage: Storage, selections: Record<string, string>): void {
  if (Object.keys(selections).length === 0) {
    storage.removeItem(WORKSPACE_PROJECTS_STORAGE_KEY);
    return;
  }
  storage.setItem(WORKSPACE_PROJECTS_STORAGE_KEY, JSON.stringify(selections));
}

function persistSelectedWorkspace(workspaceId: string): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, workspaceId);
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, workspaceId);
}

function persistSelectedProject(workspaceId: string, projectId?: string): void {
  if (typeof window === 'undefined') return;

  const sessionSelections = readProjectSelectionMap(window.sessionStorage);
  const localSelections = readProjectSelectionMap(window.localStorage);

  if (projectId) {
    sessionSelections[workspaceId] = projectId;
    localSelections[workspaceId] = projectId;
    window.sessionStorage.setItem(PROJECT_STORAGE_KEY, projectId);
    window.localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
  } else {
    delete sessionSelections[workspaceId];
    window.sessionStorage.removeItem(PROJECT_STORAGE_KEY);
  }

  writeProjectSelectionMap(window.sessionStorage, sessionSelections);
  writeProjectSelectionMap(window.localStorage, localSelections);
}

function readUrlProjectSelector(): { id?: string; path?: string } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search || '');
  const id = params.get('projectId')?.trim() || undefined;
  const path = params.get('projectPath')?.trim() || undefined;
  return id || path ? { id, path } : null;
}

export function ProjectSelectionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { activeWorktree, runtimeResolved = true } = useOptionalWorktreeTab();
  const isWorkspaceSelectionLocked = Boolean(activeWorktree);
  const lockedProjectId =
    activeWorktree?.devchainProjectId && activeWorktree.devchainProjectId.trim().length > 0
      ? activeWorktree.devchainProjectId
      : undefined;
  const [selectedWorkspaceId, setSelectedWorkspaceIdState] = useState<string | undefined>(
    () => readSelectedWorkspaceId() ?? undefined,
  );
  const [selectedProjectsByWorkspace, setSelectedProjectsByWorkspace] =
    useState<ProjectSelectionsByWorkspace>(readSelectedProjectsByWorkspace);
  const legacySelectedProjectIdRef = useRef(readSelectedProjectId());
  const urlSelectorRef = useRef(readUrlProjectSelector());
  const [urlSelectionApplied, setUrlSelectionApplied] = useState(!urlSelectorRef.current);
  const wasLockedRef = useRef(false);
  const lockedProjectsDataRef = useRef<ProjectsResponse | undefined>(undefined);
  const pendingActivationRef = useRef<PendingProjectActivation | null>(null);
  const [projectActivation, setProjectActivation] = useState<ProjectActivationState | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const localProjectId = window.localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!window.sessionStorage.getItem(PROJECT_STORAGE_KEY) && localProjectId) {
      window.sessionStorage.setItem(PROJECT_STORAGE_KEY, localProjectId);
    }
    const localWorkspaceId = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!window.sessionStorage.getItem(WORKSPACE_STORAGE_KEY) && localWorkspaceId) {
      window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, localWorkspaceId);
    }
  }, []);

  const workspacesQuery = useQuery({
    queryKey: ['workspaces'],
    queryFn: ({ signal }) => fetchWorkspaces({ signal }),
    enabled: runtimeResolved,
  });

  const lockedProjectQuery = useQuery({
    queryKey: projectsQueryKeys.detail({ id: lockedProjectId }),
    queryFn: ({ signal }) => fetchProjectDetail({ id: lockedProjectId }, signal),
    enabled: runtimeResolved && Boolean(lockedProjectId),
  });

  const urlProjectQuery = useQuery({
    queryKey: projectsQueryKeys.detail(urlSelectorRef.current ?? {}),
    queryFn: ({ signal }) => fetchProjectDetail(urlSelectorRef.current ?? {}, signal),
    enabled: runtimeResolved && !isWorkspaceSelectionLocked && Boolean(urlSelectorRef.current),
    retry: false,
  });

  useEffect(() => {
    if (isWorkspaceSelectionLocked) return;
    const workspaces = workspacesQuery.data;
    if (!workspaces) return;

    if (urlSelectorRef.current && !urlSelectionApplied) {
      if (urlProjectQuery.isLoading) return;

      const targetProject = urlProjectQuery.data;
      if (
        targetProject &&
        workspaces.some((workspace) => workspace.id === targetProject.workspaceId)
      ) {
        setSelectedWorkspaceIdState(targetProject.workspaceId);
        persistSelectedWorkspace(targetProject.workspaceId);
        setSelectedProjectsByWorkspace((current) => ({
          ...current,
          [targetProject.workspaceId]: targetProject.id,
        }));
        persistSelectedProject(targetProject.workspaceId, targetProject.id);
      }
      setUrlSelectionApplied(true);
      if (targetProject) return;
    }

    if (
      selectedWorkspaceId &&
      workspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      return;
    }

    const defaultWorkspace = workspaces.find((workspace) => workspace.isDefault);
    if (!defaultWorkspace) return;
    setSelectedWorkspaceIdState(defaultWorkspace.id);
    persistSelectedWorkspace(defaultWorkspace.id);
  }, [
    isWorkspaceSelectionLocked,
    selectedWorkspaceId,
    urlSelectionApplied,
    urlProjectQuery.data,
    urlProjectQuery.isLoading,
    workspacesQuery.data,
  ]);

  const lockedProject = lockedProjectQuery.data;
  const effectiveSelectedWorkspaceId = runtimeResolved
    ? isWorkspaceSelectionLocked
      ? lockedProject?.workspaceId
      : selectedWorkspaceId
    : undefined;

  const projectsQuery = useQuery({
    queryKey: projectsQueryKeys.available(effectiveSelectedWorkspaceId),
    queryFn: ({ signal }) => fetchProjects({ signal, workspaceId: effectiveSelectedWorkspaceId }),
    enabled: runtimeResolved && Boolean(effectiveSelectedWorkspaceId),
  });

  const storedSelectedProjectId = effectiveSelectedWorkspaceId
    ? selectedProjectsByWorkspace[effectiveSelectedWorkspaceId]
    : undefined;
  const legacySelectedProjectId =
    !storedSelectedProjectId && workspacesQuery.data?.length === 1
      ? (legacySelectedProjectIdRef.current ?? undefined)
      : undefined;
  const unlockedSelectedProjectId = storedSelectedProjectId ?? legacySelectedProjectId;

  useEffect(() => {
    if (isWorkspaceSelectionLocked) {
      wasLockedRef.current = true;
      if (projectsQuery.data) lockedProjectsDataRef.current = projectsQuery.data;
      return;
    }

    if (!urlSelectionApplied) return;

    if (wasLockedRef.current) {
      if (!projectsQuery.data || lockedProjectsDataRef.current === projectsQuery.data) return;
      wasLockedRef.current = false;
      lockedProjectsDataRef.current = undefined;
    }

    const workspaceId = effectiveSelectedWorkspaceId;
    const projectsData = projectsQuery.data;
    if (!workspaceId || !projectsData) return;

    const projectItems = projectsData.items ?? [];
    const currentProjectId = unlockedSelectedProjectId;
    const pendingActivation = pendingActivationRef.current;
    if (
      pendingActivation?.workspaceId === workspaceId &&
      pendingActivation.projectId === currentProjectId
    ) {
      const hasFreshTargetData =
        !projectsQuery.isFetching &&
        (queryClient.getQueryState(projectsQueryKeys.available(workspaceId))?.dataUpdateCount ??
          0) > pendingActivation.previousDataUpdateCount;
      if (!hasFreshTargetData) return;
      pendingActivationRef.current = null;
    }

    if (currentProjectId && projectItems.some((project) => project.id === currentProjectId)) {
      if (selectedProjectsByWorkspace[workspaceId] !== currentProjectId) {
        setSelectedProjectsByWorkspace((current) => ({
          ...current,
          [workspaceId]: currentProjectId,
        }));
        persistSelectedProject(workspaceId, currentProjectId);
      }
      return;
    }

    // The localStorage fallback only applies to stale selections. A selection the
    // user cleared in this tab must resolve to the first project; consulting the
    // retained localStorage value here would resurrect the cleared project.
    let localFallback: string | undefined;
    if (currentProjectId && typeof window !== 'undefined') {
      localFallback =
        readProjectSelectionMap(window.localStorage)[workspaceId] ??
        (workspacesQuery.data?.length === 1
          ? (window.localStorage.getItem(PROJECT_STORAGE_KEY) ?? undefined)
          : undefined);
    }
    const nextProjectId =
      (localFallback && projectItems.some((project) => project.id === localFallback)
        ? localFallback
        : undefined) ?? projectItems[0]?.id;

    if (!currentProjectId && !nextProjectId) return;

    setSelectedProjectsByWorkspace((current) => ({
      ...current,
      [workspaceId]: nextProjectId,
    }));
    persistSelectedProject(workspaceId, nextProjectId);
    legacySelectedProjectIdRef.current = nextProjectId ?? null;
  }, [
    effectiveSelectedWorkspaceId,
    isWorkspaceSelectionLocked,
    projectsQuery.data,
    projectsQuery.isFetching,
    queryClient,
    selectedProjectsByWorkspace,
    unlockedSelectedProjectId,
    urlSelectionApplied,
    workspacesQuery.data?.length,
  ]);

  const setSelectedWorkspaceId = useCallback(
    (workspaceId: string) => {
      if (isWorkspaceSelectionLocked) return;
      if (!workspacesQuery.data?.some((workspace) => workspace.id === workspaceId)) return;
      pendingActivationRef.current = null;
      setSelectedWorkspaceIdState(workspaceId);
      persistSelectedWorkspace(workspaceId);
    },
    [isWorkspaceSelectionLocked, workspacesQuery.data],
  );

  const setSelectedProjectId = useCallback(
    (projectId?: string) => {
      if (isWorkspaceSelectionLocked || !effectiveSelectedWorkspaceId) return;
      pendingActivationRef.current = null;
      setSelectedProjectsByWorkspace((current) => ({
        ...current,
        [effectiveSelectedWorkspaceId]: projectId,
      }));
      persistSelectedProject(effectiveSelectedWorkspaceId, projectId);
      legacySelectedProjectIdRef.current = projectId ?? null;
    },
    [effectiveSelectedWorkspaceId, isWorkspaceSelectionLocked],
  );

  const activateProject = useCallback(
    (project: Pick<Project, 'id' | 'workspaceId'>): void => {
      if (isWorkspaceSelectionLocked) return;
      if (!workspacesQuery.data?.some((workspace) => workspace.id === project.workspaceId)) {
        return;
      }

      const targetQueryKey = projectsQueryKeys.available(project.workspaceId);
      pendingActivationRef.current = {
        workspaceId: project.workspaceId,
        projectId: project.id,
        previousDataUpdateCount: queryClient.getQueryState(targetQueryKey)?.dataUpdateCount ?? 0,
      };
      setSelectedWorkspaceIdState(project.workspaceId);
      setSelectedProjectsByWorkspace((current) => ({
        ...current,
        [project.workspaceId]: project.id,
      }));
      persistSelectedWorkspace(project.workspaceId);
      persistSelectedProject(project.workspaceId, project.id);
      legacySelectedProjectIdRef.current = project.id;
      setProjectActivation({
        workspaceId: project.workspaceId,
        projectId: project.id,
        status: 'pending',
      });
      const settleActivation = (status: ProjectActivationState['status']): void => {
        setProjectActivation((current) =>
          current?.workspaceId === project.workspaceId && current.projectId === project.id
            ? { ...current, status }
            : current,
        );
      };
      void queryClient
        .fetchQuery({
          queryKey: targetQueryKey,
          queryFn: ({ signal }) => fetchProjects({ signal, workspaceId: project.workspaceId }),
          staleTime: 0,
        })
        .then((targetProjects) => {
          settleActivation(
            targetProjects.items.some((candidate) => candidate.id === project.id)
              ? 'confirmed'
              : 'failed',
          );
        })
        .catch(() => settleActivation('failed'));
    },
    [isWorkspaceSelectionLocked, queryClient, workspacesQuery.data],
  );

  const effectiveSelectedProjectId = runtimeResolved
    ? (lockedProjectId ?? unlockedSelectedProjectId)
    : undefined;

  const selectedProject = useMemo(() => {
    if (!runtimeResolved || !effectiveSelectedProjectId) return undefined;
    const availableProject = projectsQuery.data?.items.find(
      (project) => project.id === effectiveSelectedProjectId,
    );
    if (availableProject) return availableProject;
    if (lockedProject?.id === effectiveSelectedProjectId) return lockedProject;
    if (urlProjectQuery.data?.id === effectiveSelectedProjectId) return urlProjectQuery.data;
    return undefined;
  }, [
    effectiveSelectedProjectId,
    lockedProject,
    projectsQuery.data,
    runtimeResolved,
    urlProjectQuery.data,
  ]);

  const selectedWorkspace = useMemo(
    () => workspacesQuery.data?.find((workspace) => workspace.id === effectiveSelectedWorkspaceId),
    [effectiveSelectedWorkspaceId, workspacesQuery.data],
  );

  const refetchProjects = useCallback(async () => {
    await projectsQuery.refetch();
  }, [projectsQuery]);

  const workspacesLoading =
    !runtimeResolved ||
    workspacesQuery.isLoading ||
    (isWorkspaceSelectionLocked && lockedProjectQuery.isLoading);
  const projectsLoading =
    workspacesLoading ||
    !effectiveSelectedWorkspaceId ||
    projectsQuery.isLoading ||
    (Boolean(urlSelectorRef.current) && !urlSelectionApplied);

  const value = useMemo<ProjectSelectionContextValue>(
    () => ({
      workspaces: workspacesQuery.data ?? [],
      workspacesLoading,
      workspacesError: workspacesQuery.isError,
      selectedWorkspaceId: effectiveSelectedWorkspaceId,
      selectedWorkspace,
      setSelectedWorkspaceId,
      isWorkspaceSelectionLocked,
      projects: projectsQuery.data?.items ?? [],
      projectsLoading,
      projectsError: projectsQuery.isError,
      refetchProjects,
      selectedProjectId: effectiveSelectedProjectId,
      selectedProject,
      projectActivation,
      setSelectedProjectId,
      activateProject,
    }),
    [
      activateProject,
      effectiveSelectedProjectId,
      effectiveSelectedWorkspaceId,
      isWorkspaceSelectionLocked,
      projectsLoading,
      projectsQuery.data,
      projectsQuery.isError,
      projectActivation,
      refetchProjects,
      selectedProject,
      selectedWorkspace,
      setSelectedProjectId,
      setSelectedWorkspaceId,
      workspacesLoading,
      workspacesQuery.data,
      workspacesQuery.isError,
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

export {
  PROJECT_STORAGE_KEY,
  WORKSPACE_PROJECTS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  fetchProjectDetail,
  fetchProjects,
  fetchWorkspaces,
};
