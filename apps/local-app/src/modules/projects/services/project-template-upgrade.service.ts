import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { ValidationError, NotFoundError } from '../../../common/errors/error-types';
import type { PromptReferenceValidationFailure } from '../../../common/prompt-references';
import { PROMPT_TRANSFER_POLICY, type PromptTransferCounts } from '../../../common/prompt-transfer';
import { buildActiveSessionReadiness, type ImportReadiness } from '../helpers/project-import';
import type { SetupPreviewResponse } from '../dtos/setup-preview.dto';
import { TemplateCacheService } from '../../registry/services/template-cache.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SettingsService } from '../../settings/services/settings.service';
import { ProjectsService, type ImportProjectInput } from './projects.service';
import { ProjectWriteAdmissionService } from '../../remotes/admission/project-write-admission.service';

const logger = createLogger('ProjectTemplateUpgradeService');

interface BackupEntry {
  projectId: string;
  data: unknown;
  activePreset: string | null;
  createdAt: string;
  templateSlug: string;
  fromVersion: string;
  source: 'bundled' | 'registry' | 'file';
}

export interface UpgradeProjectInput
  extends Pick<
    ImportProjectInput,
    | 'selectedProviderNames'
    | 'familyProviderMappings'
    | 'presetName'
    | 'agentOverrides'
    | 'teamOverrides'
    | 'statusMappings'
  > {
  projectId: string;
  targetVersion: string;
}

export interface UpgradePreviewInput {
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
  /** Exact template prompt outcome on successful upgrade. */
  promptTransfer?: PromptTransferCounts;
  /** False when template validation rejected the upgrade before project mutation. */
  mutationStarted?: false;
  /** Actionable prompt references when a template would skip required prompts. */
  promptReferenceValidation?: PromptReferenceValidationFailure['promptReferenceValidation'];
  /** Structured replace-import readiness details for non-mutating failures. */
  readiness?: ImportReadiness;
}

export type UpgradePreviewResult = SetupPreviewResponse | UpgradeResult;

type ProjectTemplateMetadata = NonNullable<
  ReturnType<SettingsService['getProjectTemplateMetadata']>
>;

type ResolvedUpgradeTarget = {
  metadata: ProjectTemplateMetadata;
  source: 'bundled' | 'registry';
  content: Record<string, unknown>;
  preview: SetupPreviewResponse;
};

type UpgradeTargetResolution =
  | { success: true; target: ResolvedUpgradeTarget }
  | { success: false; result: UpgradeResult };

/**
 * Projects-owned service for upgrading projects to newer template versions
 * Handles backup creation, template application, and rollback
 */
@Injectable()
export class ProjectTemplateUpgradeService implements OnModuleInit, OnModuleDestroy {
  // In-memory backup storage (temporary, cleared on restart)
  private backups = new Map<string, BackupEntry>();

  // Backup expiration time (1 hour)
  private readonly BACKUP_EXPIRATION_MS = 60 * 60 * 1000;

  // Cleanup timer handle
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly cacheService: TemplateCacheService,
    private readonly unifiedTemplateService: UnifiedTemplateService,
    private readonly settingsService: SettingsService,
    private readonly sessionsService: SessionsService,
    private readonly admission: ProjectWriteAdmissionService,
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

    const activePreset = this.settingsService.getProjectActivePreset(projectId);

    // Export current project state without redacting profile-config env. Provider-level env
    // continues through the exporter's fixed sanitizer.
    const exportData = await this.projectsService.exportProject(projectId, {
      profileConfigEnvTransform: (env) => env ?? null,
    });

    // Generate backup ID
    const backupId = `backup-${projectId}-${Date.now()}`;

