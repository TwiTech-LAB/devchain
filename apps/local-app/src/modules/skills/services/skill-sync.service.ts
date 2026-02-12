import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { NotFoundError, TimeoutError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import {
  SKILL_SOURCE_ADAPTERS,
  SkillManifest,
  SkillSourceAdapter,
  SkillSourceSyncContext,
} from '../adapters/skill-source.adapter';
import { Skill } from '../../storage/models/domain.models';
import { SkillCategoryService } from './skill-category.service';
import { SkillsService } from './skills.service';

const logger = createLogger('SkillSyncService');

export interface SyncError {
  sourceName: string;
  skillSlug?: string;
  message: string;
}

export interface SyncResult {
  status: 'completed' | 'already_running';
  added: number;
  updated: number;
  failed: number;
  unchanged: number;
  errors: SyncError[];
}

@Injectable()
export class SkillSyncService implements OnApplicationBootstrap {
  private syncInProgress = false;

  constructor(
    @Inject(SKILL_SOURCE_ADAPTERS) private readonly adapters: SkillSourceAdapter[],
    private readonly skillsService: SkillsService,
    private readonly skillCategoryService: SkillCategoryService,
    private readonly settingsService: SettingsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.settingsService.getSkillsSyncOnStartup()) {
      logger.info('Startup skills sync disabled via settings');
      return;
    }

    void this.syncAll().catch((error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Startup skills sync failed',
      );
    });
  }

  async syncAll(): Promise<SyncResult> {
    return this.withMutex(async () => {
      const sourceSettings = this.settingsService.getSkillSourcesEnabled();
      const enabledAdapters = this.adapters.filter((adapter) =>
        this.isSourceEnabled(adapter.sourceName, sourceSettings),
      );

      for (const adapter of this.adapters) {
        if (!this.isSourceEnabled(adapter.sourceName, sourceSettings)) {
          logger.info(
            { sourceName: adapter.sourceName },
            'Skill sync skipped because source is disabled',
          );
        }
      }

      if (enabledAdapters.length === 0) {
        return this.createEmptyResult();
      }

      const settledResults = await Promise.allSettled(
        enabledAdapters.map((adapter) => this.syncAdapter(adapter)),
      );

      return settledResults.reduce<SyncResult>((acc, result, index) => {
        if (result.status === 'fulfilled') {
          return this.mergeSyncResults(acc, result.value);
        }

        const adapterName = enabledAdapters[index]?.sourceName ?? 'unknown';
        acc.failed += 1;
        acc.errors.push({
          sourceName: adapterName,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        return acc;
      }, this.createEmptyResult());
    });
  }

  async syncSource(sourceName: string): Promise<SyncResult> {
    const normalizedSourceName = sourceName.trim().toLowerCase();
    const adapter = this.adapters.find((item) => item.sourceName === normalizedSourceName);
    if (!adapter) {
      throw new ValidationError(`Unknown skill source: ${normalizedSourceName}`, {
        sourceName: normalizedSourceName,
      });
    }

    if (
      !this.isSourceEnabled(normalizedSourceName, this.settingsService.getSkillSourcesEnabled())
    ) {
      logger.info(
        { sourceName: normalizedSourceName },
        'Skill sync skipped because source is disabled',
      );
      return this.createEmptyResult();
    }

    return this.withMutex(() => this.syncAdapter(adapter));
  }

  private async withMutex(run: () => Promise<SyncResult>): Promise<SyncResult> {
    if (this.syncInProgress) {
      logger.info('Skill sync skipped because another sync is already running');
      return this.createAlreadyRunningResult();
    }

    this.syncInProgress = true;
    try {
      return await run();
    } finally {
      this.syncInProgress = false;
    }
  }

  private async syncAdapter(adapter: SkillSourceAdapter): Promise<SyncResult> {
    const result = this.createEmptyResult();
    let sourceCommit = '';
    let syncContext: SkillSourceSyncContext | null = null;

    try {
      sourceCommit = await adapter.getLatestCommit();
      syncContext = await adapter.createSyncContext();
    } catch (error) {
      if (syncContext) {
        try {
          await syncContext.dispose();
        } catch (disposeError) {
          logger.warn(
            {
              sourceName: adapter.sourceName,
              error: disposeError instanceof Error ? disposeError.message : String(disposeError),
            },
            'Failed to dispose skill sync context after setup failure',
          );
        }
      }
      result.failed += 1;
      result.errors.push({
        sourceName: adapter.sourceName,
        message: error instanceof Error ? error.message : String(error),
      });
      return result;
    }

    if (!syncContext) {
      return result;
    }

    try {
      for (const [skillName, manifest] of syncContext.manifests.entries()) {
        const skillSlug = this.buildSkillSlug(adapter.sourceName, skillName);
        const existingSkill = await this.getExistingSkill(skillSlug);
        const isUnchanged =
          existingSkill &&
          existingSkill.sourceCommit === sourceCommit &&
          existingSkill.status !== 'sync_error';

        if (isUnchanged) {
          result.unchanged += 1;
          continue;
        }

        try {
          const contentPath = await syncContext.downloadSkill(skillName, '');
          await this.skillsService.upsertSkill(skillSlug, {
            name: manifest.name || skillName,
            displayName: manifest.displayName ?? manifest.name ?? skillName,
            description: manifest.description,
            shortDescription: manifest.shortDescription ?? null,
            source: adapter.sourceName,
            sourceUrl: manifest.sourceUrl,
            sourceCommit,
            category: this.skillCategoryService.deriveCategory(
              manifest.name || skillName,
              manifest.description,
              manifest.compatibility,
            ),
            license: manifest.license ?? null,
            compatibility: manifest.compatibility ?? null,
            frontmatter: manifest.frontmatter ?? {},
            instructionContent: manifest.instructionContent,
            contentPath,
            resources: manifest.resources,
            status: 'available',
            lastSyncedAt: new Date().toISOString(),
          });

          if (existingSkill) {
            result.updated += 1;
          } else {
            result.added += 1;
          }
        } catch (error) {
          result.failed += 1;
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors.push({
            sourceName: adapter.sourceName,
            skillSlug,
            message: errorMessage,
          });

          await this.markSkillSyncError({
            adapter,
            skillName,
            skillSlug,
            sourceCommit,
            manifest,
          });

          if (error instanceof TimeoutError) {
            logger.warn(
              { sourceName: adapter.sourceName, skillSlug, error: error.message },
              'Skill download timed out; skill marked as sync_error',
            );
          }
        }
      }
    } finally {
      try {
        await syncContext.dispose();
      } catch (error) {
        logger.warn(
          {
            sourceName: adapter.sourceName,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to dispose skill sync context',
        );
      }
    }

    return result;
  }

  private async markSkillSyncError(params: {
    adapter: SkillSourceAdapter;
    skillName: string;
    skillSlug: string;
    sourceCommit: string;
    manifest: SkillManifest;
  }): Promise<void> {
    try {
      await this.skillsService.upsertSkill(params.skillSlug, {
        name: params.manifest.name || params.skillName,
        displayName: params.manifest.displayName ?? params.manifest.name ?? params.skillName,
        description: params.manifest.description,
        shortDescription: params.manifest.shortDescription ?? null,
        source: params.adapter.sourceName,
        sourceUrl: params.manifest.sourceUrl,
        sourceCommit: params.sourceCommit,
        category: this.skillCategoryService.deriveCategory(
          params.manifest.name || params.skillName,
          params.manifest.description,
          params.manifest.compatibility,
        ),
        license: params.manifest.license ?? null,
        compatibility: params.manifest.compatibility ?? null,
        frontmatter: params.manifest.frontmatter ?? {},
        instructionContent: params.manifest.instructionContent,
        resources: params.manifest.resources,
        status: 'sync_error',
      });
    } catch (error) {
      logger.error(
        {
          sourceName: params.adapter.sourceName,
          skillSlug: params.skillSlug,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to mark skill as sync_error after sync failure',
      );
    }
  }

  private buildSkillSlug(sourceName: string, skillName: string): string {
    const normalizedSource = sourceName.trim().toLowerCase();
    const normalizedSkill = skillName.trim().toLowerCase();
    return `${normalizedSource}/${normalizedSkill}`;
  }

  private async getExistingSkill(slug: string): Promise<Skill | null> {
    try {
      return await this.skillsService.getSkillBySlug(slug);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  private createEmptyResult(): SyncResult {
    return {
      status: 'completed',
      added: 0,
      updated: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    };
  }

  private createAlreadyRunningResult(): SyncResult {
    return {
      status: 'already_running',
      added: 0,
      updated: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    };
  }

  private mergeSyncResults(left: SyncResult, right: SyncResult): SyncResult {
    return {
      status: 'completed',
      added: left.added + right.added,
      updated: left.updated + right.updated,
      failed: left.failed + right.failed,
      unchanged: left.unchanged + right.unchanged,
      errors: [...left.errors, ...right.errors],
    };
  }

  private isSourceEnabled(sourceName: string, sourceSettings: Record<string, boolean>): boolean {
    const normalizedSourceName = sourceName.trim().toLowerCase();
    return sourceSettings[normalizedSourceName] !== false;
  }
}
