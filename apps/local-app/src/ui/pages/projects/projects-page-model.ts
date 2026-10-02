import { isLessThan } from '@devchain/shared';
import type {
  ProjectRemoteOwner,
  ProjectTemplate,
  ProjectsQueryData,
  ProjectWithStats,
  ProjectWorkspace,
} from './lib/project-contracts';
import type {
  ProjectTableRowModel,
  ProjectWorkspaceGroupModel,
  ProjectsSortField,
  ProjectsSortOrder,
  ProjectsTableContent,
  ProjectsTableModel,
} from './projects-page-presentation';
import { projectActionsButtonId } from './projects-page-presentation';
import { getWorkspaceIdentity } from '@/ui/lib/workspace-identity';

export interface ProjectsTableActions {
  changeSearch: (value: string) => void;
  toggleSort: (field: ProjectsSortField) => void;
  openCreate: () => void;
  openCreateInWorkspace: (workspaceId: string) => void;
  openCreateWorkspace: () => void;
  startProjectDrag: (projectId: string, sourceWorkspaceId: string) => void;
  enterDragWorkspace: (workspaceId: string) => void;
  leaveDragWorkspace: (workspaceId: string) => void;
  dropProjectOnWorkspace: (workspaceId: string) => void;
  endProjectDrag: () => void;
  toggleWorkspace: (workspaceId: string) => void;
  retry: () => void;
  renameWorkspace: (workspace: ProjectWorkspace) => void;
  requestDeleteWorkspace: (workspace: ProjectWorkspace) => void;
  moveWorkspace: (workspaceId: string, direction: -1 | 1) => void;
  openProject: (project: ProjectWithStats) => void;
  editProject: (project: ProjectWithStats) => void;
  requestDelete: (project: ProjectWithStats) => void;
  startImport: (project: ProjectWithStats) => void;
  exportProject: (project: ProjectWithStats) => void;
  configureProject: (project: ProjectWithStats) => void;
  upgradeProject: (project: ProjectWithStats, targetVersion: string) => void;
  requestProjectMove: (project: ProjectWithStats, workspaceId: string) => void;
}

export interface BuildProjectsTableModelInput {
  data: ProjectsQueryData | undefined;
  isLoading: boolean;
  search: string;
  sortField: ProjectsSortField;
  sortOrder: ProjectsSortOrder;
  templates: ProjectTemplate[] | undefined;
  workspaces: ProjectWorkspace[] | undefined;
  unavailableData?: ReadonlyArray<'projects' | 'workspaces'>;
  collapsedWorkspaceIds?: ReadonlySet<string>;
  projectDrag?: {
    readonly projectId: string | null;
    readonly sourceWorkspaceId: string | null;
    readonly targetWorkspaceId: string | null;
  };
  statusMessage?: string;
  /** Projects a remote owns, by project ID. */
  remoteOwners?: ReadonlyMap<string, ProjectRemoteOwner>;
  actions: ProjectsTableActions;
}

export function getProjectUpgradeVersion(
  project: ProjectWithStats,
  templates: ProjectTemplate[] | undefined,
): string | null {
  const metadata = project.templateMetadata;
  if (!metadata) return null;
  if (metadata.source === 'bundled') return project.bundledUpgradeAvailable ?? null;
  if (metadata.source !== 'registry' || !metadata.version) return null;

  const template = templates?.find(
    (candidate) => candidate.slug === metadata.slug && candidate.source === 'registry',
  );
  if (!template?.latestVersion) return null;
  return isLessThan(metadata.version, template.latestVersion) ? template.latestVersion : null;
}

