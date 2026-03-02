import { isLessThan, isValidSemVer, type ManifestData } from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import type { SettingsService } from '../../settings/services/settings.service';
import type { UnifiedTemplateService } from '../../registry/services/unified-template.service';

const logger = createLogger('ProjectsService');

interface ManifestDeps {
  settings: SettingsService;
  unifiedTemplateService: UnifiedTemplateService;
}

export async function getTemplateManifestForProjectWithHelper(
  projectId: string,
  deps: ManifestDeps,
): Promise<ManifestData | null> {
  const metadata = deps.settings.getProjectTemplateMetadata(projectId);
  if (!metadata?.templateSlug) {
    logger.debug({ projectId }, 'No template metadata for project');
    return null;
  }

  try {
    if (metadata.source === 'file') {
      logger.debug(
        { projectId, templateSlug: metadata.templateSlug },
        'File-based template - no manifest available',
      );
      return null;
    }

    if (metadata.source === 'bundled') {
      const template = deps.unifiedTemplateService.getBundledTemplate(metadata.templateSlug);
      return (template.content as { _manifest?: ManifestData })._manifest ?? null;
    }

    const template = await deps.unifiedTemplateService.getTemplate(
      metadata.templateSlug,
      metadata.installedVersion ?? undefined,
    );

    if (template.source !== 'registry') {
      logger.debug(
        {
          projectId,
          templateSlug: metadata.templateSlug,
          expectedSource: 'registry',
          actualSource: template.source,
        },
        'Template source mismatch - registry template not available, rejecting bundled fallback',
      );
      return null;
    }

    return (template.content as { _manifest?: ManifestData })._manifest ?? null;
  } catch (error) {
    logger.debug(
      { projectId, templateSlug: metadata.templateSlug, error },
      'Failed to fetch template manifest for project',
    );
    return null;
  }
}

export function getBundledUpgradeVersionWithHelper(
  templateSlug: string,
  installedVersion: string | null,
  unifiedTemplateService: Pick<UnifiedTemplateService, 'getBundledTemplate'>,
): string | null {
  if (!installedVersion) {
    return null;
  }

  try {
    const bundled = unifiedTemplateService.getBundledTemplate(templateSlug);
    const manifest = (bundled.content as { _manifest?: { version?: string } })._manifest;
    const bundledVersion = manifest?.version;

    if (!bundledVersion) {
      return null;
    }

    if (!isValidSemVer(installedVersion) || !isValidSemVer(bundledVersion)) {
      logger.warn(
        { templateSlug, installedVersion, bundledVersion },
        'Invalid semver version detected, skipping upgrade check',
      );
      return null;
    }

    if (isLessThan(installedVersion, bundledVersion)) {
      return bundledVersion;
    }

    return null;
  } catch {
    return null;
  }
}

export function getBundledUpgradesForProjectsWithHelper(
  projects: Array<{
    projectId: string;
    templateSlug: string | null;
    installedVersion: string | null;
    source: 'bundled' | 'registry' | 'file' | null;
  }>,
  unifiedTemplateService: Pick<UnifiedTemplateService, 'getBundledTemplate'>,
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  const bundledVersionCache = new Map<string, string | null>();

  for (const project of projects) {
    if (project.source !== 'bundled' || !project.templateSlug) {
      result.set(project.projectId, null);
      continue;
    }

    if (!bundledVersionCache.has(project.templateSlug)) {
      try {
        const bundled = unifiedTemplateService.getBundledTemplate(project.templateSlug);
        const manifest = (bundled.content as { _manifest?: { version?: string } })._manifest;
        bundledVersionCache.set(project.templateSlug, manifest?.version ?? null);
      } catch {
        bundledVersionCache.set(project.templateSlug, null);
      }
    }

    const bundledVersion = bundledVersionCache.get(project.templateSlug);
    if (!bundledVersion || !project.installedVersion) {
      result.set(project.projectId, null);
      continue;
    }

    if (!isValidSemVer(project.installedVersion) || !isValidSemVer(bundledVersion)) {
      logger.warn(
        {
          projectId: project.projectId,
          templateSlug: project.templateSlug,
          installedVersion: project.installedVersion,
          bundledVersion,
        },
        'Invalid semver version detected, skipping upgrade check',
      );
      result.set(project.projectId, null);
      continue;
    }

    if (isLessThan(project.installedVersion, bundledVersion)) {
      result.set(project.projectId, bundledVersion);
    } else {
      result.set(project.projectId, null);
    }
  }

  return result;
}
