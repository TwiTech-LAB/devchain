import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Inject,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { UpdateProject, Project } from '../../storage/models/domain.models';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import {
  SLUG_PATTERN,
  SEMVER_PATTERN,
  VALIDATION_MESSAGES,
} from '../../../common/validation/template-validation';
import { ProjectsService } from '../services/projects.service';
import { SettingsService } from '../../settings/services/settings.service';
import { RegistryTemplateMetadataDto } from '../../settings/dtos/settings.dto';
import { ExportWithOverridesSchema } from '../dtos/export.dto';

const logger = createLogger('ProjectsController');

/** Template metadata included in project responses */
interface ProjectTemplateMetadata {
  slug: string;
  version: string | null;
  source: 'bundled' | 'registry';
}

/** Project with template metadata */
interface ProjectWithMetadata extends Project {
  templateMetadata: ProjectTemplateMetadata | null;
}

const CreateProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  rootPath: z.string().min(1),
  isTemplate: z.boolean().optional(),
});

const UpdateProjectSchema = CreateProjectSchema.partial();

@Controller('api/projects')
export class ProjectsController {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly projects: ProjectsService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Get template metadata for a project
   */
  private getTemplateMetadata(projectId: string): ProjectTemplateMetadata | null {
    const metadata = this.settings.getProjectTemplateMetadata(projectId);
    if (!metadata) return null;

    return {
      slug: metadata.templateSlug,
      version: metadata.installedVersion,
      source: metadata.source ?? 'registry', // Default to 'registry' for backward compat
    };
  }

  /**
   * Enrich project with template metadata
   */
  private enrichProject(project: Project): ProjectWithMetadata {
    return {
      ...project,
      templateMetadata: this.getTemplateMetadata(project.id),
    };
  }

  /**
   * Enrich project with template metadata from pre-loaded map (avoids N+1 queries)
   */
  private enrichProjectWithMap(
    project: Project,
    metadataMap: Map<string, RegistryTemplateMetadataDto>,
  ): ProjectWithMetadata {
    const metadata = metadataMap.get(project.id);
    return {
      ...project,
      templateMetadata: metadata
        ? {
            slug: metadata.templateSlug,
            version: metadata.installedVersion,
            source: metadata.source ?? 'registry',
          }
        : null,
    };
  }