export function filterAndSortProjects(
  projects: ProjectWithStats[],
  search: string,
  sortField: ProjectsSortField,
  sortOrder: ProjectsSortOrder,
): ProjectWithStats[] {
  const query = search.trim().toLowerCase();
  const filtered = projects.filter(
    (project) =>
      project.name.toLowerCase().includes(query) ||
      project.rootPath.toLowerCase().includes(query) ||
      project.description?.toLowerCase().includes(query),
  );

  return filtered.sort((left, right) => {
    const leftValue = projectSortValue(left, sortField);
    const rightValue = projectSortValue(right, sortField);
    if (leftValue === rightValue) return 0;
    if (sortOrder === 'asc') return leftValue > rightValue ? 1 : -1;
    return leftValue < rightValue ? 1 : -1;
  });
}

export function buildProjectsTableModel(input: BuildProjectsTableModelInput): ProjectsTableModel {
  const {
    data,
    isLoading,
    search,
    sortField,
    sortOrder,
    templates,
    workspaces,
    unavailableData = [],
    actions,
    collapsedWorkspaceIds = new Set<string>(),
    projectDrag = { projectId: null, sourceWorkspaceId: null, targetWorkspaceId: null },
    statusMessage = '',
    remoteOwners = new Map<string, ProjectRemoteOwner>(),
  } = input;
  const failedData = new Set(unavailableData);
  if (!isLoading && !data) failedData.add('projects');
  if (!isLoading && !workspaces) failedData.add('workspaces');

  return {
    search,
    changeSearch: actions.changeSearch,
    sortField,
    sortOrder,
    toggleSort: actions.toggleSort,
    openCreate: actions.openCreate,
    openCreateInWorkspace: actions.openCreateInWorkspace,
    requestProjectMove: (projectId, workspaceId) => {
      const project = data?.items.find((candidate) => candidate.id === projectId);
      if (project && !remoteOwners.has(project.id))
        actions.requestProjectMove(project, workspaceId);
    },
    openCreateWorkspace: actions.openCreateWorkspace,
    statusMessage,
    drag: {
      ...projectDrag,
      start: actions.startProjectDrag,
      enterWorkspace: actions.enterDragWorkspace,
      leaveWorkspace: actions.leaveDragWorkspace,
      dropOnWorkspace: actions.dropProjectOnWorkspace,
      end: actions.endProjectDrag,
    },
    content: buildTableContent({
      data,
      isLoading,
      failedData: [...failedData],
      search,
      sortField,
      sortOrder,
      workspaces,
      templates,
      collapsedWorkspaceIds,
      remoteOwners,
      actions,
    }),
  };
}

function buildTableContent({
  data,
  isLoading,
  failedData,
  search,
  sortField,
  sortOrder,
  workspaces,
  templates,
  collapsedWorkspaceIds,
  remoteOwners,
  actions,
}: {
  data: ProjectsQueryData | undefined;
  isLoading: boolean;
  failedData: ReadonlyArray<'projects' | 'workspaces'>;
  search: string;
  sortField: ProjectsSortField;
  sortOrder: ProjectsSortOrder;
  workspaces: ProjectWorkspace[] | undefined;
  templates: ProjectTemplate[] | undefined;
  collapsedWorkspaceIds: ReadonlySet<string>;
  remoteOwners: ReadonlyMap<string, ProjectRemoteOwner>;
  actions: ProjectsTableActions;
}): ProjectsTableContent {
  if (isLoading) return { kind: 'loading' };
  if (failedData.length > 0 || !data || !workspaces) {
    return { kind: 'unavailable', failedData, retry: actions.retry };
  }

  const searchActive = search.trim().length > 0;
  const orderedWorkspaces = [...workspaces].sort((left, right) => left.position - right.position);
  return {
    kind: 'ready',
    searchActive,
    groups: orderedWorkspaces.map((workspace, index) => {
      const rows = filterAndSortProjects(
        data.items.filter((project) => project.workspaceId === workspace.id),
        search,
        sortField,
        sortOrder,
      ).map((project) =>
        buildRow(project, orderedWorkspaces, templates, actions, remoteOwners.get(project.id)),
      );
      const emptyState = getWorkspaceEmptyState(searchActive, rows.length, workspace.projectCount);

      return {
        id: workspace.id,
        name: workspace.name,
        isDefault: workspace.isDefault,
        position: workspace.position,
        projectCount: workspace.projectCount,
        visibleMatchCount: rows.length,
        isExpanded: searchActive ? rows.length > 0 : !collapsedWorkspaceIds.has(workspace.id),
        canToggle: !searchActive,
        identity: getWorkspaceIdentity(workspace.name),
        rows,
        emptyState,
        toggleExpanded: () => {
          if (!searchActive) actions.toggleWorkspace(workspace.id);
        },
        openCreate: () => actions.openCreateInWorkspace(workspace.id),
        rename: () => actions.renameWorkspace(workspace),
        moveUp: index > 0 ? () => actions.moveWorkspace(workspace.id, -1) : undefined,
        moveDown:
          index < orderedWorkspaces.length - 1
            ? () => actions.moveWorkspace(workspace.id, 1)
            : undefined,
        requestDelete: workspace.isDefault
          ? undefined
          : () => actions.requestDeleteWorkspace(workspace),
      };
    }),
  };
}

