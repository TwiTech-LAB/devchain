import { Controller, Get, Post, Param, Query, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { RegistryClientService } from '../services/registry-client.service';
import { TemplateCacheService } from '../services/template-cache.service';
import { RegistryOrchestrationService } from '../services/registry-orchestration.service';
import { SettingsService } from '../../settings/services/settings.service';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import {
  TemplateListResponse,
  TemplateDetailResponse,
  ListTemplatesQuery,
} from '../interfaces/registry.interface';

@ApiTags('registry')
@Controller('api/registry')
export class RegistryController {
  constructor(
    private readonly registryClient: RegistryClientService,
    private readonly cacheService: TemplateCacheService,
    private readonly orchestrationService: RegistryOrchestrationService,
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

  @Get('update-status')
  @ApiOperation({ summary: 'Get startup registry update check status' })
  @ApiResponse({ status: 200, description: 'Startup registry update check status' })
  getUpdateStatus() {
    const status = this.orchestrationService.getUpdateStatus();
    return {
      state: status.state,
      results: status.results.map((result) => ({
        projectId: result.projectId,
        templateSlug:
          this.settingsService.getProjectTemplateMetadata(result.projectId)?.templateSlug ?? null,
        hasUpdate: result.hasUpdate,
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        changelog: result.changelog,
      })),
    };
  }
}
