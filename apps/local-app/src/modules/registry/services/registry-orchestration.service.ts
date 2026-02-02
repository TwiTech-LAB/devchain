import { Injectable, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { RegistryClientService } from './registry-client.service';
import { TemplateCacheService } from './template-cache.service';
import { SettingsService } from '../../settings/services/settings.service';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProjectsService } from '../../projects/services/projects.service';

const logger = createLogger('RegistryOrchestrationService');

export interface CreateFromRegistryInput {
  slug: string;
  version: string;
  projectName: string;
  projectDescription?: string;
  rootPath: string;
}

export interface CreateFromRegistryResult {
  project: {
    id: string;
    name: string;
    rootPath: string;
  };
  fromRegistry: true;
  templateSlug: string;
  templateVersion: string;
  imported: {
    prompts: number;
    profiles: number;
    agents: number;
    statuses: number;
  };
}

/**
 * Orchestration service for registry operations
 * Coordinates between registry client, cache, and project creation
 */
@Injectable()
export class RegistryOrchestrationService {
  constructor(
    private readonly registryClient: RegistryClientService,
    private readonly cacheService: TemplateCacheService,
    private readonly settingsService: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => ProjectsService))
    private readonly projectsService: ProjectsService,
  ) {}

  /**
   * Download template to local cache if not already cached
   */
  async downloadToCache(slug: string, version: string): Promise<void> {
    // Check if already cached
    if (this.cacheService.isCached(slug, version)) {
      logger.debug({ slug, version }, 'Template already cached');
      return;
    }

    logger.info({ slug, version }, 'Downloading template from registry');

    // Download from registry
    const result = await this.registryClient.downloadTemplate(slug, version);

    // Calculate content size
    const contentStr = JSON.stringify(result.content);
    const size = Buffer.byteLength(contentStr, 'utf-8');

    // Save to cache
    await this.cacheService.saveTemplate(slug, version, result.content, {
      cachedAt: new Date().toISOString(),
      checksum: result.checksum,
      size,
    });

    logger.info({ slug, version, checksum: result.checksum }, 'Template cached');
  }

  /**
   * Create a new project from a registry template
   *
   * Flow:
   * 1. Download template to cache if not cached
   * 2. Load template from cache
   * 3. Validate template format
   * 4. Create bare project
   * 5. Import template content into project
   * 6. Track registry metadata
   */
  async createProjectFromRegistry(
    input: CreateFromRegistryInput,
  ): Promise<CreateFromRegistryResult> {
    const { slug, version, projectName, projectDescription, rootPath } = input;

    logger.info({ slug, version, projectName, rootPath }, 'Creating project from registry');

    // 1. Ensure template is cached
    await this.downloadToCache(slug, version);

    // 2. Get template from cache
    const cached = await this.cacheService.getTemplate(slug, version);
    if (!cached) {
      throw new BadRequestException({
        message: 'Template not found in cache after download',
        slug,
        version,
      });
    }

    // 3. Validate template has expected structure (basic check)
    const templateContent = cached.content as Record<string, unknown>;
    if (!templateContent || typeof templateContent !== 'object') {
      throw new BadRequestException({
        message: 'Invalid template format',
        hint: 'Template content is not a valid object',
      });
    }

    // 4. Create bare project
    const project = await this.storage.createProject({
      name: projectName,
      description: projectDescription ?? null,
      rootPath,
      isTemplate: false,
    });

    logger.info({ projectId: project.id }, 'Created bare project');

    // 5. Import template content into project
    let importResult: {
      prompts: number;
      profiles: number;
      agents: number;
      statuses: number;
    } = { prompts: 0, profiles: 0, agents: 0, statuses: 0 };

    try {
      const importResponse = await this.projectsService.importProject({
        projectId: project.id,
        payload: templateContent,
        dryRun: false,
      });

      // Extract counts from import response
      if (importResponse && typeof importResponse === 'object' && 'imported' in importResponse) {
        const imported = importResponse.imported as Record<string, number>;
        importResult = {
          prompts: imported.prompts ?? 0,
          profiles: imported.profiles ?? 0,
          agents: imported.agents ?? 0,
          statuses: imported.statuses ?? 0,
        };
      }

      logger.info({ projectId: project.id, importResult }, 'Template content imported');
    } catch (error) {
      // Log error but don't fail - project is created, import can be retried
      logger.error(
        { projectId: project.id, error: error instanceof Error ? error.message : String(error) },
        'Failed to import template content, project created but template not applied',
      );

      // Re-throw if it's a provider issue (user needs to know)
      if (error instanceof BadRequestException) {
        const errorResponse = (error as BadRequestException).getResponse() as Record<
          string,
          unknown
        >;
        if (errorResponse?.missingProviders) {
          throw error;
        }
      }
    }

    // 6. Track registry metadata
    await this.settingsService.setProjectTemplateMetadata(project.id, {
      templateSlug: slug,
      installedVersion: version,
      registryUrl: this.settingsService.getRegistryConfig().url,
      installedAt: new Date().toISOString(),
    });

    // 7. Persist presets from template (if present)
    // Presets are stored at the root level of the template content
    if (
      templateContent.presets &&
      Array.isArray(templateContent.presets) &&
      templateContent.presets.length > 0
    ) {
      try {
        await this.settingsService.setProjectPresets(project.id, templateContent.presets);
        logger.info(
          { projectId: project.id, presetCount: templateContent.presets.length },
          'Presets persisted from template',
        );
      } catch (error) {
        // Log error but don't fail - presets are nice-to-have, project is already created
        logger.warn(
          { projectId: project.id, error: error instanceof Error ? error.message : String(error) },
          'Failed to persist presets from template',
        );
      }
    }

    logger.info({ projectId: project.id, slug, version }, 'Project created from registry template');

    return {
      project: {
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
      },
      fromRegistry: true,
      templateSlug: slug,
      templateVersion: version,
      imported: importResult,
    };
  }

  /**
   * Check if a specific template version is cached locally
   */
  isCached(slug: string, version: string): boolean {
    return this.cacheService.isCached(slug, version);
  }

  /**
   * Get template content from cache (if cached)
   */
  async getFromCache(slug: string, version: string) {
    return this.cacheService.getTemplate(slug, version);
  }

  /**
   * Check for available updates for a project's linked template
   */
  async checkForUpdates(
    projectId: string,
  ): Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion: string } | null> {
    const metadata = this.settingsService.getProjectTemplateMetadata(projectId);
    if (!metadata) {
      return null;
    }

    try {
      const template = await this.registryClient.getTemplate(metadata.templateSlug);
      if (!template) {
        return null;
      }

      const latestVersion = template.versions.find((v) => v.isLatest);
      if (!latestVersion) {
        return null;
      }

      // Update last check timestamp
      await this.settingsService.updateLastUpdateCheck(projectId);

      // Bundled templates don't have versions, so no updates possible
      if (!metadata.installedVersion) {
        return null;
      }

      return {
        hasUpdate: metadata.installedVersion !== latestVersion.version,
        currentVersion: metadata.installedVersion,
        latestVersion: latestVersion.version,
      };
    } catch (error) {
      logger.warn(
        { projectId, templateSlug: metadata.templateSlug, error },
        'Failed to check for updates',
      );
      return null;
    }
  }
}
