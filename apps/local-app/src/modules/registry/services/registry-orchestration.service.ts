import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { RegistryClientService } from './registry-client.service';
import { TemplateCacheService } from './template-cache.service';
import { SettingsService } from '../../settings/services/settings.service';
import { InstalledTemplate, UpdateInfo } from '../interfaces/registry.interface';

const logger = createLogger('RegistryOrchestrationService');

export type RegistryUpdateCheckState = 'pending' | 'complete' | 'skipped';

export interface RegistryProjectUpdateStatus {
  projectId: string;
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  changelog?: string;
}

export interface RegistryUpdateStatus {
  state: RegistryUpdateCheckState;
  results: RegistryProjectUpdateStatus[];
}

/**
 * Orchestration service for registry operations
 * Coordinates between registry client, cache, and project creation
 */
@Injectable()
export class RegistryOrchestrationService implements OnApplicationBootstrap {
  private updateCheckState: RegistryUpdateCheckState = 'pending';
  private readonly updateResults = new Map<
    string,
    Omit<RegistryProjectUpdateStatus, 'projectId'>
  >();

  constructor(
    private readonly registryClient: RegistryClientService,
    private readonly cacheService: TemplateCacheService,
    private readonly settingsService: SettingsService,
  ) {}

  onApplicationBootstrap(): void {
    void this.runStartupUpdateCheck().catch((error) => {
      this.updateCheckState = 'skipped';
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Startup registry update check failed',
      );
    });
  }

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

  getUpdateStatus(): RegistryUpdateStatus {
    return {
      state: this.updateCheckState,
      results: Array.from(this.updateResults.entries()).map(([projectId, result]) => ({
        projectId,
        ...result,
      })),
    };
  }

  private async runStartupUpdateCheck(): Promise<void> {
    this.updateCheckState = 'pending';
    this.updateResults.clear();

    const { checkUpdatesOnStartup } = this.settingsService.getRegistryConfig();
    if (!checkUpdatesOnStartup) {
      this.updateCheckState = 'skipped';
      logger.debug('Startup registry update check skipped by settings');
      return;
    }

    const registryAvailable = await this.registryClient.isAvailable();
    if (!registryAvailable) {
      this.updateCheckState = 'skipped';
      logger.warn('Startup registry update check skipped: registry unavailable');
      return;
    }

    const trackedProjects = this.settingsService.getAllTrackedProjects();
    if (trackedProjects.length === 0) {
      this.updateCheckState = 'complete';
      logger.info('Startup registry update check completed: no tracked projects');
      return;
    }

    const projectsToCheck = trackedProjects.filter(({ metadata }) => {
      const hasInstalledVersion = metadata.installedVersion !== null;
      const isRegistrySource = metadata.source === 'registry' || metadata.source === undefined;
      return hasInstalledVersion && isRegistrySource;
    });

    if (projectsToCheck.length === 0) {
      this.updateCheckState = 'complete';
      logger.info(
        { trackedProjects: trackedProjects.length },
        'Startup registry update check completed: no eligible registry projects',
      );
      return;
    }

    const dedupedInstalled = new Map<string, InstalledTemplate>();
    for (const { metadata } of projectsToCheck) {
      if (!metadata.installedVersion) {
        continue;
      }
      const dedupeKey = `${metadata.templateSlug}::${metadata.installedVersion}`;
      if (!dedupedInstalled.has(dedupeKey)) {
        dedupedInstalled.set(dedupeKey, {
          slug: metadata.templateSlug,
          version: metadata.installedVersion,
        });
      }
    }

    const updates = await this.registryClient.checkForUpdates(
      Array.from(dedupedInstalled.values()),
    );
    const updatesBySlugAndVersion = new Map<string, UpdateInfo>();
    for (const update of updates) {
      updatesBySlugAndVersion.set(`${update.slug}::${update.currentVersion}`, update);
    }

    for (const { projectId, metadata } of projectsToCheck) {
      if (!metadata.installedVersion) {
        continue;
      }

      const key = `${metadata.templateSlug}::${metadata.installedVersion}`;
      const update = updatesBySlugAndVersion.get(key);
      if (update) {
        this.updateResults.set(projectId, {
          hasUpdate: true,
          currentVersion: metadata.installedVersion,
          latestVersion: update.latestVersion,
          changelog: update.changelog ?? undefined,
        });
      } else {
        this.updateResults.set(projectId, {
          hasUpdate: false,
          currentVersion: metadata.installedVersion,
        });
      }
    }

    await Promise.allSettled(
      projectsToCheck.map(({ projectId }) => this.settingsService.updateLastUpdateCheck(projectId)),
    );

    this.updateCheckState = 'complete';
    logger.info(
      {
        trackedProjects: trackedProjects.length,
        checkedProjects: projectsToCheck.length,
        dedupedTemplates: dedupedInstalled.size,
        updatesAvailable: updates.length,
      },
      'Startup registry update check completed',
    );
  }
}