    // Store backup with source for proper restore
    this.backups.set(backupId, {
      projectId,
      data: exportData,
      activePreset,
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
   * Resolve and validate the exact target from the project's persisted source metadata.
   * Preview and commit both call this method, so neither can silently switch between registry
   * cache and bundled content for the same requested version.
   */
  private async resolveUpgradeTarget(input: UpgradePreviewInput): Promise<UpgradeTargetResolution> {
    const { projectId, targetVersion } = input;
    const metadata = this.settingsService.getProjectTemplateMetadata(projectId);
    if (!metadata) {
      return this.targetFailure('Project not linked to a template');
    }
    if (!metadata.installedVersion) {
      return this.targetFailure('Cannot upgrade: project has no installed version');
    }
    if (metadata.installedVersion === targetVersion) {
      return this.targetFailure('Project is already at this version');
    }

    const source = metadata.source ?? 'registry';
    if (source === 'file') {
      return this.targetFailure('File-based templates cannot be upgraded');
    }

    let content: Record<string, unknown>;
    if (source === 'bundled') {
      try {
        content = this.unifiedTemplateService.getBundledTemplate(metadata.templateSlug)
          .content as Record<string, unknown>;
      } catch (error) {
        if (error instanceof NotFoundError) {
          return this.targetFailure(`Bundled template "${metadata.templateSlug}" not found`);
        }
        logger.warn(
          { projectId, templateSlug: metadata.templateSlug, targetVersion, error },
          'Bundled upgrade target could not be loaded',
        );
        return this.targetFailure(`Bundled template "${metadata.templateSlug}" is invalid`);
      }
    } else {
      const cached = await this.cacheService.getTemplate(metadata.templateSlug, targetVersion);
      if (!cached) {
        logger.warn(
          { projectId, templateSlug: metadata.templateSlug, targetVersion },
          'Upgrade attempted with uncached version',
        );
        return this.targetFailure(
          `Version ${targetVersion} is not cached. Please download it first from the Registry page.`,
        );
      }
      content = cached.content as Record<string, unknown>;
    }

    const manifest = content._manifest as { version?: unknown } | undefined;
    const manifestVersion = typeof manifest?.version === 'string' ? manifest.version : 'unknown';
    if (manifestVersion !== targetVersion) {
      const sourceLabel = source === 'bundled' ? 'Bundled' : 'Cached';
      return this.targetFailure(
        `${sourceLabel} template version is ${manifestVersion}, not ${targetVersion}`,
      );
    }

    try {
      const preview = await this.projectsService.setupPreview({ rawContent: content });
      return {
        success: true,
        target: { metadata, source, content, preview },
      };
    } catch (error) {
      logger.warn(
        { projectId, templateSlug: metadata.templateSlug, targetVersion, error },
        'Upgrade target content failed setup-preview validation',
      );
      return this.targetFailure('Target template content is invalid');
    }
  }

  private targetFailure(error: string): UpgradeTargetResolution {
    return {
      success: false,
      result: { success: false, mutationStarted: false, error },
    };
  }

  async previewUpgrade(input: UpgradePreviewInput): Promise<UpgradePreviewResult> {
    logger.info(input, 'Resolving project upgrade preview');
    const resolution = await this.resolveUpgradeTarget(input);
    return resolution.success ? resolution.target.preview : resolution.result;
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
    this.admission.assertWritable(projectId);

    const resolution = await this.resolveUpgradeTarget({ projectId, targetVersion });
    if (!resolution.success) {
      return resolution.result;
    }
    const { metadata, source, content: templateContent } = resolution.target;

    const activeSessions = this.sessionsService
      .getActiveSessionsForProject(projectId)
      .map((session) => ({ id: session.id, agentId: session.agentId }));
    if (activeSessions.length > 0) {
      const readiness = buildActiveSessionReadiness(activeSessions);
      return {
        success: false,
        mutationStarted: false,
        error: readiness.issues[0]?.message ?? 'Active agent sessions block template upgrade',
        readiness,
      };
    }

    // Create backup before upgrade
    let backupId: string;
    try {
      backupId = await this.createBackup(projectId);
    } catch (error) {
      return {
        success: false,
        mutationStarted: false,
        error: `Failed to create backup: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      const importResult = await this.projectsService.importProject({
        projectId,
        payload: templateContent,
        dryRun: false,
        ...(input.selectedProviderNames !== undefined
          ? { selectedProviderNames: input.selectedProviderNames }
          : {}),
        ...(input.familyProviderMappings !== undefined
          ? { familyProviderMappings: input.familyProviderMappings }
          : {}),
        ...(input.presetName !== undefined ? { presetName: input.presetName } : {}),
        ...(input.agentOverrides !== undefined ? { agentOverrides: input.agentOverrides } : {}),
        ...(input.teamOverrides !== undefined ? { teamOverrides: input.teamOverrides } : {}),
        ...(input.statusMappings !== undefined ? { statusMappings: input.statusMappings } : {}),
      });

      if (!('success' in importResult) || !importResult.success) {
        logger.error({ projectId, targetVersion, importResult }, 'Import returned failure status');

        let importError = 'Template import failed';
        if ('error' in importResult && typeof importResult.error === 'string') {
          importError = importResult.error;
        }

        const failure: UpgradeResult = { success: false, error: importError };
        const mutationDidNotStart =
          'mutationStarted' in importResult && importResult.mutationStarted === false;
        if (mutationDidNotStart) {
          this.backups.delete(backupId);
          failure.mutationStarted = false;
        } else {
          failure.backupId = backupId;
        }
        if ('promptReferenceValidation' in importResult) {
          failure.promptReferenceValidation = importResult.promptReferenceValidation;
        }
        if ('readiness' in importResult) {
          failure.readiness = importResult.readiness;
        }
        return failure;
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
          source,
          fromVersion: metadata.installedVersion,
          toVersion: targetVersion,
        },
        'Project upgraded successfully',
      );

      return {
        success: true,
        newVersion: targetVersion,
        ...('promptTransfer' in importResult
          ? { promptTransfer: importResult.promptTransfer }
          : {}),
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
    this.admission.assertWritable(backup.projectId);

    // Restore project state
    const importResult = await this.projectsService.importProject({
      projectId: backup.projectId,
      payload: backup.data,
      dryRun: false,
      promptTransferPolicy: PROMPT_TRANSFER_POLICY.Snapshot,
    });
    if (!('success' in importResult) || importResult.success !== true) {
      const detail =
        'error' in importResult && typeof importResult.error === 'string'
          ? `: ${importResult.error}`
          : '';
      throw new Error(`Backup restore import failed${detail}`);
    }

    // Restore original metadata with correct source
    await this.settingsService.setProjectTemplateMetadata(backup.projectId, {
      templateSlug: backup.templateSlug,
      source: backup.source,
      installedVersion: backup.fromVersion,
      registryUrl:
        backup.source === 'registry' ? this.settingsService.getRegistryConfig().url : null,
      installedAt: new Date().toISOString(),
    });

    await this.settingsService.setProjectActivePreset(backup.projectId, backup.activePreset);

    // Remove backup only after every restored sidecar has been persisted.
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
