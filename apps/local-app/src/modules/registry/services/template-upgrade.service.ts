import { Injectable, Inject, forwardRef, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { ValidationError, NotFoundError } from '../../../common/errors/error-types';
import { RegistryOrchestrationService } from './registry-orchestration.service';
import { TemplateCacheService } from './template-cache.service';
import { UnifiedTemplateService } from './unified-template.service';
import { SettingsService } from '../../settings/services/settings.service';
import { ProjectsService } from '../../projects/services/projects.service';

const logger = createLogger('TemplateUpgradeService');

interface BackupEntry {
  projectId: string;
  data: unknown;
  createdAt: string;
  templateSlug: string;
  fromVersion: string;
  source: 'bundled' | 'registry';
}

export interface UpgradeProjectInput {
  projectId: string;
  targetVersion: string;
}

/**
 * Result of an upgrade operation (always-200-with-payload pattern)
 *
 * The upgrade endpoint always returns HTTP 200 with this structure,
 * allowing the UI to handle partial success states:
 *
 * - `success=true`: Upgrade succeeded, `newVersion` is set
 * - `success=false, restored=true`: Upgrade failed, auto-restore succeeded
 * - `success=false, restored=false`: Upgrade failed, auto-restore failed, `backupId` provided for manual restore
 * - `success=false, restored=undefined`: Pre-upgrade validation failed (no backup created)
 */
export interface UpgradeResult {
  /** Whether the upgrade succeeded */
  success: boolean;
  /** The new version after successful upgrade */
  newVersion?: string;
  /** Error message when upgrade failed */
  error?: string;
  /** True if auto-restore succeeded after upgrade failure */
  restored?: boolean;
  /** Backup ID for manual restore (only when restored=false) */
  backupId?: string;
}

/**
 * Service for upgrading projects to newer template versions
 * Handles backup creation, template application, and rollback
 */
@Injectable()
export class TemplateUpgradeService implements OnModuleInit, OnModuleDestroy {
  // In-memory backup storage (temporary, cleared on restart)
  private backups = new Map<string, BackupEntry>();

  // Backup expiration time (1 hour)
  private readonly BACKUP_EXPIRATION_MS = 60 * 60 * 1000;

  // Cleanup timer handle
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly orchestrationService: RegistryOrchestrationService,
    private readonly cacheService: TemplateCacheService,
    private readonly unifiedTemplateService: UnifiedTemplateService,
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => ProjectsService))
    private readonly projectsService: ProjectsService,
  ) {}

  onModuleInit(): void {
    // Cleanup expired backups periodically
    this.cleanupTimer = setInterval(() => this.cleanupExpiredBackups(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Create a backup of the current project state before upgrade
   *
   * **Error Handling Pattern: HTTP Exceptions**
   *
   * This method throws exceptions for invalid states. When called internally
   * by `upgradeProject()`, exceptions are caught and converted to result objects.
   *
   * @throws {NotFoundError} When project has no template metadata (404)
   * @throws {ValidationError} When project has no installed version (unknown state)
   */
  async createBackup(projectId: string): Promise<string> {
    logger.info({ projectId }, 'Creating backup before upgrade');

    // Get current metadata
    const metadata = this.settingsService.getProjectTemplateMetadata(projectId);
    if (!metadata) {
      throw new NotFoundError('Project template metadata', projectId);
    }

    // Must have installedVersion to know what we're upgrading from
    if (!metadata.installedVersion) {
      throw new ValidationError('Cannot upgrade: project has no installed version', {
        projectId,
        templateSlug: metadata.templateSlug,
      });
    }

    // Export current project state
    const exportData = await this.projectsService.exportProject(projectId);

    // Generate backup ID
    const backupId = `backup-${projectId}-${Date.now()}`;

    // Store backup with source for proper restore
    this.backups.set(backupId, {
      projectId,
      data: exportData,
      createdAt: new Date().toISOString(),
      templateSlug: metadata.templateSlug,
      fromVersion: metadata.installedVersion,
      source: metadata.source ?? 'registry',
    });

    logger.info(
      { projectId, backupId, templateSlug: metadata.templateSlug, source: metadata.source },
      'Backup created successfully',
    );

    return backupId;
  }

  /**
   * Upgrade a project to a newer template version
   *
   * **Error Handling Pattern: Always-200-with-payload**
   *
   * This method uses a result-object pattern (always returns 200 with `UpgradeResult`)
   * rather than throwing HTTP exceptions. This is intentional because:
   *
   * 1. **Partial success states**: Upgrade can fail but auto-restore can succeed,
   *    requiring rich response payloads (`success`, `restored`, `backupId`)
   * 2. **Recovery context**: On failure, the caller needs `backupId` for manual restore
   * 3. **UI handling**: Frontend dialogs handle specific result shapes, not HTTP errors
   *
   * Compare with `restoreBackup()` which uses HTTP exceptions since it's a
   * simple pass/fail operation without partial states.
   *
   * @see UpgradeResult for the response structure
   */
  async upgradeProject(input: UpgradeProjectInput): Promise<UpgradeResult> {
    const { projectId, targetVersion } = input;

    logger.info({ projectId, targetVersion }, 'Starting project upgrade');

    // Get current metadata
    const metadata = this.settingsService.getProjectTemplateMetadata(projectId);
    if (!metadata) {
      return {
        success: false,
        error: 'Project not linked to a template',
      };
    }

    // Check if already at target version
    if (metadata.installedVersion === targetVersion) {
      return {
        success: false,
        error: 'Project is already at this version',
      };
    }

    const isBundled = metadata.source === 'bundled';
    let templateContent: Record<string, unknown>;

    if (isBundled) {
      // Bundled template: fetch from local bundled templates
      try {
        const bundled = this.unifiedTemplateService.getBundledTemplate(metadata.templateSlug);
        templateContent = bundled.content as Record<string, unknown>;

        // Verify the bundled template has the target version
        const manifest = templateContent._manifest as { version?: string } | undefined;
        if (manifest?.version !== targetVersion) {
          return {
            success: false,
            error: `Bundled template version is ${manifest?.version ?? 'unknown'}, not ${targetVersion}`,
          };
        }
      } catch {
        return {
          success: false,
          error: `Bundled template "${metadata.templateSlug}" not found`,
        };
      }
    } else {
      // Registry template: validate target version is cached
      const cached = await this.cacheService.getTemplate(metadata.templateSlug, targetVersion);
      if (!cached) {
        logger.warn(
          { projectId, templateSlug: metadata.templateSlug, targetVersion },
          'Upgrade attempted with uncached version',
        );
        return {
          success: false,
          error: `Version ${targetVersion} is not cached. Please download it first from the Registry page.`,
        };
      }
      templateContent = cached.content as Record<string, unknown>;
    }

    // Create backup before upgrade
    let backupId: string;
    try {
      backupId = await this.createBackup(projectId);
    } catch (error) {
      return {
        success: false,
        error: `Failed to create backup: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      // Apply template (imports over existing project)
      const importResult = await this.projectsService.importProject({
        projectId,
        payload: templateContent,
        dryRun: false,
      });

      // Validate import succeeded - importProject can return { success: false } without throwing
      // Type guard: dryRun=false means result always has 'success' property, but TS needs help
      if (!('success' in importResult) || !importResult.success) {
        // Check if provider mapping is required
        if ('providerMappingRequired' in importResult && importResult.providerMappingRequired) {
          const { missingProviders } = importResult.providerMappingRequired;
          logger.warn(
            { projectId, targetVersion, missingProviders },
            'Upgrade requires provider mapping - aborting',
          );
          return {
            success: false,
            error: `Upgrade requires provider configuration. Missing providers: ${missingProviders.join(', ')}`,
            backupId, // Keep backup for retry after provider setup
          };
        }

        // Generic import failure
        logger.error({ projectId, targetVersion, importResult }, 'Import returned failure status');
        return {
          success: false,
          error: 'Template import failed',
          backupId, // Keep backup for manual recovery
        };
      }

      // Update metadata with new version
      await this.settingsService.setProjectTemplateMetadata(projectId, {
        ...metadata,
        installedVersion: targetVersion,
        installedAt: new Date().toISOString(),
      });

      // Clear backup after successful upgrade
      this.backups.delete(backupId);

      logger.info(
        {
          projectId,
          source: isBundled ? 'bundled' : 'registry',
          fromVersion: metadata.installedVersion,
          toVersion: targetVersion,
        },
        'Project upgraded successfully',
      );

      return {
        success: true,
        newVersion: targetVersion,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Upgrade failed';
      logger.error({ projectId, targetVersion, error: errorMessage }, 'Upgrade failed');

      // Attempt auto-restore
      try {
        await this.restoreBackup(backupId);
        logger.info({ projectId, backupId }, 'Auto-restore succeeded after upgrade failure');

        return {
          success: false,
          error: errorMessage,
          restored: true,
        };
      } catch (restoreError) {
        const restoreErrorMessage =
          restoreError instanceof Error ? restoreError.message : 'Restore failed';
        logger.error(
          { projectId, backupId, error: restoreErrorMessage },
          'Auto-restore failed after upgrade failure',
        );

        return {
          success: false,
          error: errorMessage,
          restored: false,
          backupId, // Keep for manual restore fallback
        };
      }
    }
  }

  /**
   * Restore from a backup after failed upgrade
   *
   * **Error Handling Pattern: HTTP Exceptions**
   *
   * This method throws exceptions (mapped to HTTP errors by the controller)
   * rather than returning result objects. This is intentional because:
   *
   * 1. **Simple pass/fail**: Restore either works completely or fails completely
   * 2. **No partial states**: Unlike upgrade, there's no recovery context needed
   * 3. **Standard API behavior**: 404 for missing backup, 500 for import failures
   *
   * When called internally by `upgradeProject()` for auto-restore, exceptions
   * are caught and converted to result-object fields (`restored: false`).
   *
   * @throws {NotFoundError} When backup doesn't exist (404)
   * @throws {Error} When project import fails (500)
   */
  async restoreBackup(backupId: string): Promise<void> {
    logger.info({ backupId }, 'Restoring from backup');

    const backup = this.backups.get(backupId);
    if (!backup) {
      throw new NotFoundError('Backup', backupId);
    }

    // Restore project state
    await this.projectsService.importProject({
      projectId: backup.projectId,
      payload: backup.data,
      dryRun: false,
    });

    // Restore original metadata with correct source
    await this.settingsService.setProjectTemplateMetadata(backup.projectId, {
      templateSlug: backup.templateSlug,
      source: backup.source,
      installedVersion: backup.fromVersion,
      registryUrl:
        backup.source === 'registry' ? this.settingsService.getRegistryConfig().url : null,
      installedAt: new Date().toISOString(),
    });

    // Remove backup after restore
    this.backups.delete(backupId);

    logger.info(
      { backupId, projectId: backup.projectId, restoredVersion: backup.fromVersion },
      'Backup restored successfully',
    );
  }

  /**
   * Get backup info (for UI display)
   */
  getBackupInfo(
    backupId: string,
  ): { projectId: string; createdAt: string; fromVersion: string } | null {
    const backup = this.backups.get(backupId);
    if (!backup) return null;

    return {
      projectId: backup.projectId,
      createdAt: backup.createdAt,
      fromVersion: backup.fromVersion,
    };
  }

  /**
   * List active backups for a project
   */
  getProjectBackups(projectId: string): Array<{ backupId: string; createdAt: string }> {
    const backups: Array<{ backupId: string; createdAt: string }> = [];

    for (const [backupId, backup] of this.backups.entries()) {
      if (backup.projectId === projectId) {
        backups.push({
          backupId,
          createdAt: backup.createdAt,
        });
      }
    }

    return backups;
  }

  /**
   * Cleanup expired backups
   */
  private cleanupExpiredBackups(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [backupId, backup] of this.backups.entries()) {
      const backupTime = new Date(backup.createdAt).getTime();
      if (now - backupTime > this.BACKUP_EXPIRATION_MS) {
        this.backups.delete(backupId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned }, 'Cleaned up expired backups');
    }
  }
}
