import type { RefObject } from 'react';
import type { ProjectSetupWizardController } from '@/ui/hooks/useProjectSetupWizard';
import type {
  FamilyAlternative,
  ImportProjectSuccess,
  ProjectTemplate,
  ProjectWorkspace,
  ProviderMismatchWarning,
  TemplateManifest,
  UpgradeProjectResponse,
} from './lib/project-contracts';
import type { WorkspaceTransitionDevice } from './lib/projects-page-api';
import type { WorkspaceIdentity } from '@/ui/lib/workspace-identity';

export type ProjectsSortField = 'name' | 'rootPath' | 'createdAt';
export type ProjectsSortOrder = 'asc' | 'desc';

export interface ProjectsTableDragModel {
  readonly projectId: string | null;
  readonly sourceWorkspaceId: string | null;
  readonly targetWorkspaceId: string | null;
  readonly start: (projectId: string, sourceWorkspaceId: string) => void;
  readonly enterWorkspace: (workspaceId: string) => void;
  readonly leaveWorkspace: (workspaceId: string) => void;
  readonly dropOnWorkspace: (workspaceId: string) => void;
  readonly end: () => void;
}

export interface ProjectTableRowModel {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly description: string | null;
  readonly isTemplate: boolean;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly epicsCount: number;
  readonly agentsCount: number;
  readonly template: {
    readonly slug: string;
    readonly source: ProjectTemplate['source'];
    readonly version: string | null;
    readonly upgradeVersion: string | null;
  } | null;
  readonly open: () => void;
  readonly edit: () => void;
  readonly requestDelete: () => void;
  readonly startImport: () => void;
  readonly export: () => void;
  readonly configure?: () => void;
  readonly upgrade?: () => void;
  readonly actionsButtonId: string;
  /** Set while a remote owns the project: delete, move, import and upgrade are refused. */
  readonly remoteLock: { readonly message: string } | null;
  readonly moveTargets: ReadonlyArray<{
    readonly workspaceId: string;
    readonly workspaceName: string;
    readonly requestMove: () => void;
  }>;
}

export interface ProjectWorkspaceGroupModel {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly position: number;
  readonly projectCount: number;
  readonly visibleMatchCount: number;
  readonly isExpanded: boolean;
  readonly canToggle: boolean;
  readonly identity: WorkspaceIdentity;
  readonly rows: ProjectTableRowModel[];
  readonly emptyState: 'none' | 'workspace-empty' | 'scoped' | 'no-matches';
  readonly toggleExpanded: () => void;
  readonly openCreate: () => void;
  readonly rename: () => void;
  readonly moveUp?: () => void;
  readonly moveDown?: () => void;
  readonly requestDelete?: () => void;
}

export type ProjectsTableContent =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'unavailable';
      readonly failedData: ReadonlyArray<'projects' | 'workspaces'>;
      readonly retry: () => void;
    }
  | {
      readonly kind: 'ready';
      readonly groups: ProjectWorkspaceGroupModel[];
      readonly searchActive: boolean;
    };

export interface TemplateUpdateNoticeItem {
  readonly projectId: string;
  readonly projectName: string;
  readonly slug: string;
  readonly currentVersion: string | null;
  readonly targetVersion: string;
  readonly update?: () => void;
  readonly lockMessage: string | null;
}

export interface TemplateUpdateNoticeModel {
  readonly items: TemplateUpdateNoticeItem[];
  readonly closeUntilRestart: () => void;
  readonly dismissUntilNewItems: () => void;
}

export interface ProjectsTableModel {
  readonly notice: TemplateUpdateNoticeModel | null;
  readonly search: string;
  readonly changeSearch: (value: string) => void;
  readonly sortField: ProjectsSortField;
  readonly sortOrder: ProjectsSortOrder;
  readonly toggleSort: (field: ProjectsSortField) => void;
  readonly openCreate: () => void;
  readonly openCreateInWorkspace: (workspaceId: string) => void;
  readonly requestProjectMove: (projectId: string, workspaceId: string) => void;
  readonly openCreateWorkspace: () => void;
  readonly statusMessage: string;
  readonly drag: ProjectsTableDragModel;
  readonly content: ProjectsTableContent;
}

export interface EditProjectFormData {
  name: string;
  description: string;
  rootPath: string;
  isTemplate: boolean;
}

export interface ProjectPathValidation {
  isAbsolute: boolean;
  exists: boolean;
  checked: boolean;
}

export interface CreateProjectFormData {
  name: string;
  description: string;
  rootPath: string;
  templateId: string;
  version: string;
  templatePath: string;
  workspaceId: string;
}

export interface CreateProjectFilePathValidation extends ProjectPathValidation {
  isFile: boolean;
  error?: string;
}

export interface ProjectWizardModel {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly controller: ProjectSetupWizardController;
  readonly title: string;
  readonly description: string;
  readonly submitLabel: string;
  readonly isLoading: boolean;
  readonly isSubmitting: boolean;
  readonly errorMessage?: string;
}

export interface ProjectsEditDialogModel {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly values: EditProjectFormData;
  readonly pathValidation: ProjectPathValidation;
  readonly changeName: (value: string) => void;
  readonly changeDescription: (value: string) => void;
  readonly changeRootPath: (value: string) => void;
  readonly changeIsTemplate: (value: boolean) => void;
  readonly submit: () => void;
  readonly cancel: () => void;
  readonly isSubmitting: boolean;
}

export interface ProjectsDeleteDialogModel {
  readonly open: boolean;
  readonly projectName?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly confirm: () => void;
  readonly isDeleting: boolean;
}