function getWorkspaceEmptyState(
  searchActive: boolean,
  visibleProjectCount: number,
  totalProjectCount: number,
): ProjectWorkspaceGroupModel['emptyState'] {
  if (visibleProjectCount > 0) return 'none';
  if (searchActive) return 'no-matches';
  return totalProjectCount === 0 ? 'workspace-empty' : 'scoped';
}

function projectSortValue(project: ProjectWithStats, field: ProjectsSortField): string | number {
  if (field === 'name') return project.name.toLowerCase();
  if (field === 'rootPath') return project.rootPath.toLowerCase();
  return new Date(project.createdAt).getTime();
}

function buildRow(
  project: ProjectWithStats,
  workspaces: ProjectWorkspace[],
  templates: ProjectTemplate[] | undefined,
  actions: ProjectsTableActions,
  remoteOwner?: ProjectRemoteOwner,
): ProjectTableRowModel {
  const upgradeVersion = getProjectUpgradeVersion(project, templates);
  const remoteLock = remoteOwner ? { message: describeRemoteLock(remoteOwner) } : null;

  return {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    description: project.description,
    isTemplate: Boolean(project.isTemplate),
    workspaceId: project.workspaceId,
    workspaceName:
      workspaces.find((workspace) => workspace.id === project.workspaceId)?.name ?? '—',
    epicsCount: project.stats?.epicsCount ?? 0,
    agentsCount: project.stats?.agentsCount ?? 0,
    template: project.templateMetadata
      ? {
          slug: project.templateMetadata.slug,
          source: project.templateMetadata.source,
          version: project.templateMetadata.version,
          upgradeVersion,
        }
      : null,
    open: () => actions.openProject(project),
    edit: () => actions.editProject(project),
    requestDelete: () => actions.requestDelete(project),
    startImport: () => actions.startImport(project),
    export: () => actions.exportProject(project),
    configure: project.isConfigurable ? () => actions.configureProject(project) : undefined,
    upgrade:
      upgradeVersion && !remoteLock
        ? () => actions.upgradeProject(project, upgradeVersion)
        : undefined,
    actionsButtonId: projectActionsButtonId(project.id),
    remoteLock,
    moveTargets: workspaces
      .filter((workspace) => !remoteLock && workspace.id !== project.workspaceId)
      .map((workspace) => ({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        requestMove: () => actions.requestProjectMove(project, workspace.id),
      })),
  };
}

export function describeRemoteLock(owner: ProjectRemoteOwner): string {
  const remote = owner.remoteName ? `remote "${owner.remoteName}"` : 'a remote';
  if (owner.state === 'attaching')
    return `Connecting to ${remote}; changes are paused. Cancel it in Cloud.`;
  if (owner.state === 'detaching') return `Disconnecting from ${remote}; changes are paused.`;
  if (owner.state === 'failed')
    return `Connection to ${remote} failed; retry or cancel it in Cloud.`;
  return `Connected to ${remote}; change this project there.`;
}
