import { Controller, Get, Post, Param, Query, Body, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBody } from '@nestjs/swagger';
import { RegistryClientService } from '../services/registry-client.service';
import { TemplateCacheService } from '../services/template-cache.service';
import { RegistryOrchestrationService } from '../services/registry-orchestration.service';
import { TemplateUpgradeService } from '../services/template-upgrade.service';
import { SettingsService } from '../../settings/services/settings.service';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import {
  TemplateListResponse,
  TemplateDetailResponse,
  ListTemplatesQuery,
} from '../interfaces/registry.interface';
import { RestoreBackupDto, UpgradeProjectDto } from '../dtos/registry.dto';

@ApiTags('registry')
@Controller('api/registry')
export class RegistryController {
  constructor(
    private readonly registryClient: RegistryClientService,
    private readonly cacheService: TemplateCacheService,
    private readonly orchestrationService: RegistryOrchestrationService,
    private readonly upgradeService: TemplateUpgradeService,
    private readonly settingsService: SettingsService,
    @Inject(STORAGE_SERVICE) private readonly storageService: StorageService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Check registry availability' })
  @ApiResponse({ status: 200, description: 'Registry status' })
  async getStatus(): Promise<{ available: boolean; url: string }> {
    const available = await this.registryClient.isAvailable();
    return {
      available,
      url: this.registryClient.getRegistryUrl(),
    };
  }

  @Get('templates')
  @ApiOperation({ summary: 'List templates from registry' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'tags', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false })
  @ApiQuery({ name: 'order', required: false })
  @ApiResponse({ status: 200, description: 'List of templates' })
  async listTemplates(
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('tags') tags?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sort') sort?: 'name' | 'downloads' | 'updated',
    @Query('order') order?: 'asc' | 'desc',
  ): Promise<TemplateListResponse> {
    const query: ListTemplatesQuery = {};

    if (search) query.search = search;
    if (category) query.category = category;
    if (tags) query.tags = tags.split(',').map((t) => t.trim());
    if (page) query.page = parseInt(page, 10);
    if (limit) query.limit = parseInt(limit, 10);
    if (sort) query.sort = sort;
    if (order) query.order = order;

    return this.registryClient.listTemplates(query);
  }

  @Get('templates/:slug')
  @ApiOperation({ summary: 'Get template details' })
  @ApiResponse({ status: 200, description: 'Template details' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async getTemplate(@Param('slug') slug: string): Promise<TemplateDetailResponse | null> {
    return this.registryClient.getTemplate(slug);
  }

  @Get('cache')
  @ApiOperation({ summary: 'Get cached templates info' })
  @ApiResponse({ status: 200, description: 'Cached templates list' })
  async getCacheInfo() {
    const cached = this.cacheService.listCached();
    const size = await this.cacheService.getCacheSize();

    return {
      templates: cached,
      totalSize: size,
      cacheDir: this.cacheService.getCacheDir(),
    };
  }

  @Get('cache/:slug/:version')
  @ApiOperation({ summary: 'Check if template version is cached' })
  @ApiResponse({ status: 200, description: 'Cache status' })
  async checkCached(@Param('slug') slug: string, @Param('version') version: string) {
    const isCached = this.cacheService.isCached(slug, version);
    const template = isCached ? await this.cacheService.getTemplate(slug, version) : null;

    return {
      isCached,
      metadata: template?.metadata ?? null,
    };
  }

  @Post('download/:slug/:version')
  @ApiOperation({ summary: 'Download and cache a template version' })
  @ApiResponse({ status: 200, description: 'Download result' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async downloadTemplate(@Param('slug') slug: string, @Param('version') version: string) {
    // Check if already cached
    if (this.cacheService.isCached(slug, version)) {
      return { success: true, cached: true, message: 'Already cached' };
    }

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

    return {
      success: true,
      cached: false,
      checksum: result.checksum,
      size,
    };
  }

  @Get('projects/:slug')
  @ApiOperation({ summary: 'Get projects using a template' })
  @ApiResponse({ status: 200, description: 'Projects using template' })
  async getProjectsUsingTemplate(@Param('slug') slug: string) {
    const trackedProjects = this.settingsService.getAllTrackedProjects();

    // Filter projects using this template
    const filteredProjects = trackedProjects.filter((p) => p.metadata.templateSlug === slug);

    // Batch fetch all projects to avoid N+1 queries
    const projectIds = filteredProjects.map((p) => p.projectId);
    const projectNameMap = new Map<string, string>();

    if (projectIds.length > 0) {
      // Fetch all projects in one query and build a lookup map
      const { items: allProjects } = await this.storageService.listProjects({ limit: 1000 });
      for (const project of allProjects) {
        if (projectIds.includes(project.id)) {
          projectNameMap.set(project.id, project.name);
        }
      }
    }

    // Map to response format using the preloaded names
    const projectsUsingTemplate = filteredProjects.map((p) => ({
      projectId: p.projectId,
      projectName: projectNameMap.get(p.projectId) ?? null,
      installedVersion: p.metadata.installedVersion,
      installedAt: p.metadata.installedAt,
      lastUpdateCheckAt: p.metadata.lastUpdateCheckAt,
    }));

    return { projects: projectsUsingTemplate };
  }

  @Get('cache/:slug/versions')
  @ApiOperation({ summary: 'Get all cached versions for a template' })
  @ApiResponse({ status: 200, description: 'Cached versions list' })
  async getCachedVersions(@Param('slug') slug: string) {
    const allCached = this.cacheService.listCached();
    const templateCache = allCached.find((t) => t.slug === slug);

    return {
      slug,
      versions: templateCache?.versions || [],
      latestCached: templateCache?.latestCached || null,
    };
  }

  @Post('create-project')
  @ApiOperation({ summary: 'Create a new project from a registry template' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['slug', 'version', 'projectName', 'rootPath'],
      properties: {
        slug: { type: 'string', description: 'Template slug' },
        version: { type: 'string', description: 'Template version' },
        projectName: { type: 'string', description: 'New project name' },
        projectDescription: { type: 'string', description: 'Project description' },
        rootPath: { type: 'string', description: 'Project root path' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Project created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input or template not found' })
  async createProjectFromRegistry(
    @Body()
    body: {
      slug: string;
      version: string;
      projectName: string;
      projectDescription?: string;
      rootPath: string;
    },
  ) {
    return this.orchestrationService.createProjectFromRegistry({
      slug: body.slug,
      version: body.version,
      projectName: body.projectName,
      projectDescription: body.projectDescription,
      rootPath: body.rootPath,
    });
  }

  @Post('check-updates/:projectId')
  @ApiOperation({ summary: 'Check for available updates for a project' })
  @ApiResponse({ status: 200, description: 'Update check result' })
  async checkForUpdates(@Param('projectId') projectId: string) {
    const result = await this.orchestrationService.checkForUpdates(projectId);
    if (!result) {
      return {
        projectId,
        linked: false,
        hasUpdate: false,
        message: 'Project is not linked to a registry template',
      };
    }
    return {
      projectId,
      linked: true,
      ...result,
    };
  }

  @Post('upgrade-project')
  @ApiOperation({ summary: 'Upgrade a project to a newer template version' })
  @ApiResponse({
    status: 200,
    description: 'Upgrade result (success or failure with error message in response body)',
  })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  async upgradeProject(@Body() body: UpgradeProjectDto) {
    return this.upgradeService.upgradeProject({
      projectId: body.projectId,
      targetVersion: body.targetVersion,
    });
  }

  @Post('restore-backup')
  @ApiOperation({ summary: 'Restore project from backup after failed upgrade' })
  @ApiResponse({ status: 200, description: 'Backup restored successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  @ApiResponse({ status: 404, description: 'Backup not found or expired' })
  async restoreBackup(@Body() body: RestoreBackupDto) {
    await this.upgradeService.restoreBackup(body.backupId);
    return { success: true, message: 'Backup restored successfully' };
  }

  @Get('backup/:backupId')
  @ApiOperation({ summary: 'Get backup info' })
  @ApiResponse({ status: 200, description: 'Backup info' })
  async getBackupInfo(@Param('backupId') backupId: string) {
    const info = this.upgradeService.getBackupInfo(backupId);
    return {
      backupId,
      found: !!info,
      ...info,
    };
  }

  @Get('project-backups/:projectId')
  @ApiOperation({ summary: 'List active backups for a project' })
  @ApiResponse({ status: 200, description: 'Project backups list' })
  async getProjectBackups(@Param('projectId') projectId: string) {
    const backups = this.upgradeService.getProjectBackups(projectId);
    return {
      projectId,
      backups,
    };
  }
}
