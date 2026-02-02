import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Inject,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  ConflictException,
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
import {
  RegistryTemplateMetadataDto,
  TemplatePresetSchema,
} from '../../settings/dtos/settings.dto';
import { ExportWithOverridesSchema } from '../dtos/export.dto';

const logger = createLogger('ProjectsController');

/** Template metadata included in project responses */
interface ProjectTemplateMetadata {
  slug: string;
  version: string | null;
  source: 'bundled' | 'registry' | 'file';
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

    // Batch-load all profiles and configs to compute isConfigurable (avoids N+1)
    const [allProfiles, allConfigs] = await Promise.all([
      this.storage.listAgentProfiles({ limit: 10000 }),
      this.storage.listAllProfileProviderConfigs(),
    ]);
    const configurableProjects = this.computeConfigurableProjects(allProfiles.items, allConfigs);

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
   * A project is configurable when it has at least one familySlug with 2+ provider configs
   * from different providers.
   */
  private computeConfigurableProjects(
    profiles: Array<{
      id: string;
      projectId?: string | null;
      familySlug?: string | null;
    }>,
    configs: Array<{
      profileId: string;
      providerId: string;
    }>,
  ): Set<string> {
    const configurable = new Set<string>();

    // Build a map of profileId -> providerIds (from configs)
    const configsByProfile = new Map<string, Set<string>>();
    for (const config of configs) {
      const existing = configsByProfile.get(config.profileId) || new Set();
      existing.add(config.providerId);
      configsByProfile.set(config.profileId, existing);
    }

    // Group profiles by projectId
    const byProject = new Map<string, typeof profiles>();
    for (const profile of profiles) {
      if (!profile.projectId) continue;
      const existing = byProject.get(profile.projectId) || [];
      existing.push(profile);
      byProject.set(profile.projectId, existing);
    }

    // For each project, check if any family has 2+ providers via configs
    for (const [projectId, projectProfiles] of byProject) {
      // Group by familySlug, collecting providerIds from configs
      const byFamily = new Map<string, Set<string>>();
      for (const profile of projectProfiles) {
        if (!profile.familySlug) continue;

        // Get providerIds from this profile's configs
        const configProviders = configsByProfile.get(profile.id);
        if (configProviders && configProviders.size > 0) {
          const familyProviders = byFamily.get(profile.familySlug) || new Set();
          for (const providerId of configProviders) {
            familyProviders.add(providerId);
          }
          byFamily.set(profile.familySlug, familyProviders);
        }
        // Note: Profiles no longer have providerId - provider info comes from configs only
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

    // Support slug/templateId (registry/bundled) OR templatePath (file-based)
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
        templatePath: z.string().min(1).optional(), // File-based template path
        familyProviderMappings: FamilyProviderMappingsSchema,
        presetName: z.string().min(1).optional(), // Optional preset to apply after creation
      })
      .refine(
        (data) => {
          const hasSlugOrTemplateId = !!(data.slug || data.templateId);
          const hasTemplatePath = !!data.templatePath;
          // XOR: exactly one of (slug/templateId) or templatePath must be provided
          return hasSlugOrTemplateId !== hasTemplatePath;
        },
        {
          message: 'Provide either (slug or templateId) OR templatePath, but not both or neither',
        },
      )
      .refine(
        (data) => {
          // Reject version when templatePath is provided
          if (data.templatePath && data.version) {
            return false;
          }
          return true;
        },
        {
          message: 'version cannot be specified when using templatePath',
          path: ['version'],
        },
      );

    const parsed = CreateFromTemplateSchema.parse(body);

    // Build input based on whether using slug-based or file-based template
    const input = parsed.templatePath
      ? {
          name: parsed.name,
          description: parsed.description,
          rootPath: parsed.rootPath,
          templatePath: parsed.templatePath,
          familyProviderMappings: normalizeFamilyProviderMappings(parsed.familyProviderMappings),
          presetName: parsed.presetName,
        }
      : {
          name: parsed.name,
          description: parsed.description,
          rootPath: parsed.rootPath,
          slug: parsed.slug ?? parsed.templateId!, // Use slug if provided, else templateId
          version: parsed.version ?? null,
          familyProviderMappings: normalizeFamilyProviderMappings(parsed.familyProviderMappings),
          presetName: parsed.presetName,
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
    // Clean up template metadata and presets from settings to prevent stale entries
    await this.settings.clearProjectTemplateMetadata(id);
    await this.settings.clearProjectPresets(id);
    // Clean up active preset entry for this project
    await this.settings.setProjectActivePreset(id, null);
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
      throw new BadRequestException(`Invalid export overrides: ${errors.join('; ')}`);
    }

    return this.projects.exportProject(id, {
      manifestOverrides: parseResult.data.manifest,
      presets: parseResult.data.presets,
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

  /**
   * Get available presets for a project
   * Presets are stored in settings when a project is created from a template
   * Returns activePreset with drift validation (null if drifted)
   */
  @Get(':id/presets')
  async getProjectPresets(@Param('id') id: string) {
    logger.info({ projectId: id }, 'GET /api/projects/:id/presets');

    // Verify project exists - let NestJS error filter handle NotFoundException → 404
    await this.storage.getProject(id);

    // Get presets from settings
    const presets = this.settings.getProjectPresets(id);

    // Get stored activePreset with drift validation
    let activePreset: string | null = this.settings.getProjectActivePreset(id);

    // Validate on read: check if stored activePreset still matches current config (case-insensitive lookup)
    if (activePreset) {
      const activePresetLower = activePreset.toLowerCase();
      const activePresetObj = presets.find((p) => p.name.toLowerCase() === activePresetLower);
      if (activePresetObj) {
        // Canonicalize: if stored name differs in case from current preset name, update storage
        if (activePreset !== activePresetObj.name) {
          await this.settings.setProjectActivePreset(id, activePresetObj.name);
          activePreset = activePresetObj.name;
        }
        const stillMatches = await this.projects.doesProjectMatchPreset(id, activePresetObj);
        if (!stillMatches) {
          // Drift detected - clear the active preset
          logger.info({ projectId: id, activePreset }, 'Active preset drifted, clearing');
          await this.settings.setProjectActivePreset(id, null);
          activePreset = null;
        }
      } else {
        // Stored activePreset no longer exists in presets - clear it
        logger.info({ projectId: id, activePreset }, 'Active preset not found in presets, clearing');
        await this.settings.setProjectActivePreset(id, null);
        activePreset = null;
      }
    }

    return { presets, activePreset };
  }

  /**
   * Apply a preset to a project
   * Batch updates agent provider config assignments based on the preset definition
   */
  @Post(':id/presets/apply')
  @HttpCode(HttpStatus.OK)
  async applyPreset(@Param('id') id: string, @Body() body: unknown) {
    logger.info({ projectId: id }, 'POST /api/projects/:id/presets/apply');

    // Validate request body
    const ApplyPresetSchema = z.object({
      presetName: z.string().min(1, 'Preset name is required'),
    });
    const parsed = ApplyPresetSchema.parse(body);

    // Verify project exists - let NestJS error filter handle NotFoundError → 404
    await this.storage.getProject(id);

    // Apply the preset
    const result = await this.projects.applyPreset(id, parsed.presetName);

    // Get updated agent list for response
    const agentsRes = await this.storage.listAgents(id, { limit: 1000, offset: 0 });

    return {
      applied: result.applied,
      warnings: result.warnings,
      agents: agentsRes.items,
    };
  }

  /**
   * Create a new preset for a project
   * Body: { name: string, description?: string, agentConfigs: Array<{agentName, providerConfigName}> }
   */
  @Post(':id/presets')
  @HttpCode(HttpStatus.CREATED)
  async createPreset(@Param('id') id: string, @Body() body: unknown) {
    logger.info({ projectId: id }, 'POST /api/projects/:id/presets');

    // Validate request body against TemplatePresetSchema
    const result = TemplatePresetSchema.safeParse(body);
    if (!result.success) {
      const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw new BadRequestException(`Invalid preset data: ${errors}`);
    }

    const preset = result.data;

    // Verify project exists - let NestJS error filter handle NotFoundError → 404
    await this.storage.getProject(id);

    // Create the preset via SettingsService
    try {
      await this.settings.createProjectPreset(id, preset);
    } catch (error) {
      // Handle conflict (duplicate name)
      if (error instanceof Error && error.message.includes('already exists')) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    // Return the created preset
    return preset;
  }

  /**
   * Update an existing preset for a project
   * Body: { presetName: string, updates: { name?, description?, agentConfigs? } }
   */
  @Patch(':id/presets')
  @HttpCode(HttpStatus.OK)
  async updatePreset(@Param('id') id: string, @Body() body: unknown) {
    logger.info({ projectId: id }, 'PATCH /api/projects/:id/presets');

    // Validate request body
    const UpdatePresetSchema = z
      .object({
        presetName: z.string().min(1, 'Preset name is required'),
        updates: z
          .object({
            name: z.string().min(1).optional(),
            description: z.string().nullable().optional(),
            agentConfigs: z
              .array(
                z.object({
                  agentName: z.string().min(1),
                  providerConfigName: z.string().min(1),
                }),
              )
              .optional(),
          })
          .strict(),
      })
      .strict();

    const parseResult = UpdatePresetSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      throw new BadRequestException(`Invalid request: ${errors}`);
    }

    const { presetName, updates } = parseResult.data;

    // Verify project exists - let NestJS error filter handle NotFoundError → 404
    await this.storage.getProject(id);

    // Update the preset via SettingsService
    try {
      await this.settings.updateProjectPreset(id, presetName, updates);
    } catch (error) {
      // Handle conflict (name already exists) or not found
      if (error instanceof Error) {
        if (error.message.includes('already exists')) {
          throw new ConflictException(error.message);
        }
        if (error.message.includes('not found')) {
          throw new NotFoundException(error.message);
        }
      }
      throw error;
    }

    // Return the updated preset (fetch to get full state)
    // Search by the new name if it was changed, otherwise by the original name
    // Trim to match SettingsService behavior
    const searchName = (updates.name ?? presetName).trim();
    const presets = this.settings.getProjectPresets(id);
    const updated = presets.find((p) => p.name.toLowerCase() === searchName.toLowerCase());

    if (!updated) {
      throw new NotFoundException(`Preset "${searchName}" not found after update`);
    }

    return updated;
  }

  /**
   * Delete a preset from a project
   * Body: { presetName: string }
   */
  @Delete(':id/presets')
  @HttpCode(HttpStatus.OK)
  async deletePreset(@Param('id') id: string, @Body() body: unknown) {
    logger.info({ projectId: id }, 'DELETE /api/projects/:id/presets');

    // Validate request body
    const DeletePresetSchema = z
      .object({
        presetName: z.string().min(1, 'Preset name is required'),
      })
      .strict();

    const parseResult = DeletePresetSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      throw new BadRequestException(`Invalid request: ${errors}`);
    }

    const { presetName } = parseResult.data;

    // Verify project exists - let NestJS error filter handle NotFoundError → 404
    await this.storage.getProject(id);

    // Delete the preset via SettingsService
    try {
      await this.settings.deleteProjectPreset(id, presetName);
    } catch (error) {
      // Handle not found
      if (error instanceof Error && error.message.includes('not found')) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }

    return { deleted: true };
  }
}
