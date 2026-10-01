import type { ExportData, ManifestData } from '@devchain/shared';
import type { PromptTransferCounts } from '@/common/prompt-transfer';
import type { PromptReferenceValidationFailure } from '@/common/prompt-references';

export interface AgentOverridePayload {
  agentName: string;
  providerConfigName: string;
  modelOverride?: string | null;
  effortOverride?: string | null;
}

export interface TeamOverridePayload {
  teamName: string;
  allowTeamLeadCreateAgents?: boolean;
  maxMembers?: number;
  maxConcurrentTasks?: number;
  profileNames?: string[];
  profileSelections?: Array<{
    profileName: string;
    configNames: string[];
  }>;
}

export interface FamilyAlternative {
  familySlug: string;
  defaultProvider: string;
  defaultProviderAvailable: boolean;
  availableProviders: string[];
  hasAlternatives: boolean;
}

export interface SetupPreviewProviderSummary {
  name: string;
  available: boolean;
  families: string[];
  agentCount: number;
}

export type SetupPreviewFamilyAlternative = FamilyAlternative;

export interface SetupPreviewPresetCoverage {
  presetName: string;
  referencedProviders: string[];
  coversAllAgents: boolean;
  coveredAgentNames: string[];
  agentResolvedProviders: Record<string, string>;
}

export interface SetupPreviewResponse {
  payload: ExportData;
  providerSummary: SetupPreviewProviderSummary[];
  familyAlternatives: SetupPreviewFamilyAlternative[];
  presetProviderCoverage: SetupPreviewPresetCoverage[];
  localAvailability: { installedProviders: Array<{ id: string; name: string }> };
}

export interface SetupPreviewRequest {
  slug?: string;
  version?: string | null;
  templatePath?: string;
  rawContent?: Record<string, unknown>;
}

export interface TemplateMetadata {
  slug: string;
  version: string | null;
  source: 'bundled' | 'registry' | 'file';
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  rootPath: string;
  isTemplate?: boolean;
  isConfigurable?: boolean;
  createdAt: string;
  updatedAt: string;
  templateMetadata?: TemplateMetadata | null;
  bundledUpgradeAvailable?: string | null;
}

export interface ProjectStats {
  epicsCount: number;
  agentsCount: number;
}

export interface ProjectWithStats extends Project {
  stats?: ProjectStats;
}

export interface ProjectsQueryData {
  items: ProjectWithStats[];
  total?: number;
  limit?: number;
  offset?: number;
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

export interface DeleteProjectWorkspaceResult {
  movedProjectCount: number;
  remappedDeviceGrantCount: number;
}

export interface ProjectTemplate {
  slug: string;
  name: string;
  source: 'bundled' | 'registry' | 'file';
  versions: string[] | null;
  latestVersion: string | null;
}

export interface PathStatResult {
  exists: boolean;
  isFile: boolean;
}

export interface ProvisioningWarning {
  providerId: string;
  providerName: string;
  level: 'warn' | 'error';
  message: string;
  code?: string;
}

export type ProjectPromptReferenceFailure = PromptReferenceValidationFailure;

export type ImportReadinessIssue =
  | {
      code: 'prompt_reference_validation';
      message: string;
      details: ProjectPromptReferenceFailure['promptReferenceValidation'];
    }
  | {
      code: 'selected_providers_not_installed';
      message: string;
      details: { providerNames: string[] };
    }
  | {
      code: 'preset_not_found';
      message: string;
      details: { presetName: string };
    }
  | {
      code: 'provider_mapping_required';
      message: string;
      details: unknown;
    }
  | {
      code: 'selected_profiles_unavailable';
      message: string;
      details: { providerNames: string[] };
    }
  | {
      code: 'active_sessions';
      message: string;
      details: { activeSessions: Array<{ id: string; agentId: string | null }> };
    }
  | {
      code: 'duplicate_agent_names';
      message: string;
      details: { agentNames: string[] };
    };

export interface ImportReadiness {
  ready: boolean;
  issues: ImportReadinessIssue[];
}

export interface ProjectPreMutationFailure {
  success: false;
  mutationStarted: false;
  error: string;
  readiness?: ImportReadiness;
  promptReferenceValidation?: ProjectPromptReferenceFailure['promptReferenceValidation'];
}

export interface ProviderMismatchWarning {
  type: 'provider_mismatch';
  originalProvider: string;
  substituteProvider: string;
  agentNames: string[];
}

export interface CreateFromTemplateInput {
  name: string;
  description?: string;
  rootPath: string;
  workspaceId?: string;
  templateId?: string;
  templatePath?: string;
  version?: string;
  familyProviderMappings?: Record<string, string>;
  presetName?: string;
  agentOverrides?: AgentOverridePayload[];
  selectedProviderNames?: string[];
  teamOverrides?: TeamOverridePayload[];
}

export interface CreateFromTemplateSuccess {
  success: true;
  project: { id: string; name: string; workspaceId: string };
  message?: string;
  warnings?: ProviderMismatchWarning[];
  provisioningWarnings?: ProvisioningWarning[];
  promptTransfer?: PromptTransferCounts;
}

export interface CreateProviderMappingRequired {
  success: false;
  providerMappingRequired: {
    missingProviders: string[];
    familyAlternatives: FamilyAlternative[];
    canImport: boolean;
  };
}

export type CreateFromTemplateResponse =
  | CreateFromTemplateSuccess
  | CreateProviderMappingRequired
  | ProjectPromptReferenceFailure;

export interface ImportDryRunSuccess {
  dryRun: true;
  success?: false;
  mutationStarted?: false;
  error?: string;
  readiness?: ImportReadiness;
  promptReferenceValidation?: ProjectPromptReferenceFailure['promptReferenceValidation'];
  missingProviders: string[];
  unmatchedStatuses?: Array<{ id: string; label: string; color: string; epicCount: number }>;
  templateStatuses?: Array<{ label: string; color: string }>;
  counts: { toImport: Record<string, number>; toDelete: Record<string, number> };
  promptTransfer?: PromptTransferCounts;
}

export type ImportDryRunResponse = ImportDryRunSuccess;

export interface ImportProjectSuccess {
  success: true;
  counts: { imported: Record<string, number>; deleted: Record<string, number> };
  mappings: Record<string, Record<string, string>>;
  initialPromptSet?: boolean;
  message?: string;
  provisioningWarnings?: ProvisioningWarning[];
  promptTransfer?: PromptTransferCounts;
}

export type ImportProjectResponse = ImportProjectSuccess | ProjectPreMutationFailure;

export interface UpgradeProjectSuccess {
  success: true;
  newVersion: string;
  promptTransfer?: PromptTransferCounts;
}

export interface UpgradeProjectFailure {
  success: false;
  error?: string;
  mutationStarted?: boolean;
  promptReferenceValidation?: ProjectPromptReferenceFailure['promptReferenceValidation'];
  restored?: boolean;
  backupId?: string;
  readiness?: ImportReadiness;
}

export type UpgradeProjectResponse = UpgradeProjectSuccess | UpgradeProjectFailure;

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  rootPath?: string;
  isTemplate?: boolean;
  workspaceId?: string;
}

export interface UpdateProjectResponse {
  project: Project;
  provisioningWarnings: ProvisioningWarning[];
}

export type TemplateManifest = Partial<ManifestData>;

/** A home project whose writes belong to a remote (binding `attaching`, `remote` or `detaching`). */
export interface ProjectRemoteOwner {
  projectId: string;
  remoteId: string;
  remoteName: string | null;
  state: 'attaching' | 'remote' | 'detaching' | 'failed';
}
