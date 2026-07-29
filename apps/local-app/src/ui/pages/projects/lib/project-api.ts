import type { ExportData, ManifestData } from '@devchain/shared';
import type { FamilyAlternative } from '@/ui/components/project/ProviderMappingModal';
import type { PromptTransferCounts } from '@/common/prompt-transfer';
import type { PromptReferenceValidationFailure } from '@/common/prompt-references';

/** Per-agent config override sent to the create/import endpoints. */
export interface AgentOverridePayload {
  agentName: string;
  providerConfigName: string;
  modelOverride?: string | null;
  effortOverride?: string | null;
}

/** One referenced provider, annotated with families, agent count, and local availability. */
export interface SetupPreviewProviderSummary {
  name: string;
  available: boolean;
  families: string[];
  agentCount: number;
}

export interface SetupPreviewFamilyAlternative {
  familySlug: string;
  defaultProvider: string;
  defaultProviderAvailable: boolean;
  availableProviders: string[];
  hasAlternatives: boolean;
}

export interface SetupPreviewPresetCoverage {
  presetName: string;
  referencedProviders: string[];
  coversAllAgents: boolean;
  coveredAgentNames: string[];
  agentResolvedProviders: Record<string, string>;
}

/** Response of POST /api/projects/setup-preview. Fetched once per wizard session. */
export interface SetupPreviewResponse {
  payload: ExportData;
  providerSummary: SetupPreviewProviderSummary[];
  familyAlternatives: SetupPreviewFamilyAlternative[];
  presetProviderCoverage: SetupPreviewPresetCoverage[];
  localAvailability: { installedProviders: Array<{ id: string; name: string }> };
}

/** Exactly one of {slug(+version) | templatePath | rawContent} must be provided. */
export interface SetupPreviewRequest {
  slug?: string;
  version?: string | null;
  templatePath?: string;
  rawContent?: Record<string, unknown>;
}

export async function fetchSetupPreview(body: SetupPreviewRequest): Promise<SetupPreviewResponse> {
  const res = await fetch('/api/projects/setup-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to load template preview' }));
    throw new Error(error.message || 'Failed to load template preview');
  }
  return res.json();
}

export interface TemplateMetadata {
  slug: string;
  version: string | null;
  source: 'bundled' | 'registry' | 'file';
}

export interface Project {
  id: string;
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

export interface ProjectTemplate {
  slug: string;
  name: string;
  source: 'bundled' | 'registry' | 'file';
  versions: string[] | null;
  latestVersion: string | null;
}

export interface ProvisioningWarning {
  providerId: string;
  providerName: string;
  level: 'warn' | 'error';
  message: string;
  code?: string;
}

export type ProjectPromptReferenceFailure = PromptReferenceValidationFailure;

export function isProjectPromptReferenceFailure(
  value: unknown,
): value is ProjectPromptReferenceFailure {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProjectPromptReferenceFailure>;
  return (
    candidate.success === false &&
    candidate.mutationStarted === false &&
    candidate.promptReferenceValidation?.code === 'skipped_prompt_references' &&
    Array.isArray(candidate.promptReferenceValidation.promptTitles) &&
    Array.isArray(candidate.promptReferenceValidation.issues)
  );
}

export function formatProjectPromptReferenceFailure(
  failure: ProjectPromptReferenceFailure,
): string {
  const details = failure.promptReferenceValidation.issues
    .map(
      ({ promptTitle, profileNames }) =>
        `"${promptTitle}" (${profileNames.length > 0 ? `profiles: ${profileNames.join(', ')}` : 'referenced by a profile'})`,
    )
    .join('; ');
  return details ? `${failure.error}. ${details}` : failure.error;
}

export interface ProviderMismatchWarning {
  type: 'provider_mismatch';
  originalProvider: string;
  substituteProvider: string;
  agentNames: string[];
}

export interface CreateFromTemplateSuccess {
  success: true;
  project: { id: string; name: string };
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
  missingProviders: string[];
  unmatchedStatuses?: Array<{ id: string; label: string; color: string; epicCount: number }>;
  templateStatuses?: Array<{ label: string; color: string }>;
  counts: { toImport: Record<string, number>; toDelete: Record<string, number> };
  promptTransfer?: PromptTransferCounts;
}

export type ImportDryRunResponse = ImportDryRunSuccess | ProjectPromptReferenceFailure;

export interface ImportProjectSuccess {
  success: true;
  counts: { imported: Record<string, number>; deleted: Record<string, number> };
  mappings: Record<string, Record<string, string>>;
  initialPromptSet?: boolean;
  message?: string;
  provisioningWarnings?: ProvisioningWarning[];
  promptTransfer?: PromptTransferCounts;
}

export type ImportProjectResponse = ImportProjectSuccess | ProjectPromptReferenceFailure;

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
}

