import { Injectable, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { getLatestVersion } from '@devchain/shared';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';

const logger = createLogger('TemplateCacheService');

// Default cache directory
const DEFAULT_CACHE_DIR = join(homedir(), '.devchain', 'registry-cache');

/**
 * Metadata for a cached template version
 */
export interface VersionMetadata {
  cachedAt: string;
  checksum: string;
  size: number;
  version: string;
  slug: string;
}

/**
 * Cache index entry for a template
 */
interface CacheIndexEntry {
  versions: Record<
    string,
    {
      cachedAt: string;
      checksum: string;
      size: number;
    }
  >;
  latestVersion: string;
  // Optional display fields from _manifest (for O(1) listing)
  displayName?: string;
  description?: string | null;
  category?: string;
  tags?: string[];
  authorName?: string;
  isOfficial?: boolean;
}

/**
 * Cache index for quick lookups
 */
export interface CacheIndex {
  templates: Record<string, CacheIndexEntry>;
  updatedAt: string;
}

/**
 * Result from getTemplate
 */
export interface CachedTemplate {
  content: Record<string, unknown>;
  metadata: VersionMetadata;
}

/**
 * Info about a cached template for listing
 */
export interface CachedTemplateInfo {
  slug: string;
  versions: string[];
  latestCached: string;
  // Optional display fields from _manifest (for O(1) listing)
  displayName?: string;
  description?: string | null;
  category?: string;
  tags?: string[];
  authorName?: string;
  isOfficial?: boolean;
}

/**
 * Service for managing local cache of downloaded registry templates
 *
 * Cache structure:
 * ~/.devchain/registry-cache/
 * ├── templates/
 * │   ├── {slug}/
 * │   │   └── {version}/
 * │   │       ├── template.json
 * │   │       └── metadata.json
 * └── index.json
 */
@Injectable()
export class TemplateCacheService implements OnModuleInit {
  private cacheDir: string;
  private index: CacheIndex;
  private indexLoaded = false;

  constructor(private readonly settings: SettingsService) {
    const config = this.settings.getRegistryConfig();
    this.cacheDir = config.cacheDir || DEFAULT_CACHE_DIR;
    this.index = { templates: {}, updatedAt: new Date().toISOString() };
  }

  /**
   * Load the cache index on module initialization
   */
  async onModuleInit(): Promise<void> {
    await this.loadIndex();
  }

  /**
   * Load the cache index from disk
   */
  private async loadIndex(): Promise<void> {
    const indexPath = join(this.cacheDir, 'index.json');

    try {
      const data = await fs.readFile(indexPath, 'utf-8');
      this.index = JSON.parse(data) as CacheIndex;
      this.indexLoaded = true;
      logger.debug(
        { templateCount: Object.keys(this.index.templates).length },
        'Cache index loaded',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Index doesn't exist yet, use empty index
        this.index = { templates: {}, updatedAt: new Date().toISOString() };
        this.indexLoaded = true;
        logger.debug('No cache index found, using empty index');
      } else {
        // Other error, log and use empty index
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to load cache index, using empty index',
        );
        this.index = { templates: {}, updatedAt: new Date().toISOString() };
        this.indexLoaded = true;
      }
    }
  }

  /**
   * Save the cache index to disk
   */
  private async saveIndex(): Promise<void> {
    const indexPath = join(this.cacheDir, 'index.json');

    try {
      // Ensure cache directory exists
      await fs.mkdir(this.cacheDir, { recursive: true });

      this.index.updatedAt = new Date().toISOString();
      await fs.writeFile(indexPath, JSON.stringify(this.index, null, 2));

      logger.debug('Cache index saved');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to save cache index',
      );
      throw error;
    }
  }

  /**
   * Display fields extracted from _manifest for index storage
   */
  private extractDisplayFields(content: Record<string, unknown>): {
    displayName?: string;
    description?: string | null;
    category?: string;
    tags?: string[];
    authorName?: string;
    isOfficial?: boolean;
  } {
    const manifest = content._manifest as
      | {
          name?: string;
          description?: string | null;
          category?: string;
          tags?: string[];
          authorName?: string;
          isOfficial?: boolean;
        }
      | undefined;

    if (!manifest) return {};

    return {
      displayName: manifest.name,
      description: manifest.description,
      category: manifest.category,
      tags: manifest.tags,
      authorName: manifest.authorName,
      isOfficial: manifest.isOfficial,
    };
  }

  /**
   * Update the index with a new template version
   */
  private updateIndex(
    slug: string,
    version: string,
    metadata: { checksum: string; size: number },
    displayFields?: {
      displayName?: string;
      description?: string | null;
      category?: string;
      tags?: string[];
      authorName?: string;
      isOfficial?: boolean;
    },
  ): void {
    if (!this.index.templates[slug]) {
      this.index.templates[slug] = {
        versions: {},
        latestVersion: version,
      };
    }

    this.index.templates[slug].versions[version] = {
      cachedAt: new Date().toISOString(),
      checksum: metadata.checksum,
      size: metadata.size,
    };

    // Update display fields from _manifest if provided
    if (displayFields) {
      if (displayFields.displayName !== undefined) {
        this.index.templates[slug].displayName = displayFields.displayName;
      }
      if (displayFields.description !== undefined) {
        this.index.templates[slug].description = displayFields.description;
      }
      if (displayFields.category !== undefined) {
        this.index.templates[slug].category = displayFields.category;
      }
      if (displayFields.tags !== undefined) {
        this.index.templates[slug].tags = displayFields.tags;
      }
      if (displayFields.authorName !== undefined) {
        this.index.templates[slug].authorName = displayFields.authorName;
      }
      if (displayFields.isOfficial !== undefined) {
        this.index.templates[slug].isOfficial = displayFields.isOfficial;
      }
    }

    // Update latest version using proper semver comparison
    const versions = Object.keys(this.index.templates[slug].versions);
    const latestVersion = getLatestVersion(versions) ?? version;
    this.index.templates[slug].latestVersion = latestVersion;
  }

  /**
   * Remove a version from the index
   */
  private removeFromIndex(slug: string, version: string): void {
    if (!this.index.templates[slug]) return;

    delete this.index.templates[slug].versions[version];

    // If no versions left, remove the template entry
    const remainingVersions = Object.keys(this.index.templates[slug].versions);
    if (remainingVersions.length === 0) {
      delete this.index.templates[slug];
    } else {
      // Update latest version using proper semver comparison
      const latest = getLatestVersion(remainingVersions) ?? remainingVersions[0];
      this.index.templates[slug].latestVersion = latest;
    }
  }

  /**
   * Save downloaded template to cache
   *
   * @param slug Template slug
   * @param version Template version
   * @param content Template content (ExportSchema)
   * @param metadata Version metadata
   */
  async saveTemplate(
    slug: string,
    version: string,
    content: Record<string, unknown>,
    metadata: Omit<VersionMetadata, 'slug' | 'version'>,
  ): Promise<void> {
    const dir = join(this.cacheDir, 'templates', slug, version);

    try {
      // Create directory
      await fs.mkdir(dir, { recursive: true });

      // Write template content
      const contentStr = JSON.stringify(content, null, 2);
      await fs.writeFile(join(dir, 'template.json'), contentStr);

      // Write metadata
      const fullMetadata: VersionMetadata = {
        ...metadata,
        slug,
        version,
      };
      const metadataPath = join(dir, 'metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(fullMetadata, null, 2));

      // Extract display fields from _manifest for O(1) listing
      const displayFields = this.extractDisplayFields(content);

      // Update index with display fields
      this.updateIndex(
        slug,
        version,
        {
          checksum: metadata.checksum,
          size: metadata.size,
        },
        displayFields,
      );
      await this.saveIndex();

      logger.info({ slug, version }, 'Template cached');
    } catch (error) {
      logger.error(
        {
          slug,
          version,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to cache template',
      );
      throw error;
    }
  }

  /**
   * Get template from cache
   *
   * @param slug Template slug
   * @param version Template version
   * @returns Cached template or null if not found
   */
  async getTemplate(slug: string, version: string): Promise<CachedTemplate | null> {
    const dir = join(this.cacheDir, 'templates', slug, version);

    try {
      const [contentStr, metadataStr] = await Promise.all([
        fs.readFile(join(dir, 'template.json'), 'utf-8'),
        fs.readFile(join(dir, 'metadata.json'), 'utf-8'),
      ]);

      const content = JSON.parse(contentStr) as Record<string, unknown>;
      const metadata = JSON.parse(metadataStr) as VersionMetadata;

      return { content, metadata };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      logger.warn(
        {
          slug,
          version,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to read cached template',
      );
      return null;
    }
  }

  /**
   * Check if template version is cached (quick lookup via index)
   *
   * @param slug Template slug
   * @param version Template version
   * @returns True if cached
   */
  isCached(slug: string, version: string): boolean {
    return !!this.index.templates[slug]?.versions[version];
  }

  /**
   * List all cached templates
   *
   * @returns Array of cached template info with display fields
   */
  listCached(): CachedTemplateInfo[] {
    return Object.entries(this.index.templates).map(([slug, info]) => ({
      slug,
      versions: Object.keys(info.versions),
      latestCached: info.latestVersion,
      // Include display fields from _manifest for O(1) listing
      displayName: info.displayName,
      description: info.description,
      category: info.category,
      tags: info.tags,
      authorName: info.authorName,
      isOfficial: info.isOfficial,
    }));
  }

  /**
   * Remove specific version from cache
   *
   * @param slug Template slug
   * @param version Template version
   */
  async removeVersion(slug: string, version: string): Promise<void> {
    const dir = join(this.cacheDir, 'templates', slug, version);

    try {
      await fs.rm(dir, { recursive: true, force: true });

      // Clean up empty parent directory if needed
      const slugDir = join(this.cacheDir, 'templates', slug);
      try {
        const remaining = await fs.readdir(slugDir);
        if (remaining.length === 0) {
          await fs.rm(slugDir, { recursive: true, force: true });
        }
      } catch {
        // Ignore errors checking parent directory
      }

      this.removeFromIndex(slug, version);
      await this.saveIndex();

      logger.info({ slug, version }, 'Template version removed from cache');
    } catch (error) {
      logger.error(
        {
          slug,
          version,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to remove cached template version',
      );
      throw error;
    }
  }

  /**
   * Clear entire cache
   */
  async clearCache(): Promise<void> {
    const templatesDir = join(this.cacheDir, 'templates');

    try {
      await fs.rm(templatesDir, { recursive: true, force: true });

      this.index = { templates: {}, updatedAt: new Date().toISOString() };
      await this.saveIndex();

      logger.info('Cache cleared');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to clear cache',
      );
      throw error;
    }
  }

  /**
   * Get cache size in bytes
   *
   * @returns Total size of cached templates in bytes
   */
  async getCacheSize(): Promise<number> {
    const templatesDir = join(this.cacheDir, 'templates');

    try {
      return await this.getDirectorySize(templatesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to calculate cache size',
      );
      return 0;
    }
  }

  /**
   * Recursively calculate directory size
   */
  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;

    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        totalSize += await this.getDirectorySize(entryPath);
      } else if (entry.isFile()) {
        const stats = await fs.stat(entryPath);
        totalSize += stats.size;
      }
    }

    return totalSize;
  }

  /**
   * Get the cache directory path
   */
  getCacheDir(): string {
    return this.cacheDir;
  }

  /**
   * Get the current cache index
   */
  getIndex(): CacheIndex {
    return { ...this.index };
  }
}
