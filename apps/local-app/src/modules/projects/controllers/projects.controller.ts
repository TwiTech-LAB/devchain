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
  isConfigurable?: boolean;
  /** Available bundled upgrade version, or null if no upgrade available */
  bundledUpgradeAvailable?: string | null;
}

const CreateProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  rootPath: z.string().min(1),
  isTemplate: z.boolean().optional(),
});

const UpdateProjectSchema = CreateProjectSchema.partial();

/**
 * Schema for familyProviderMappings: familySlug → providerName
 * - Keys (familySlug) must be non-empty strings
 * - Values (providerName) must be non-empty strings
 */
const FamilyProviderMappingsSchema = z.record(z.string().min(1), z.string().min(1)).optional();

/**
 * Normalize familyProviderMappings values to lowercase for consistent matching.
 * Returns undefined if input is undefined.
 */
function normalizeFamilyProviderMappings(
  mappings: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!mappings) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(mappings)) {
    normalized[key.trim().toLowerCase()] = value.trim().toLowerCase();
  }
  return normalized;
}

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

    // Batch-load all profiles to compute isConfigurable (avoids N+1)
    const allProfiles = await this.storage.listAgentProfiles({ limit: 10000 });
    const configurableProjects = this.computeConfigurableProjects(allProfiles.items);

    // Batch-check bundled upgrades for all projects
    const projectsForUpgradeCheck = result.items.map((project) => {
      const metadata = metadataMap.get(project.id);
      return {
        projectId: project.id,
        templateSlug: metadata?.templateSlug ?? null,
        installedVersion: metadata?.installedVersion ?? null,
        source: metadata?.source ?? null,
      };
    });
    const bundledUpgrades = this.projects.getBundledUpgradesForProjects(projectsForUpgradeCheck);

    // Enrich each project with template metadata, isConfigurable, and bundled upgrade info
    return {
      ...result,
      items: result.items.map((project) => ({
        ...this.enrichProjectWithMap(project, metadataMap),
        isConfigurable: configurableProjects.has(project.id),
        bundledUpgradeAvailable: bundledUpgrades.get(project.id) ?? null,
      })),
    };
  }

  /**
   * Compute which projects are configurable (have switchable provider families)
   * A project is configurable when it has at least one familySlug with 2+ profiles
   * from different providers.
   */
  private computeConfigurableProjects(
    profiles: Array<{
      projectId?: string | null;
      familySlug?: string | null;
      providerId: string;
    }>,
  ): Set<string> {
    const configurable = new Set<string>();

    // Group profiles by projectId
    const byProject = new Map<string, typeof profiles>();
    for (const profile of profiles) {
      if (!profile.projectId) continue;
      const existing = byProject.get(profile.projectId) || [];
      existing.push(profile);
      byProject.set(profile.projectId, existing);
    }

    // For each project, check if any family has 2+ providers
    for (const [projectId, projectProfiles] of byProject) {
      // Group by familySlug
      const byFamily = new Map<string, Set<string>>();
      for (const profile of projectProfiles) {
        if (!profile.familySlug) continue;
        const providers = byFamily.get(profile.familySlug) || new Set();
        providers.add(profile.providerId);
        byFamily.set(profile.familySlug, providers);
      }

      // Check if any family has 2+ different providers
      for (const providers of byFamily.values()) {
        if (providers.size > 1) {
          configurable.add(projectId);
          break;
        }
      }
    }

    return configurable;
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

  @Get(':id/template-manifest')
  async getTemplateManifest(@Param('id') id: string) {
    logger.info({ projectId: id }, 'GET /api/projects/:id/template-manifest');
    return this.projects.getTemplateManifestForProject(id);
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
        familyProviderMappings: FamilyProviderMappingsSchema,
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
      familyProviderMappings: normalizeFamilyProviderMappings(parsed.familyProviderMappings),
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
    @Body()
    body?: {
      statusMappings?: Record<string, string>;
      familyProviderMappings?: Record<string, string>;
      [key: string]: unknown;
    },
  ) {
    logger.info({ projectId: id, dryRun }, 'POST /api/projects/:id/import');
    const isDryRun = (dryRun ?? '').toString().toLowerCase() === 'true';
    const { statusMappings, familyProviderMappings: rawMappings, ...payload } = body ?? {};

    // Validate familyProviderMappings if provided
    let familyProviderMappings: Record<string, string> | undefined;
    if (rawMappings !== undefined) {
      const parseResult = FamilyProviderMappingsSchema.safeParse(rawMappings);
      if (!parseResult.success) {
        const errors = parseResult.error.errors
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ');
        throw new BadRequestException(`Invalid familyProviderMappings: ${errors}`);
      }
      familyProviderMappings = normalizeFamilyProviderMappings(parseResult.data);
    }

    return this.projects.importProject({
      projectId: id,
      payload,
      dryRun: isDryRun,
      statusMappings,
      familyProviderMappings,
    });
  }
}
