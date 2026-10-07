import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NotFoundError, TimeoutError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import {
  SkillManifest,
  SkillSourceAdapter,
  SkillSourceSyncContext,
} from '../adapters/skill-source.adapter';
import { Skill } from '../../storage/models/domain.models';
import { SkillCategoryService } from './skill-category.service';
import { SkillSourceRegistryService } from './skill-source-registry.service';
import { SkillsService } from './skills.service';
import type { SyncOptions, SyncResult } from './skill-sync.types';

const logger = createLogger('SkillSyncService');

@Injectable()
export class SkillSyncService {
  constructor(
    private readonly skillSourceRegistry: SkillSourceRegistryService,
    private readonly skillsService: SkillsService,
    private readonly skillCategoryService: SkillCategoryService,
    private readonly settingsService: SettingsService,
  ) {}

  async syncAll(options: SyncOptions = {}): Promise<SyncResult> {
    const adapters = await this.skillSourceRegistry.getAdapters();
    const sourceSettings = this.settingsService.getSkillSourcesEnabled();
    const enabledAdapters = adapters.filter((adapter) =>
      this.isSourceEnabled(adapter.sourceName, sourceSettings),
    );

    for (const adapter of adapters) {
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
      enabledAdapters.map((adapter) => this.syncAdapter(adapter, options)),
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
  }

  async syncSource(sourceName: string, options: SyncOptions = {}): Promise<SyncResult> {
    const normalizedSourceName = sourceName.trim().toLowerCase();
    const adapter = await this.skillSourceRegistry.getAdapterBySourceName(normalizedSourceName);
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

    return this.syncAdapter(adapter, options);
  }

  private async syncAdapter(
    adapter: SkillSourceAdapter,
    options: SyncOptions,
  ): Promise<SyncResult> {
    const result = this.createEmptyResult();
    let sourceCommit = '';
    let syncContext: SkillSourceSyncContext | null = null;

    try {
      sourceCommit = await adapter.getLatestCommit();
      const completed = this.settingsService.getSkillsCompletedSyncs()[adapter.sourceName];
      if (!options.force && completed?.commit === sourceCommit) {
        const storedSkills = await this.skillsService.listSkillsBySource(adapter.sourceName);
        if (
          storedSkills.length === completed.skillCount &&
          storedSkills.every((skill) => skill.status !== 'sync_error')
        ) {
          result.unchanged = completed.skillCount;
          return result;
        }
      }
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
      // A skill that discovery could not read fails the run, so no completion entry hides it.
      for (const { skillName, message } of syncContext.discoveryErrors) {
        result.failed += 1;
        result.errors.push({
          sourceName: adapter.sourceName,
          skillSlug: this.buildSkillSlug(adapter.sourceName, skillName),
          message,
        });
      }

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

      const skillCount = await this.cleanupStaleSkills(adapter.sourceName, syncContext, result);
      if (result.failed === 0) {
        this.settingsService.setSkillCompletedSync(adapter.sourceName, {
          commit: sourceCommit,
          skillCount,
        });
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

  /** Removes skills the source no longer lists; returns the count of skills kept. */
  private async cleanupStaleSkills(
    sourceName: string,
    syncContext: SkillSourceSyncContext,
    result: SyncResult,
  ): Promise<number> {
    const expectedSlugs = new Set(
      Array.from(syncContext.manifests.keys()).map((skillName) =>
        this.buildSkillSlug(sourceName, skillName),
      ),
    );
    const existingSkills = await this.skillsService.listSkillsBySource(sourceName);
    let keptCount = 0;

    for (const existingSkill of existingSkills) {
      if (expectedSlugs.has(existingSkill.slug)) {
        keptCount += 1;
        continue;
      }

      const skillNameFromSlug = this.extractSkillNameFromSlug(existingSkill.slug, sourceName);
      try {
        if (skillNameFromSlug) {
          await this.deleteSyncedSkillDirectory(sourceName, skillNameFromSlug);
        }

        const wasDeleted = await this.skillsService.deleteSkillBySlug(existingSkill.slug);
        if (wasDeleted) {
          result.removed += 1;
        }
      } catch (error) {
        result.failed += 1;
        result.errors.push({
          sourceName,
          skillSlug: existingSkill.slug,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return keptCount;
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

  private extractSkillNameFromSlug(slug: string, sourceName: string): string | null {
    const normalizedSlug = slug.trim().toLowerCase();
    const sourcePrefix = `${sourceName.trim().toLowerCase()}/`;
    if (!normalizedSlug.startsWith(sourcePrefix)) {
      return null;
    }

    const skillName = normalizedSlug.slice(sourcePrefix.length).trim();
    return skillName.length > 0 ? skillName : null;
  }

  private async deleteSyncedSkillDirectory(sourceName: string, skillName: string): Promise<void> {
    const sourcePath = join(
      homedir(),
      '.devchain',
      'skills',
      sourceName.trim().toLowerCase(),
      skillName,
    );

    try {
      await fs.rm(sourcePath, { recursive: true, force: true });
    } catch (error) {
      logger.warn(
        {
          sourceName,
          skillName,
          sourcePath,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to cleanup stale synced skill files',
      );
      throw error;
    }
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
      removed: 0,
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
      removed: left.removed + right.removed,
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
