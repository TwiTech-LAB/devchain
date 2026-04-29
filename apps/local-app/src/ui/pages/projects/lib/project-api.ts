import type { ManifestData } from '@devchain/shared';
import type { FamilyAlternative } from '@/ui/components/project/ProviderMappingModal';

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

export interface CreateFromTemplateResponse {
  success: boolean;
  project?: { id: string; name: string };
  message?: string;
  warnings?: Array<{
    type: 'provider_mismatch';
    originalProvider: string;
    substituteProvider: string;
    agentNames: string[];
  }>;
  providerMappingRequired?: {
    missingProviders: string[];
    familyAlternatives: FamilyAlternative[];
    canImport: boolean;
  };
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
