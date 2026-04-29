import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { UnifiedTemplateService, UnifiedTemplateInfo } from '../services/unified-template.service';
import { TemplateCacheService } from '../services/template-cache.service';
import { ValidationError, NotFoundError, ForbiddenError } from '../../../common/errors/error-types';
import { ExportSchema } from '@devchain/shared';
import { z } from 'zod';
import {
  isValidSlug,
  isValidVersion,
  VALIDATION_MESSAGES,
} from '../../../common/validation/template-validation';

/**
 * Response type for template list endpoint
 */
interface TemplateListResponse {
  templates: UnifiedTemplateInfo[];
  total: number;
}

/**
 * Response type for template detail endpoint
 */
interface TemplateDetailResponse {
  slug: string;
  name: string;
  description: string | null;
  source: 'bundled' | 'registry' | 'file';
  versions: string[] | null;
  latestVersion: string | null;
  content: Record<string, unknown>;
}

/**
 * Response type for specific version endpoint
 */
interface TemplateVersionResponse {
  slug: string;
  version: string;
  source: 'bundled' | 'registry' | 'file';
  content: Record<string, unknown>;
}

/**
 * Response type for delete endpoint
 */
interface DeleteVersionResponse {
  success: boolean;
  message: string;
}

/**
 * Controller for unified template operations
 *
 * Provides endpoints for listing and retrieving templates from both
 * bundled (shipped with app) and registry (downloaded) sources.
 */
@ApiTags('templates')
@Controller('api/templates')
export class TemplatesController {
  constructor(
    private readonly unifiedTemplateService: UnifiedTemplateService,
    private readonly cacheService: TemplateCacheService,
  ) {}

  /**
   * List all available templates (bundled + downloaded, deduplicated)
   */
  @Get()
  @ApiOperation({ summary: 'List all available templates' })
  @ApiResponse({
    status: 200,
    description: 'List of all templates (bundled + downloaded, deduplicated by slug)',
  })
  listTemplates(): TemplateListResponse {
    const templates = this.unifiedTemplateService.listTemplates();
    return {
      templates,
      total: templates.length,
    };
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview a parsed template without creating a project' })
  @ApiResponse({ status: 200, description: 'Parsed template payload' })
  @ApiResponse({ status: 400, description: 'Invalid template or input' })
  @ApiResponse({ status: 403, description: 'Path traversal rejected' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async previewTemplate(@Body() body: unknown) {
    const PreviewSchema = z
      .object({
        slug: z.string().min(1).optional(),
        version: z.string().optional(),
        templatePath: z.string().min(1).optional(),
      })
      .refine((d) => !!d.slug !== !!d.templatePath, {
        message: 'Provide either slug OR templatePath, but not both or neither',
      });

    try {
      const parsed = PreviewSchema.parse(body);

      let content: Record<string, unknown>;
      if (parsed.templatePath) {
        const result = this.unifiedTemplateService.getTemplateFromFilePath(parsed.templatePath);
        content = result.content as Record<string, unknown>;
      } else {
        const result = await this.unifiedTemplateService.getTemplate(
          parsed.slug!,
          parsed.version ?? undefined,
        );
        content = result.content as Record<string, unknown>;
      }
      return ExportSchema.parse(content);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof NotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof ForbiddenError) {
        throw new ForbiddenException(error.message);
      }
      if (error instanceof z.ZodError) {
        throw new BadRequestException({
          message: 'Invalid template format',
          errors: error.errors,
        });
      }
      throw error;
    }
  }

  /**
   * Get template details with content (latest version or bundled)
   */
  @Get(':slug')
  @ApiOperation({ summary: 'Get template details and content' })
  @ApiParam({ name: 'slug', description: 'Template slug (alphanumeric, hyphens, underscores)' })
  @ApiResponse({ status: 200, description: 'Template details with content' })
  @ApiResponse({ status: 400, description: 'Invalid slug format' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async getTemplate(@Param('slug') slug: string): Promise<TemplateDetailResponse> {
    try {
      // Get template info from list
      const templates = this.unifiedTemplateService.listTemplates();
      const templateInfo = templates.find((t) => t.slug === slug);

      // Get template content
      const templateContent = await this.unifiedTemplateService.getTemplate(slug);

      return {
        slug,
        name: templateInfo?.name ?? slug,
        description: templateInfo?.description ?? null,
        source: templateContent.source,
        versions: templateInfo?.versions ?? null,
        latestVersion: templateInfo?.latestVersion ?? null,
        content: templateContent.content,
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof NotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  /**
   * Get specific version of a template
   */
  @Get(':slug/versions/:version')
  @ApiOperation({ summary: 'Get specific version of a template' })
  @ApiParam({ name: 'slug', description: 'Template slug' })
  @ApiParam({ name: 'version', description: 'Template version (semver format)' })
  @ApiResponse({ status: 200, description: 'Template version content' })
  @ApiResponse({ status: 400, description: 'Invalid slug or version format' })
  @ApiResponse({ status: 404, description: 'Template version not found' })
  async getTemplateVersion(
    @Param('slug') slug: string,
    @Param('version') version: string,
  ): Promise<TemplateVersionResponse> {
    try {
      const templateContent = await this.unifiedTemplateService.getTemplate(slug, version);

      return {
        slug,
        version,
        source: templateContent.source,
        content: templateContent.content,
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof NotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  /**
   * Delete a cached template version
   *
   * Only works for registry (downloaded) templates, not bundled.
   */
  @Delete(':slug/versions/:version')
  @ApiOperation({ summary: 'Delete a cached template version' })
  @ApiParam({ name: 'slug', description: 'Template slug' })
  @ApiParam({ name: 'version', description: 'Template version to delete' })
  @ApiResponse({ status: 200, description: 'Version deleted successfully' })
  @ApiResponse({
    status: 400,
    description: 'Invalid slug or version format, or cannot delete bundled template',
  })
  @ApiResponse({ status: 404, description: 'Template version not found in cache' })
  async deleteTemplateVersion(
    @Param('slug') slug: string,
    @Param('version') version: string,
  ): Promise<DeleteVersionResponse> {
    // Validate slug format (security: prevent path traversal)
    if (!isValidSlug(slug)) {
      throw new BadRequestException(VALIDATION_MESSAGES.INVALID_SLUG);
    }

    // Validate version format
    if (!isValidVersion(version)) {
      throw new BadRequestException(VALIDATION_MESSAGES.INVALID_VERSION);
    }

    // Check if version is cached
    if (!this.cacheService.isCached(slug, version)) {
      throw new NotFoundException(`Template version ${slug}@${version} not found in cache`);
    }

    // Remove from cache
    await this.cacheService.removeVersion(slug, version);

    return {
      success: true,
      message: `Template version ${slug}@${version} removed from cache`,
    };
  }
}
