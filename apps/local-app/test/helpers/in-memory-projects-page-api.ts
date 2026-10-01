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
import type {
  ProjectsPageApi,
  WorkspaceTransitionDevice,
} from '@/ui/pages/projects/lib/projects-page-api';

type Override<TArgs extends unknown[], TResult> =
  | TResult
  | Promise<TResult>
  | Error
  | ((...args: TArgs) => TResult | Promise<TResult>);

export interface InMemoryProjectsPageApiOverrides {
  listProjects?: Override<[], ProjectsQueryData>;
  listWorkspaces?: Override<[], ProjectWorkspace[]>;
  listPairedDevices?: Override<[], WorkspaceTransitionDevice[]>;
  createWorkspace?: Override<[string], ProjectWorkspace>;
  renameWorkspace?: Override<[string, string], ProjectWorkspace>;
  reorderWorkspaces?: Override<[string[]], ProjectWorkspace[]>;
  deleteWorkspace?: Override<[string, string], DeleteProjectWorkspaceResult>;
  statPath?: Override<[string], PathStatResult>;
  listTemplates?: Override<[], ProjectTemplate[]>;
  readTemplateManifest?: Override<[string], TemplateManifest | null>;
  createFromTemplate?: Override<[CreateFromTemplateInput], CreateFromTemplateResponse>;
  updateProject?: Override<[string, UpdateProjectInput], UpdateProjectResponse>;
  deleteProject?: Override<[string], void>;
  loadSetupPreview?: Override<[SetupPreviewRequest], SetupPreviewResponse>;
  loadUpgradePreview?: Override<[string, string], SetupPreviewResponse>;
  runImportDryRun?: Override<[string, Record<string, unknown>], ImportDryRunResponse>;
  commitImport?: Override<[string, Record<string, unknown>], ImportProjectResponse>;
  commitUpgrade?: Override<[string, Record<string, unknown>], UpgradeProjectResponse>;
  listRemoteOwners?: Override<[], ProjectRemoteOwner[]>;
}

export interface InMemoryProjectsPageApiSeed {
  projects?: ProjectsQueryData;
  workspaces?: ProjectWorkspace[];
  pairedDevices?: WorkspaceTransitionDevice[];
  deviceGrantDeviceIds?: Record<string, string[]>;
  templates?: ProjectTemplate[];
  pathStats?: Record<string, PathStatResult>;
  templateManifests?: Record<string, TemplateManifest | null>;
  setupPreview?: SetupPreviewResponse;
  upgradePreview?: SetupPreviewResponse;
  createResult?: CreateFromTemplateResponse;
  importDryRunResult?: ImportDryRunResponse;
  importResult?: ImportProjectResponse;
  upgradeResult?: UpgradeProjectResponse;
  remoteOwners?: ProjectRemoteOwner[];
  overrides?: InMemoryProjectsPageApiOverrides;
}

export class InMemoryProjectsPageApi implements ProjectsPageApi {
  readonly calls = {
    listProjects: [] as Array<readonly []>,
    listWorkspaces: [] as Array<readonly []>,
    listPairedDevices: [] as Array<readonly []>,
    createWorkspace: [] as Array<readonly [string]>,
    renameWorkspace: [] as Array<readonly [string, string]>,
    reorderWorkspaces: [] as Array<readonly [string[]]>,
    deleteWorkspace: [] as Array<readonly [string, string]>,
    statPath: [] as Array<readonly [string]>,
    listTemplates: [] as Array<readonly []>,
    readTemplateManifest: [] as Array<readonly [string]>,
    createFromTemplate: [] as Array<readonly [CreateFromTemplateInput]>,
    updateProject: [] as Array<readonly [string, UpdateProjectInput]>,
    deleteProject: [] as Array<readonly [string]>,
    loadSetupPreview: [] as Array<readonly [SetupPreviewRequest]>,
    loadUpgradePreview: [] as Array<readonly [string, string]>,
    runImportDryRun: [] as Array<readonly [string, Record<string, unknown>]>,
    commitImport: [] as Array<readonly [string, Record<string, unknown>]>,
    commitUpgrade: [] as Array<readonly [string, Record<string, unknown>]>,
    listRemoteOwners: [] as Array<readonly []>,
  };

