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
import type { BackendId } from '@/ui/lib/api-transport';
import type { ExportData } from '@devchain/shared';

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
  loadSetupPreview(
    request: SetupPreviewRequest,
    backend?: BackendId,
  ): Promise<SetupPreviewResponse>;
  /** Home's content of a template from home's list (`GET /api/templates/:slug[/versions/:version]`). */
  readHomeTemplateContent(slug: string, version?: string | null): Promise<Record<string, unknown>>;
  /** `backend` names the instance that owns the project; it defaults to home. */
  loadUpgradePreview(
    projectId: string,
    targetVersion: string,
    backend?: BackendId,
  ): Promise<SetupPreviewResponse>;
  runImportDryRun(
    projectId: string,
    input: Record<string, unknown>,
    backend?: BackendId,
  ): Promise<ImportDryRunResponse>;
  /** The project's current export (`GET /api/projects/:id/export`) from the instance that owns it. */
  loadProjectExport(projectId: string, backend?: BackendId): Promise<ExportData>;
  commitImport(
    projectId: string,
    input: Record<string, unknown>,
    backend?: BackendId,
  ): Promise<ImportProjectResponse>;
  commitUpgrade(
    projectId: string,
    input: Record<string, unknown>,
    backend?: BackendId,
  ): Promise<UpgradeProjectResponse>;
  /** Asks home to pull a connected project's host changes into its mirror now. */
  pullRemoteProject(projectId: string): Promise<void>;
  listRemoteOwners(): Promise<ProjectRemoteOwner[]>;
}

export interface WorkspaceTransitionDevice {
  readonly kid: string;
  readonly label?: string;
  readonly localAlias?: string;
}
