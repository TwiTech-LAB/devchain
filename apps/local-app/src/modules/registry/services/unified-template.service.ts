import { Injectable } from '@nestjs/common';
import { join, resolve, sep } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { TemplateCacheService } from './template-cache.service';
import { createLogger } from '../../../common/logging/logger';
import { NotFoundError, ValidationError, StorageError } from '../../../common/errors/error-types';
import {
  isValidSlug,
  isValidVersion,
  VALIDATION_MESSAGES,
} from '../../../common/validation/template-validation';
import { getEnvConfig } from '../../../common/config/env.config';

const logger = createLogger('UnifiedTemplateService');

/**
 * Template source type
 */
export type TemplateSource = 'bundled' | 'registry';

/**
 * Unified template info for listing
 */
export interface UnifiedTemplateInfo {
  /** Template slug (unique identifier) */
  slug: string;
  /** Display name */
  name: string;
  /** Template description */
  description: string | null;
  /** Source of the template */
  source: TemplateSource;
  /** Available versions (null for bundled templates) */
  versions: string[] | null;
  /** Latest/default version (null for bundled templates) */
  latestVersion: string | null;
  // Optional fields from _manifest (for display/UX purposes)
  /** Template category */
  category?: string;
  /** Searchable tags */
  tags?: string[];
  /** Template author */
  authorName?: string;
  /** Whether this is an official Devchain template */
  isOfficial?: boolean;
}

/**
 * Template content result
 */
export interface UnifiedTemplateContent {
  /** Template content (ExportSchema) */
  content: Record<string, unknown>;
  /** Source of the template */
  source: TemplateSource;
  /** Version (null for bundled) */
  version: string | null;
}

/**
 * Service that provides a unified interface for all templates (bundled + downloaded)
 *
 * - Bundled templates: Shipped with the app in apps/local-app/templates/*.json
 * - Downloaded templates: Cached from registry via TemplateCacheService
 *
 * When a slug exists in both sources, downloaded templates take precedence.
 */
@Injectable()
export class UnifiedTemplateService {
  constructor(private readonly cacheService: TemplateCacheService) {}

