import type {
  CreateFromTemplateInput,
  CreateFromTemplateResponse,
  ImportDryRunResponse,
  ImportProjectResponse,
  PathStatResult,
  ProjectRemoteOwner,
  ProjectWorkspace,
  DeleteProjectWorkspaceResult,
  ProjectsQueryData,
  ProjectTemplate,
  SetupPreviewRequest,
  SetupPreviewResponse,
  TemplateManifest,
  UpdateProjectInput,
  UpdateProjectResponse,
  UpgradeProjectResponse,
} from '@/ui/pages/projects/lib/project-contracts';

export interface ProjectsPageApi {
  listProjects(): Promise<ProjectsQueryData>;
  listWorkspaces(): Promise<ProjectWorkspace[]>;
  listPairedDevices(): Promise<WorkspaceTransitionDevice[]>;
  createWorkspace(name: string): Promise<ProjectWorkspace>;
  renameWorkspace(workspaceId: string, name: string): Promise<ProjectWorkspace>;
  reorderWorkspaces(workspaceIds: string[]): Promise<ProjectWorkspace[]>;
  deleteWorkspace(
    workspaceId: string,
    replacementWorkspaceId: string,
  ): Promise<DeleteProjectWorkspaceResult>;
  statPath(path: string): Promise<PathStatResult>;
  listTemplates(): Promise<ProjectTemplate[]>;
  readTemplateManifest(projectId: string): Promise<TemplateManifest | null>;
  createFromTemplate(input: CreateFromTemplateInput): Promise<CreateFromTemplateResponse>;
  updateProject(projectId: string, input: UpdateProjectInput): Promise<UpdateProjectResponse>;
  deleteProject(projectId: string): Promise<void>;
  loadSetupPreview(request: SetupPreviewRequest): Promise<SetupPreviewResponse>;
  loadUpgradePreview(projectId: string, targetVersion: string): Promise<SetupPreviewResponse>;
  runImportDryRun(projectId: string, input: Record<string, unknown>): Promise<ImportDryRunResponse>;
  commitImport(projectId: string, input: Record<string, unknown>): Promise<ImportProjectResponse>;
  commitUpgrade(projectId: string, input: Record<string, unknown>): Promise<UpgradeProjectResponse>;
  listRemoteOwners(): Promise<ProjectRemoteOwner[]>;
}

export interface WorkspaceTransitionDevice {
  readonly kid: string;
  readonly label?: string;
  readonly localAlias?: string;
}