export interface ProjectsCreateSourceModel {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly submit: () => void;
  readonly sourceTab: 'template' | 'file';
  readonly changeSourceTab: (value: 'template' | 'file') => void;
  readonly values: CreateProjectFormData;
  readonly changeName: (value: string) => void;
  readonly changeDescription: (value: string) => void;
  readonly changeVersion: (value: string) => void;
  readonly workspaces: ProjectWorkspace[];
  readonly showWorkspaceSelector: boolean;
  readonly changeWorkspace: (workspaceId: string) => void;
  readonly templates?: ProjectTemplate[];
  readonly selectedTemplateSource?: ProjectTemplate['source'];
  readonly sortedVersions: string[];
  readonly selectTemplate: (slug: string) => void;
  readonly changeRootPath: (path: string) => void;
  readonly changeTemplateFilePath: (path: string) => void;
  readonly pathValidation: ProjectPathValidation;
  readonly filePathValidation: CreateProjectFilePathValidation;
  readonly cancel: () => void;
  readonly isSubmitting: boolean;
}

export interface ProjectsProviderMappingModel {
  readonly open: boolean;
  readonly missingProviders: string[];
  readonly familyAlternatives: FamilyAlternative[];
  readonly canImport: boolean;
  readonly confirm: (mappings: Record<string, string>) => void;
  readonly cancel: () => void;
  readonly isSubmitting: boolean;
}

export interface ProjectsProviderWarningModel {
  readonly open: boolean;
  readonly warnings: ProviderMismatchWarning[];
  readonly navigate: (destination: '/chat' | '/board') => void;
}

export interface ProjectsCreateDialogModel {
  readonly source: ProjectsCreateSourceModel;
  readonly wizard: ProjectWizardModel;
  readonly providerMapping: ProjectsProviderMappingModel | null;
  readonly warning: ProjectsProviderWarningModel;
}

export interface ProjectsImportSourceModel {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly targetName?: string;
  readonly selectedTemplateId: string;
  readonly selectTemplate: (slug: string) => void;
  readonly templates?: ProjectTemplate[];
  readonly selectedTemplateSource?: ProjectTemplate['source'];
  readonly sortedVersions: string[];
  readonly selectedVersion: string;
  readonly selectVersion: (version: string) => void;
  readonly importTemplate: () => void;
  readonly openFilePicker: () => void;
  readonly isImporting: boolean;
}

export interface ProjectsImportDialogModel {
  readonly fileInputRef: RefObject<HTMLInputElement>;
  readonly selectFile: (file: File | undefined) => void;
  readonly source: ProjectsImportSourceModel;
  readonly wizard: ProjectWizardModel;
  readonly result: ImportProjectSuccess | null;
  readonly closeResult: () => void;
}

export interface ProjectsUpgradeResultModel {
  readonly projectId: string;
  readonly projectName: string;
  readonly targetVersion: string;
  readonly source: ProjectTemplate['source'];
  readonly result: UpgradeProjectResponse;
  readonly close: () => void;
}

export interface ProjectsUpgradeDialogModel {
  readonly wizard: ProjectWizardModel;
  readonly result: ProjectsUpgradeResultModel | null;
}

export interface ProjectsExportDialogModel {
  readonly projectId: string;
  readonly projectName: string;
  readonly existingManifest?: TemplateManifest;
  readonly close: () => void;
}

export interface ProjectsConfigurationDialogModel {
  readonly projectId: string;
  readonly close: () => void;
}

export interface ProjectsWorkspaceDialogsModel {
  readonly create: {
    readonly open: boolean;
    readonly name: string;
    readonly changeName: (name: string) => void;
    readonly onOpenChange: (open: boolean) => void;
    readonly submit: () => void;
    readonly isSubmitting: boolean;
    readonly secondWorkspaceImpact: {
      readonly required: boolean;
      readonly devices: ReadonlyArray<WorkspaceTransitionDevice>;
      readonly isLoading: boolean;
      readonly error: string | null;
    };
  };
  readonly rename: {
    readonly open: boolean;
    readonly name: string;
    readonly changeName: (name: string) => void;
    readonly onOpenChange: (open: boolean) => void;
    readonly submit: () => void;
    readonly isSubmitting: boolean;
  };
  readonly delete: {
    readonly open: boolean;
    readonly workspaceName?: string;
    readonly projectCount: number;
    readonly deviceGrantCount: number;
    readonly replacementWorkspaceId: string;
    readonly replacementOptions: ProjectWorkspace[];
    readonly changeReplacement: (workspaceId: string) => void;
    readonly onOpenChange: (open: boolean) => void;
    readonly confirm: () => void;
    readonly isDeleting: boolean;
  };
}

export interface ProjectsDialogsModel {
  readonly edit: ProjectsEditDialogModel;
  readonly move: {
    readonly open: boolean;
    readonly projectName?: string;
    readonly sourceWorkspaceName?: string;
    readonly destinationWorkspaceName?: string;
    readonly pairedDeviceImpact: {
      readonly devices: ReadonlyArray<WorkspaceTransitionDevice>;
      readonly isLoading: boolean;
      readonly unavailable: boolean;
    };
    readonly onOpenChange: (open: boolean) => void;
    readonly confirm: () => void;
    readonly isMoving: boolean;
  };
  readonly delete: ProjectsDeleteDialogModel;
  readonly create: ProjectsCreateDialogModel;
  readonly import: ProjectsImportDialogModel;
  readonly upgrade: ProjectsUpgradeDialogModel;
  readonly export: ProjectsExportDialogModel | null;
  readonly configuration: ProjectsConfigurationDialogModel | null;
  readonly workspaces: ProjectsWorkspaceDialogsModel;
}

export function projectActionsButtonId(projectId: string): string {
  return `project-actions-${projectId}`;
}

export interface ProjectsPagePresentation {
  readonly table: ProjectsTableModel;
  readonly dialogs: ProjectsDialogsModel;
}