  @Get()
  async listProjects(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    logger.info('GET /api/projects');
    const result = await this.storage.listProjects({
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    // Batch-load all template metadata in one query (avoids N+1)
    const metadataMap = this.settings.getAllProjectTemplateMetadataMap();

    // Enrich each project with template metadata using the pre-loaded map
    return {
      ...result,
      items: result.items.map((project) => this.enrichProjectWithMap(project, metadataMap)),
    };
  }

  // Legacy template endpoints removed - use /api/templates instead
  // See TemplatesController for new unified template API

  @Get('by-path')
  async getProjectByPath(@Query('path') path?: string): Promise<ProjectWithMetadata> {
    logger.info({ path }, 'GET /api/projects/by-path');

    if (!path) {
      throw new BadRequestException('path query parameter is required');
    }

    // Validate absolute path format
    const isAbsolute = path.startsWith('/') || /^[A-Za-z]:\\/.test(path);
    if (!isAbsolute) {
      throw new BadRequestException('path must be an absolute path');
    }

    const project = await this.storage.findProjectByPath(path);

    if (!project) {
      throw new NotFoundException(`No project found with rootPath: ${path}`);
    }

    return this.enrichProject(project);
  }

  @Get(':id')
  async getProject(@Param('id') id: string): Promise<ProjectWithMetadata> {
    logger.info({ id }, 'GET /api/projects/:id');
    const project = await this.storage.getProject(id);
    return this.enrichProject(project);
  }

  @Get(':id/statuses')
  async listStatuses(@Param('id') id: string) {
    logger.info({ projectId: id }, 'GET /api/projects/:id/statuses');
    return this.storage.listStatuses(id);
  }

  @Get(':id/stats')
  async getProjectStats(@Param('id') id: string) {
    logger.info({ projectId: id }, 'GET /api/projects/:id/stats');
    const [epics, agents] = await Promise.all([
      this.storage.listEpics(id, {}),
      this.storage.listAgents(id, {}),
    ]);
    return {
      epicsCount: epics.total,
      agentsCount: agents.total,
    };
  }

  // Removed legacy create project endpoint.
  // Project creation must go through POST /api/projects/from-template which
  // requires a template selection and performs transactional import.

  @Post('from-template')
  @HttpCode(HttpStatus.CREATED)
  async createProjectFromTemplate(@Body() body: unknown) {
    logger.info('POST /api/projects/from-template');

    // Support both new (slug + version) and legacy (templateId) formats
    const CreateFromTemplateSchema = z
      .object({
        name: z.string().min(1, 'Project name is required'),
        description: z.string().nullable().optional(),
        rootPath: z.string().min(1, 'Root path is required'),
        slug: z.string().min(1).regex(SLUG_PATTERN, VALIDATION_MESSAGES.INVALID_SLUG).optional(),
        version: z
          .string()
          .regex(SEMVER_PATTERN, VALIDATION_MESSAGES.INVALID_VERSION)
          .nullable()
          .optional(),
        templateId: z
          .string()
          .min(1)
          .regex(SLUG_PATTERN, VALIDATION_MESSAGES.INVALID_SLUG)
          .optional(), // Legacy: alias for slug
      })
      .refine((data) => data.slug || data.templateId, {
        message: 'Either slug or templateId is required',
      });

    const parsed = CreateFromTemplateSchema.parse(body);
    const input = {
      name: parsed.name,
      description: parsed.description,
      rootPath: parsed.rootPath,
      slug: parsed.slug ?? parsed.templateId!, // Use slug if provided, else templateId
      version: parsed.version ?? null,
    };
    return this.projects.createFromTemplate(input);
  }

  @Put(':id')
  async updateProject(@Param('id') id: string, @Body() body: unknown): Promise<Project> {
    logger.info({ id }, 'PUT /api/projects/:id');
    const data = UpdateProjectSchema.parse(body) as UpdateProject;
    return this.storage.updateProject(id, data);
  }

  @Delete(':id')
  async deleteProject(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/projects/:id');
    await this.storage.deleteProject(id);
    // Clean up template metadata from settings to prevent stale entries
    await this.settings.clearProjectTemplateMetadata(id);
  }

  @Get(':id/export')
  async exportProject(@Param('id') id: string) {
    logger.info({ projectId: id }, 'GET /api/projects/:id/export');
    return this.projects.exportProject(id);
  }

  @Post(':id/export')
  async exportProjectWithOverrides(@Param('id') id: string, @Body() body?: unknown) {
    logger.info({ projectId: id }, 'POST /api/projects/:id/export');

    // Validate request body with Zod schema
    const parseResult = ExportWithOverridesSchema.safeParse(body ?? {});
    if (!parseResult.success) {
      const errors = parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
      throw new BadRequestException(`Invalid manifest overrides: ${errors.join('; ')}`);
    }

    return this.projects.exportProject(id, {
      manifestOverrides: parseResult.data.manifest,
    });
  }

  @Post(':id/import')
  async importProject(
    @Param('id') id: string,
    @Query('dryRun') dryRun?: string,
    @Body() body?: { statusMappings?: Record<string, string>; [key: string]: unknown },
  ) {
    logger.info({ projectId: id, dryRun }, 'POST /api/projects/:id/import');
    const isDryRun = (dryRun ?? '').toString().toLowerCase() === 'true';
    const { statusMappings, ...payload } = body ?? {};
    return this.projects.importProject({
      projectId: id,
      payload,
      dryRun: isDryRun,
      statusMappings,
    });
  }
}
