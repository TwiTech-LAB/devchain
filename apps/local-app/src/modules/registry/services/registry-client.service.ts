import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import * as semver from 'semver';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import {
  RegistryError,
  RegistryUnavailableError,
  ChecksumMismatchError,
} from '../dtos/registry-error';
import {
  TemplateListResponse,
  TemplateDetailResponse,
  DownloadResult,
  InstalledTemplate,
  UpdateInfo,
  ListTemplatesQuery,
} from '../interfaces/registry.interface';

const logger = createLogger('RegistryClientService');

// Timeout configuration
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Client service for communicating with the Template Registry
 *
 * URL Configuration Priority:
 * 1. Settings (stored in DB via SettingsService)
 * 2. Environment variable (REGISTRY_URL)
 * 3. Default (https://templates.devchain.twitechlab.com)
 */
@Injectable()
export class RegistryClientService {
  constructor(private readonly settingsService: SettingsService) {
    logger.info('RegistryClientService initialized');
  }

  /**
   * Get the current registry base URL from settings
   * URL is retrieved dynamically to reflect settings changes immediately
   */
  private getBaseUrl(): string {
    return this.settingsService.getRegistryConfig().url;
  }

  /**
   * List templates with optional filters and pagination
   */
  async listTemplates(query?: ListTemplatesQuery): Promise<TemplateListResponse> {
    const params = new URLSearchParams();

    if (query?.search) params.set('search', query.search);
    if (query?.category) params.set('category', query.category);
    if (query?.tags && query.tags.length > 0) params.set('tags', query.tags.join(','));
    if (query?.page) params.set('page', String(query.page));
    if (query?.limit) params.set('limit', String(query.limit));
    if (query?.sort) params.set('sort', query.sort);
    if (query?.order) params.set('order', query.order);

    const url = `${this.getBaseUrl()}/api/v1/templates${params.toString() ? `?${params}` : ''}`;

    try {
      const response = await this.fetchWithTimeout(url);

      if (!response.ok) {
        throw new RegistryError(
          `Failed to fetch templates: ${response.status} ${response.statusText}`,
        );
      }

      return (await response.json()) as TemplateListResponse;
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      throw new RegistryError(
        'Failed to fetch templates',
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get template details with all versions
   * Returns null if template not found
   */
  async getTemplate(slug: string): Promise<TemplateDetailResponse | null> {
    const url = `${this.getBaseUrl()}/api/v1/templates/${encodeURIComponent(slug)}`;

    try {
      const response = await this.fetchWithTimeout(url);

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new RegistryError(
          `Failed to fetch template: ${response.status} ${response.statusText}`,
        );
      }

      return (await response.json()) as TemplateDetailResponse;
    } catch (error) {
      if (error instanceof RegistryError) throw error;
      throw new RegistryError(
        `Failed to fetch template "${slug}"`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Download template with checksum verification
   */
  async downloadTemplate(slug: string, version: string): Promise<DownloadResult> {
    const url = `${this.getBaseUrl()}/api/v1/download/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`;

    try {
      const response = await this.fetchWithTimeout(url);

      if (response.status === 404) {
        throw new RegistryError(`Template "${slug}" version "${version}" not found`);
      }

      if (!response.ok) {
        throw new RegistryError(
          `Failed to download template: ${response.status} ${response.statusText}`,
        );
      }

      const expectedChecksum = response.headers.get('X-Checksum-SHA256');

      // Get raw response text first to compute checksum on exact bytes received
      // This ensures checksum matches server computation regardless of JSON formatting
      const rawText = await response.text();

      // Compute checksum on raw response bytes (not re-stringified JSON)
      const computedChecksum = crypto.createHash('sha256').update(rawText).digest('hex');

      // Verify checksum if provided
      if (expectedChecksum && computedChecksum !== expectedChecksum) {
        throw new ChecksumMismatchError(expectedChecksum, computedChecksum);
      }

      // Parse JSON after checksum verification
      const content = JSON.parse(rawText) as Record<string, unknown>;

      logger.info(
        { slug, version, checksum: computedChecksum.substring(0, 16) + '...' },
        'Template downloaded and verified',
      );

      return {
        content,
        checksum: computedChecksum,
        slug,
        version,
      };
    } catch (error) {
      if (error instanceof RegistryError || error instanceof ChecksumMismatchError) {
        throw error;
      }
      throw new RegistryError(
        `Failed to download template "${slug}" version "${version}"`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Check for updates for installed templates
   * Returns list of templates with available updates
   */
  async checkForUpdates(installed: InstalledTemplate[]): Promise<UpdateInfo[]> {
    const updates: UpdateInfo[] = [];

    for (const template of installed) {
      try {
        const remote = await this.getTemplate(template.slug);

        if (!remote) {
          logger.debug({ slug: template.slug }, 'Template not found in registry');
          continue;
        }

        const latestVersion = remote.versions.find((v) => v.isLatest);

        if (
          latestVersion &&
          semver.valid(latestVersion.version) &&
          semver.valid(template.version)
        ) {
          if (semver.gt(latestVersion.version, template.version)) {
            updates.push({
              slug: template.slug,
              currentVersion: template.version,
              latestVersion: latestVersion.version,
              changelog: latestVersion.changelog,
            });

            logger.info(
              {
                slug: template.slug,
                current: template.version,
                latest: latestVersion.version,
              },
              'Update available',
            );
          }
        }
      } catch (error) {
        // Log warning but don't fail the entire check
        logger.warn(
          { slug: template.slug, error: error instanceof Error ? error.message : String(error) },
          'Failed to check for updates',
        );
      }
    }

    return updates;
  }

  /**
   * Check if the registry is available
   * Uses a short timeout to avoid blocking
   */
  async isAvailable(): Promise<boolean> {
    const healthUrl = `${this.getBaseUrl()}/health`;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

      try {
        const response = await fetch(healthUrl, {
          signal: controller.signal,
        });

        return response.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      logger.debug(
        { healthUrl, error: error instanceof Error ? error.message : String(error) },
        'Registry health check failed',
      );
      return false;
    }
  }

  /**
   * Get the configured registry URL
   * Returns the current URL from settings (reflects changes immediately)
   */
  getRegistryUrl(): string {
    return this.getBaseUrl();
  }

  /**
   * Fetch with timeout
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new RegistryUnavailableError('Request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