  readonly overrides: InMemoryProjectsPageApiOverrides;
  private projects: ProjectsQueryData;
  private workspaces: ProjectWorkspace[];
  private readonly pairedDevices: WorkspaceTransitionDevice[];
  private deviceGrantDeviceIds: Record<string, string[]>;
  private readonly templates: ProjectTemplate[];
  private readonly pathStats: Record<string, PathStatResult>;
  private readonly templateManifests: Record<string, TemplateManifest | null>;
  private readonly setupPreview?: SetupPreviewResponse;
  private readonly upgradePreview?: SetupPreviewResponse;
  private readonly createResult?: CreateFromTemplateResponse;
  private readonly importDryRunResult?: ImportDryRunResponse;
  private readonly importResult?: ImportProjectResponse;
  private readonly upgradeResult?: UpgradeProjectResponse;
  private readonly remoteOwners: ProjectRemoteOwner[];

  constructor(seed: InMemoryProjectsPageApiSeed = {}) {
    this.projects = seed.projects ?? { items: [] };
    this.workspaces = seed.workspaces ?? [
      {
        id: 'default',
        name: 'Default',
        isDefault: true,
        position: 0,
        projectCount: this.projects.items.length,
        deviceGrantCount: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    this.deviceGrantDeviceIds = Object.fromEntries(
      this.workspaces.map((workspace) => [
        workspace.id,
        seed.deviceGrantDeviceIds?.[workspace.id] ??
          Array.from(
            { length: workspace.deviceGrantCount },
            (_, index) => `${workspace.id}-device-${index}`,
          ),
      ]),
    );
    this.pairedDevices = seed.pairedDevices ?? [];
    this.templates = seed.templates ?? [];
    this.pathStats = seed.pathStats ?? {};
    this.templateManifests = seed.templateManifests ?? {};
    this.setupPreview = seed.setupPreview;
    this.upgradePreview = seed.upgradePreview;
    this.createResult = seed.createResult;
    this.importDryRunResult = seed.importDryRunResult;
    this.importResult = seed.importResult;
    this.upgradeResult = seed.upgradeResult;
    this.remoteOwners = seed.remoteOwners ?? [];
    this.overrides = seed.overrides ?? {};
  }

  async listProjects(): Promise<ProjectsQueryData> {
    this.calls.listProjects.push([]);
    return this.resolve(this.overrides.listProjects, [], this.projects);
  }

  async listWorkspaces(): Promise<ProjectWorkspace[]> {
    this.calls.listWorkspaces.push([]);
    return this.resolve(this.overrides.listWorkspaces, [], this.workspaces);
  }

  async listRemoteOwners(): Promise<ProjectRemoteOwner[]> {
    this.calls.listRemoteOwners.push([]);
    return this.resolve(this.overrides.listRemoteOwners, [], this.remoteOwners);
  }

  async listPairedDevices(): Promise<WorkspaceTransitionDevice[]> {
    this.calls.listPairedDevices.push([]);
    return this.resolve(this.overrides.listPairedDevices, [], this.pairedDevices);
  }

  async createWorkspace(name: string): Promise<ProjectWorkspace> {
    this.calls.createWorkspace.push([name]);
    const now = new Date().toISOString();
    const fallback: ProjectWorkspace = {
      id: `workspace-${this.workspaces.length + 1}`,
      name,
      isDefault: false,
      position: this.workspaces.length,
      projectCount: 0,
      deviceGrantCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const created = await this.resolve(this.overrides.createWorkspace, [name], fallback);
    this.workspaces = [...this.workspaces, created];
    this.deviceGrantDeviceIds[created.id] = [];
    return created;
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<ProjectWorkspace> {
    this.calls.renameWorkspace.push([workspaceId, name]);
    const current = this.requireWorkspace(workspaceId);
    const renamed = await this.resolve(this.overrides.renameWorkspace, [workspaceId, name], {
      ...current,
      name,
      updatedAt: new Date().toISOString(),
    });
    this.workspaces = this.workspaces.map((workspace) =>
      workspace.id === workspaceId ? renamed : workspace,
    );
    return renamed;
  }

  async reorderWorkspaces(workspaceIds: string[]): Promise<ProjectWorkspace[]> {
    this.calls.reorderWorkspaces.push([workspaceIds]);
    if (
      workspaceIds.length !== this.workspaces.length ||
      new Set(workspaceIds).size !== this.workspaces.length ||
      workspaceIds.some((id) => !this.workspaces.some((workspace) => workspace.id === id))
    ) {
      throw new Error('Workspace order must contain every workspace exactly once');
    }
    const fallback = workspaceIds.map((id, position) => ({
      ...this.requireWorkspace(id),
      position,
    }));
    this.workspaces = await this.resolve(
      this.overrides.reorderWorkspaces,
      [workspaceIds],
      fallback,
    );
    return this.workspaces;
  }

  async deleteWorkspace(
    workspaceId: string,
    replacementWorkspaceId: string,
  ): Promise<DeleteProjectWorkspaceResult> {
    this.calls.deleteWorkspace.push([workspaceId, replacementWorkspaceId]);
    const target = this.requireWorkspace(workspaceId);
    if (target.isDefault) throw new Error('Default workspace cannot be deleted');
    if (workspaceId === replacementWorkspaceId) throw new Error('Replacement must be different');
    this.requireWorkspace(replacementWorkspaceId);
    const movedProjectCount = this.projects.items.filter(
      (project) => project.workspaceId === workspaceId,
    ).length;
    const sourceDeviceIds = this.deviceGrantDeviceIds[workspaceId] ?? [];
    const result = await this.resolve(
      this.overrides.deleteWorkspace,
      [workspaceId, replacementWorkspaceId],
      { movedProjectCount, remappedDeviceGrantCount: sourceDeviceIds.length },
    );
    this.projects = {
      ...this.projects,
      items: this.projects.items.map((project) =>
        project.workspaceId === workspaceId
          ? { ...project, workspaceId: replacementWorkspaceId }
          : project,
      ),
    };
    const replacementDeviceIds = [
      ...new Set([
        ...(this.deviceGrantDeviceIds[replacementWorkspaceId] ?? []),
        ...sourceDeviceIds,
      ]),
    ];
    this.deviceGrantDeviceIds[replacementWorkspaceId] = replacementDeviceIds;
    delete this.deviceGrantDeviceIds[workspaceId];
    this.workspaces = this.workspaces
      .filter((workspace) => workspace.id !== workspaceId)
      .map((workspace) =>
        workspace.id === replacementWorkspaceId
          ? {
              ...workspace,
              projectCount: workspace.projectCount + movedProjectCount,
              deviceGrantCount: replacementDeviceIds.length,
            }
          : workspace,
      )
      .map((workspace, position) => ({ ...workspace, position }));
    return result;
  }

  async statPath(path: string): Promise<PathStatResult> {
    this.calls.statPath.push([path]);
    return this.resolve(
      this.overrides.statPath,
      [path],
      this.pathStats[path] ?? {
        exists: false,
        isFile: false,
      },
    );
  }

  async listTemplates(): Promise<ProjectTemplate[]> {
    this.calls.listTemplates.push([]);
    return this.resolve(this.overrides.listTemplates, [], this.templates);
  }

  async readTemplateManifest(projectId: string): Promise<TemplateManifest | null> {
    this.calls.readTemplateManifest.push([projectId]);
    return this.resolve(
      this.overrides.readTemplateManifest,
      [projectId],
      this.templateManifests[projectId] ?? null,
    );
  }

  async createFromTemplate(input: CreateFromTemplateInput): Promise<CreateFromTemplateResponse> {
    this.calls.createFromTemplate.push([input]);
    return this.resolveRequired(
      this.overrides.createFromTemplate,
      [input],
      this.createResult,
      'create result',
    );
  }

  async updateProject(
    projectId: string,
    input: UpdateProjectInput,
  ): Promise<UpdateProjectResponse> {
    this.calls.updateProject.push([projectId, input]);
    const project = this.projects.items.find((item) => item.id === projectId);
    const fallback = project
      ? { project: { ...project, ...input }, provisioningWarnings: [] }
      : undefined;
    const result = await this.resolveRequired(
      this.overrides.updateProject,
      [projectId, input],
      fallback,
      'update result',
    );
    this.projects = {
      ...this.projects,
      items: this.projects.items.map((item) =>
        item.id === projectId ? { ...item, ...result.project } : item,
      ),
    };
    if (project && result.project.workspaceId !== project.workspaceId) {
      this.workspaces = this.workspaces.map((workspace) => {
        if (workspace.id === project.workspaceId) {
          return { ...workspace, projectCount: Math.max(0, workspace.projectCount - 1) };
        }
        if (workspace.id === result.project.workspaceId) {
          return { ...workspace, projectCount: workspace.projectCount + 1 };
        }
        return workspace;
      });
    }
    return result;
  }

  async deleteProject(projectId: string): Promise<void> {
    this.calls.deleteProject.push([projectId]);
    await this.resolve(this.overrides.deleteProject, [projectId], undefined);
    this.projects = {
      ...this.projects,
      items: this.projects.items.filter((item) => item.id !== projectId),
    };
  }

  async loadSetupPreview(request: SetupPreviewRequest): Promise<SetupPreviewResponse> {
    this.calls.loadSetupPreview.push([request]);
    return this.resolveRequired(
      this.overrides.loadSetupPreview,
      [request],
      this.setupPreview,
      'setup preview',
    );
  }

  async loadUpgradePreview(
    projectId: string,
    targetVersion: string,
  ): Promise<SetupPreviewResponse> {
    this.calls.loadUpgradePreview.push([projectId, targetVersion]);
    return this.resolveRequired(
      this.overrides.loadUpgradePreview,
      [projectId, targetVersion],
      this.upgradePreview,
      'upgrade preview',
    );
  }

  async runImportDryRun(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<ImportDryRunResponse> {
    this.calls.runImportDryRun.push([projectId, input]);
    return this.resolveRequired(
      this.overrides.runImportDryRun,
      [projectId, input],
      this.importDryRunResult,
      'import dry-run result',
    );
  }

  async commitImport(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<ImportProjectResponse> {
    this.calls.commitImport.push([projectId, input]);
    return this.resolveRequired(
      this.overrides.commitImport,
      [projectId, input],
      this.importResult,
      'import result',
    );
  }

  async commitUpgrade(
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<UpgradeProjectResponse> {
    this.calls.commitUpgrade.push([projectId, input]);
    return this.resolveRequired(
      this.overrides.commitUpgrade,
      [projectId, input],
      this.upgradeResult,
      'upgrade result',
    );
  }

  private async resolve<TArgs extends unknown[], TResult>(
    override: Override<TArgs, TResult> | undefined,
    args: TArgs,
    fallback: TResult,
  ): Promise<TResult> {
    if (override === undefined) return fallback;
    if (override instanceof Error) throw override;
    if (typeof override === 'function') {
      return (override as (...values: TArgs) => TResult | Promise<TResult>)(...args);
    }
    return override;
  }

  private requireWorkspace(workspaceId: string): ProjectWorkspace {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);
    return workspace;
  }

  private resolveRequired<TArgs extends unknown[], TResult>(
    override: Override<TArgs, TResult> | undefined,
    args: TArgs,
    fallback: TResult | undefined,
    label: string,
  ): Promise<TResult> {
    if (fallback === undefined && override === undefined) {
      return Promise.reject(new Error(`No ${label} configured`));
    }
    return this.resolve(override, args, fallback as TResult);
  }
}
