import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { RegistryClientService } from '../../registry/services/registry-client.service';
import { TemplateCacheService } from '../../registry/services/template-cache.service';
import { ProjectsService } from './projects.service';

const logger = createLogger('ProjectRegistryImportService');

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
 * Projects-owned workflow for creating a project from a Registry template.
 */
@Injectable()
export class ProjectRegistryImportService {
  constructor(
    private readonly registryClient: RegistryClientService,
    private readonly cacheService: TemplateCacheService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly projectsService: ProjectsService,
    private readonly settingsService: SettingsService,
  ) {}

  async createProjectFromRegistry(
    input: CreateFromRegistryInput,
  ): Promise<CreateFromRegistryResult> {
    const { slug, version, projectName, projectDescription, rootPath } = input;

    logger.info({ slug, version, projectName, rootPath }, 'Creating project from registry');

    await this.downloadToCache(slug, version);

    const cached = await this.cacheService.getTemplate(slug, version);
    if (!cached) {
      throw new BadRequestException({
        message: 'Template not found in cache after download',
        slug,
        version,
      });
    }

    const templateContent = cached.content as Record<string, unknown>;
    if (!templateContent || typeof templateContent !== 'object') {
      throw new BadRequestException({
        message: 'Invalid template format',
        hint: 'Template content is not a valid object',
      });
    }

    const project = await this.storage.createProject({
      name: projectName,
      description: projectDescription ?? null,
      rootPath,
      isTemplate: false,
    });

    logger.info({ projectId: project.id }, 'Created bare project');

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
      logger.error(
        { projectId: project.id, error: error instanceof Error ? error.message : String(error) },
        'Failed to import template content, project created but template not applied',
      );

      if (error instanceof BadRequestException) {
        const errorResponse = error.getResponse() as Record<string, unknown>;
        if (errorResponse?.missingProviders) {
          throw error;
        }
      }
    }

    await this.settingsService.setProjectTemplateMetadata(project.id, {
      templateSlug: slug,
      installedVersion: version,
      registryUrl: this.settingsService.getRegistryConfig().url,
      installedAt: new Date().toISOString(),
    });

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

  private async downloadToCache(slug: string, version: string): Promise<void> {
    if (this.cacheService.isCached(slug, version)) {
      logger.debug({ slug, version }, 'Template already cached');
      return;
    }

    logger.info({ slug, version }, 'Downloading template from registry');

    const result = await this.registryClient.downloadTemplate(slug, version);
    const contentStr = JSON.stringify(result.content);
    const size = Buffer.byteLength(contentStr, 'utf-8');

    await this.cacheService.saveTemplate(slug, version, result.content, {
      cachedAt: new Date().toISOString(),
      checksum: result.checksum,
      size,
    });

    logger.info({ slug, version, checksum: result.checksum }, 'Template cached');
  }
}
