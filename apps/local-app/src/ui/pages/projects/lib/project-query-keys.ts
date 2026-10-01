import type { SetupPreviewRequest } from '@/ui/pages/projects/lib/project-contracts';

export const projectsQueryKeys = {
  all: () => ['projects'] as const,
  list: () => ['projects', 'manage'] as const,
  available: (workspaceId: string | undefined) => ['projects', 'available', workspaceId] as const,
  /** Every project of every workspace in one page (the Remote VMs page). */
  allWorkspaces: () => ['projects', 'all-workspaces'] as const,
  /** Shared with project selection and the Projects page, which spell it `['workspaces']`. */
  workspaces: () => ['workspaces'] as const,
  detail: (selector: { id?: string; path?: string }) => ['projects', 'detail', selector] as const,
  templatesForCreate: () => ['project-templates'] as const,
  templatesForUpgrade: () => ['templates-for-upgrade'] as const,
  manifest: (projectId: string | undefined) => ['template-manifest', projectId] as const,
  setupPreview: (request: SetupPreviewRequest | null) => ['setup-preview', request] as const,
  upgradePreview: (projectId: string, version: string) =>
    ['upgrade-template-preview', projectId, version] as const,
};