  /**
   * Convert slug to title case name
   * Example: "claude-codex-advanced" → "Claude Codex Advanced"
   */
  private slugToName(slug: string): string {
    return slug
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Find the bundled templates directory
   */
  private findTemplatesDirectory(): string | null {
    const env = getEnvConfig();

    // 1. Check for explicit TEMPLATES_DIR environment variable override
    if (env.TEMPLATES_DIR) {
      if (existsSync(env.TEMPLATES_DIR)) {
        logger.debug({ path: env.TEMPLATES_DIR }, 'Using TEMPLATES_DIR from environment');
        return env.TEMPLATES_DIR;
      }
      logger.warn({ path: env.TEMPLATES_DIR }, 'TEMPLATES_DIR set but path does not exist');
    }

    // 2. Try template paths for different deployment scenarios
    const possibleTemplatePaths = [
      // Relative to this file: works in both dev and prod builds
      join(__dirname, '..', '..', '..', '..', 'templates'),
      // Dev mode fallback: running from monorepo root with ts-node
      join(process.cwd(), 'apps', 'local-app', 'templates'),
    ];

    for (const path of possibleTemplatePaths) {
      if (existsSync(path)) {
        logger.debug({ path }, 'Found templates directory');
        return path;
      }
    }

    return null;
  }

  /**
   * List bundled templates from the templates directory
   * Reads _manifest from each template for display metadata
   */
  private listBundledTemplates(): UnifiedTemplateInfo[] {
    const templatesDir = this.findTemplatesDirectory();

    if (!templatesDir) {
      logger.warn('Templates directory not found, returning empty bundled list');
      return [];
    }

    try {
      const files = readdirSync(templatesDir);
      const jsonFiles = files.filter((file) => file.endsWith('.json'));

      return jsonFiles.map((fileName) => {
        const slug = fileName.replace(/\.json$/, '');

        // Try to read _manifest from template for display metadata
        try {
          const templatePath = join(templatesDir, fileName);
          const content = JSON.parse(readFileSync(templatePath, 'utf-8'));
          const manifest = content._manifest as
            | {
                name?: string;
                description?: string | null;
                category?: string;
                tags?: string[];
                authorName?: string;
                isOfficial?: boolean;
                version?: string;
              }
            | undefined;

          return {
            slug,
            name: manifest?.name || this.slugToName(slug),
            description: manifest?.description || null,
            source: 'bundled' as TemplateSource,
            versions: manifest?.version ? [manifest.version] : null,
            latestVersion: manifest?.version || null,
            category: manifest?.category,
            tags: manifest?.tags,
            authorName: manifest?.authorName,
            isOfficial: manifest?.isOfficial,
          };
        } catch (parseError) {
          // Fallback if parsing fails - use slug-derived name
          logger.debug(
            { slug, error: parseError },
            'Failed to parse bundled template for _manifest, using fallback',
          );
          return {
            slug,
            name: this.slugToName(slug),
            description: null,
            source: 'bundled' as TemplateSource,
            versions: null,
            latestVersion: null,
          };
        }
      });
    } catch (error) {
      logger.error({ error, templatesDir }, 'Failed to read templates directory');
      return [];
    }
  }

  /**
   * List downloaded templates from the cache
   * Uses display fields from cache index for O(1) listing
   */
  private listDownloadedTemplates(): UnifiedTemplateInfo[] {
    const cached = this.cacheService.listCached();

    return cached.map((info) => ({
      slug: info.slug,
      name: info.displayName || this.slugToName(info.slug),
      description: info.description ?? null,
      source: 'registry' as TemplateSource,
      versions: info.versions,
      latestVersion: info.latestCached,
      // Include display fields from cache index
      category: info.category,
      tags: info.tags,
      authorName: info.authorName,
      isOfficial: info.isOfficial,
    }));
  }

  /**
   * List all available templates (bundled + downloaded, deduplicated)
   *
   * Downloaded templates take precedence over bundled templates with the same slug.
   *
   * @returns Array of unified template info
   */
  listTemplates(): UnifiedTemplateInfo[] {
    const bundled = this.listBundledTemplates();
    const downloaded = this.listDownloadedTemplates();

    // Create a map for quick lookup, downloaded templates override bundled
    const templateMap = new Map<string, UnifiedTemplateInfo>();

    // Add bundled templates first
    for (const template of bundled) {
      templateMap.set(template.slug, template);
    }

    // Add downloaded templates (overrides bundled with same slug)
    for (const template of downloaded) {
      templateMap.set(template.slug, template);
    }

    // Convert map to array and sort by name
    const result = Array.from(templateMap.values());
    result.sort((a, b) => a.name.localeCompare(b.name));

    logger.debug(
      {
        bundledCount: bundled.length,
        downloadedCount: downloaded.length,
        totalCount: result.length,
      },
      'Listed unified templates',
    );

    return result;
  }

  /**
   * Validate slug for security (prevent path traversal)
   */
  private validateSlug(slug: string): void {
    if (!isValidSlug(slug)) {
      throw new ValidationError(VALIDATION_MESSAGES.INVALID_SLUG, { slug });
    }
  }

  /**
   * Validate version format
   */
  private validateVersion(version: string): void {
    if (!isValidVersion(version)) {
      throw new ValidationError(VALIDATION_MESSAGES.INVALID_VERSION, { version });
    }
  }

  /**
   * Get template content by slug and optional version
   *
   * - If version is specified: try downloaded cache first, then bundled (if version matches)
   * - If version is not specified:
   *   - If downloaded exists: return latest downloaded version
   *   - Otherwise: return bundled template
   *
   * @param slug Template slug
   * @param version Optional specific version
   * @returns Template content with metadata
   */
  async getTemplate(slug: string, version?: string): Promise<UnifiedTemplateContent> {
    this.validateSlug(slug);

    if (version) {
      this.validateVersion(version);
      // Try downloaded cache first
      try {
        return await this.getDownloadedTemplate(slug, version);
      } catch (error) {
        // If not in cache, check if bundled template has matching version
        if (error instanceof NotFoundError) {
          const bundled = this.tryGetBundledTemplateWithVersion(slug, version);
          if (bundled) {
            return bundled;
          }
        }
        throw error;
      }
    }

    // No version specified - check for downloaded first, then bundled
    const cached = this.cacheService.listCached();
    const downloadedInfo = cached.find((c) => c.slug === slug);

    if (downloadedInfo) {
      // Return latest downloaded version
      return this.getDownloadedTemplate(slug, downloadedInfo.latestCached);
    }

    // Fall back to bundled
    return this.getBundledTemplate(slug);
  }

  /**
   * Try to get a bundled template if its version matches the requested version
   */
  private tryGetBundledTemplateWithVersion(
    slug: string,
    version: string,
  ): UnifiedTemplateContent | null {
    try {
      const bundled = this.getBundledTemplate(slug);
      const manifest = (bundled.content as Record<string, unknown>)._manifest as
        | { version?: string }
        | undefined;

      // Return bundled template if version matches or if bundled has no version
      if (!manifest?.version || manifest.version === version) {
        return {
          ...bundled,
          version: manifest?.version || null,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get a downloaded template from cache
   */
  private async getDownloadedTemplate(
    slug: string,
    version: string,
  ): Promise<UnifiedTemplateContent> {
    const cached = await this.cacheService.getTemplate(slug, version);

    if (!cached) {
      throw new NotFoundError('Template', `${slug}@${version}`);
    }

    return {
      content: cached.content,
      source: 'registry',
      version,
    };
  }

  /**
   * Get a bundled template
   */
  private getBundledTemplate(slug: string): UnifiedTemplateContent {
    const templatesDir = this.findTemplatesDirectory();

    if (!templatesDir) {
      throw new NotFoundError('Template', slug);
    }

    // Security: Resolve absolute paths and verify the template stays within templates directory
    const resolvedTemplatesDir = resolve(templatesDir);
    const templatePath = resolve(templatesDir, `${slug}.json`);

    if (!templatePath.startsWith(resolvedTemplatesDir + sep)) {
      logger.warn(
        { slug, templatePath, templatesDir: resolvedTemplatesDir },
        'Path traversal attempt detected',
      );
      throw new ValidationError('Invalid template slug: path traversal not allowed', { slug });
    }

    if (!existsSync(templatePath)) {
      throw new NotFoundError('Template', slug);
    }

    try {
      const content = readFileSync(templatePath, 'utf-8');
      return {
        content: JSON.parse(content) as Record<string, unknown>,
        source: 'bundled',
        version: null,
      };
    } catch (error) {
      // Classify errors properly for debugging and accurate feedback
      // Note: templatePath is logged server-side only, not exposed in error details (security)
      if (error instanceof SyntaxError) {
        // JSON parse error - malformed template file
        logger.error({ error, templatePath }, 'Malformed JSON in bundled template file');
        throw new ValidationError(`Bundled template "${slug}" contains invalid JSON`, {
          slug,
        });
      }

      // File system error (EACCES, EIO, etc.) - existsSync passed so file exists
      const nodeError = error as NodeJS.ErrnoException;
      logger.error(
        { error, templatePath, code: nodeError.code },
        'Failed to read bundled template file',
      );
      // Redact path from client-facing error; include only error code for debugging
      throw new StorageError(`Failed to read bundled template "${slug}"`, {
        slug,
        code: nodeError.code,
      });
    }
  }

  /**
   * Check if a template exists (either bundled or downloaded)
   */
  hasTemplate(slug: string): boolean {
    this.validateSlug(slug);

    // Check downloaded first
    const cached = this.cacheService.listCached();
    if (cached.some((c) => c.slug === slug)) {
      return true;
    }

    // Check bundled
    const templatesDir = this.findTemplatesDirectory();
    if (!templatesDir) {
      return false;
    }

    const templatePath = join(templatesDir, `${slug}.json`);
    return existsSync(templatePath);
  }

  /**
   * Check if a specific version of a template is available
   */
  hasVersion(slug: string, version: string): boolean {
    this.validateSlug(slug);
    this.validateVersion(version);

    return this.cacheService.isCached(slug, version);
  }
}