export type UpgradeProjectResponse = UpgradeProjectSuccess | UpgradeProjectFailure;

export interface UpdateProjectResponse {
  project: Project;
  provisioningWarnings: ProvisioningWarning[];
}

export async function fetchProjects(): Promise<ProjectsQueryData> {
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
        // Ignore stats fetch errors
      }
      return project;
    }),
  );

  return { ...data, items: projectsWithStats };
}

export async function validatePath(path: string): Promise<{ exists: boolean; error?: string }> {
  try {
    const res = await fetch('/api/fs/stat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (res.ok) {
      return { exists: true };
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
}

export async function fetchTemplates(): Promise<ProjectTemplate[]> {
  const res = await fetch('/api/templates');
  if (!res.ok) throw new Error('Failed to fetch templates');
  const data = await res.json();
  return data.templates.map(
    (t: {
      slug: string;
      name: string;
      source: 'bundled' | 'registry' | 'file';
      versions: string[] | null;
      latestVersion: string | null;
    }) => ({
      slug: t.slug,
      name: t.name,
      source: t.source,
      versions: t.versions,
      latestVersion: t.latestVersion,
    }),
  );
}

export async function fetchTemplateManifest(
  projectId: string,
): Promise<Partial<ManifestData> | null> {
  try {
    const res = await fetch(`/api/projects/${projectId}/template-manifest`);
    if (!res.ok) return null;
    return (await res.json()) as Partial<ManifestData> | null;
  } catch {
    return null;
  }
}

export async function createProjectFromTemplate(data: {
  name: string;
  description?: string;
  rootPath: string;
  templateId?: string;
  templatePath?: string;
  version?: string;
  familyProviderMappings?: Record<string, string>;
  presetName?: string;
  /** Per-agent config overrides. Mutually exclusive with presetName. */
  agentOverrides?: AgentOverridePayload[];
  /** Transient provider choice metadata (Step-1 wizard selection). */
  selectedProviderNames?: string[];
  teamOverrides?: Array<{
    teamName: string;
    allowTeamLeadCreateAgents?: boolean;
    maxMembers?: number;
    maxConcurrentTasks?: number;
    profileNames?: string[];
    profileSelections?: Array<{
      profileName: string;
      configNames: string[];
    }>;
  }>;
}): Promise<CreateFromTemplateResponse> {
  const payload = {
    ...data,
    version: data.version || null,
  };
  const res = await fetch('/api/projects/from-template', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res
      .json()
      .catch(() => ({ message: 'Failed to create project from template' }));
    throw new Error(error.message || 'Failed to create project from template');
  }
  return res.json();
}

export async function updateProject(id: string, data: Partial<Project>) {
  const res = await fetch(`/api/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update project' }));
    throw new Error(error.message || 'Failed to update project');
  }
  return res.json();
}

export async function deleteProject(id: string) {
  const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete project' }));
    throw new Error(error.message || 'Failed to delete project');
  }
}
