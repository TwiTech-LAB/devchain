import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { NotFoundError, StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { CommunitySkillSource, LocalSkillSource } from '../../storage/models/domain.models';
import type { CreateCommunitySourceDto } from '../dtos/community-sources.dto';
import type { CreateLocalSourceDto } from '../dtos/local-sources.dto';
import { SkillSourceRegistryService } from './skill-source-registry.service';
import { SkillSyncService } from './skill-sync.service';
import type { SyncResult } from './skill-sync.types';

const logger = createLogger('SkillSourceLifecycleService');

type ManagedSourceKind = 'community' | 'local';

type DeferredSyncJob = {
  kind: 'deferred_sync';
  sourceKind: ManagedSourceKind;
  sourceName: string;
};

type DeleteJob = {
  kind: 'delete';
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type SchedulerJob = DeferredSyncJob | DeleteJob;

@Injectable()
export class SkillSourceLifecycleService implements OnApplicationBootstrap {
  private schedulerActive = false;
  private readonly pendingJobs: SchedulerJob[] = [];
  private readonly pendingDeferredSources = new Set<string>();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly skillSourceRegistry: SkillSourceRegistryService,
    private readonly skillSyncService: SkillSyncService,
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

  listCommunitySources(): Promise<CommunitySkillSource[]> {
    return this.storage.listCommunitySkillSources();
  }

  async createCommunitySource(data: CreateCommunitySourceDto): Promise<CommunitySkillSource> {
    this.assertManagedSourceNameAvailable(data.name);
    const source = await this.storage.createCommunitySkillSource(
      {
        name: data.name,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        branch: data.branch,
      },
      { existingProjects: data.existingProjects ?? { mode: 'none' } },
    );

    await this.admitInitialSync(source.name, 'community');
    return source;
  }

  deleteCommunitySource(id: string): Promise<void> {
    return this.enqueueDelete(async () => {
      const source = await this.storage.getCommunitySkillSource(id);
      await this.deleteSourceSkillsDirectory(source.name, 'community');
      await this.storage.deleteCommunitySkillSource(id);
    });
  }

  listLocalSources(): Promise<LocalSkillSource[]> {
    return this.storage.listLocalSkillSources();
  }

  async createLocalSource(data: CreateLocalSourceDto): Promise<LocalSkillSource> {
    this.assertManagedSourceNameAvailable(data.name);
    const normalizedFolderPath = await this.validateAndNormalizeFolderPath(data.folderPath);
    const source = await this.storage.createLocalSkillSource(
      {
        name: data.name,
        folderPath: normalizedFolderPath,
      },
      { existingProjects: data.existingProjects ?? { mode: 'none' } },
    );

    await this.admitInitialSync(source.name, 'local');
    return source;
  }

  deleteLocalSource(id: string): Promise<void> {
    return this.enqueueDelete(async () => {
      const source = await this.storage.getLocalSkillSource(id);
      if (!source) {
        throw new NotFoundError('Local skill source', id);
      }
      await this.deleteSourceSkillsDirectory(source.name, 'local');
      await this.storage.deleteLocalSkillSource(id);
    });
  }

  syncAll(): Promise<SyncResult> {
    if (!this.reservePublicSync()) {
      return Promise.resolve(this.createAlreadyRunningResult());
    }
    return this.executeReservedOperation(() => this.skillSyncService.syncAll());
  }

  syncSource(sourceName: string): Promise<SyncResult> {
    if (!this.reservePublicSync()) {
      return Promise.resolve(this.createAlreadyRunningResult());
    }
    return this.executeReservedOperation(() => this.skillSyncService.syncSource(sourceName));
  }

  private reservePublicSync(): boolean {
    if (this.schedulerActive || this.pendingJobs.length > 0) {
      logger.info('Skill sync skipped because another sync is already running');
      return false;
    }
    this.schedulerActive = true;
    return true;
  }

  private async admitInitialSync(sourceName: string, sourceKind: ManagedSourceKind): Promise<void> {
    const normalizedSourceName = sourceName.trim().toLowerCase();
    if (this.schedulerActive || this.pendingJobs.length > 0) {
      this.enqueueDeferredSync(normalizedSourceName, sourceKind);
      return;
    }

    this.schedulerActive = true;
    await this.executeReservedOperation(() =>
      this.syncSourceAfterCreate(normalizedSourceName, sourceKind),
    );
  }

  private enqueueDeferredSync(sourceName: string, sourceKind: ManagedSourceKind): void {
    if (this.pendingDeferredSources.has(sourceName)) {
      return;
    }

    this.pendingDeferredSources.add(sourceName);
    this.pendingJobs.push({ kind: 'deferred_sync', sourceKind, sourceName });
    this.startQueueIfIdle();
  }

  private enqueueDelete(run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingJobs.push({ kind: 'delete', run, resolve, reject });
      this.startQueueIfIdle();
    });
  }

  private startQueueIfIdle(): void {
    if (this.schedulerActive) {
      return;
    }
    this.schedulerActive = true;
    this.advanceQueue();
  }

  private async executeReservedOperation<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } finally {
      this.advanceQueue();
    }
  }

  private advanceQueue(): void {
    const job = this.pendingJobs.shift();
    if (!job) {
      this.schedulerActive = false;
      return;
    }

    if (job.kind === 'deferred_sync') {
      this.pendingDeferredSources.delete(job.sourceName);
    }
    void this.executeQueuedJob(job);
  }

  private async executeQueuedJob(job: SchedulerJob): Promise<void> {
    try {
      if (job.kind === 'deferred_sync') {
        await this.syncSourceAfterCreate(job.sourceName, job.sourceKind);
      } else {
        await job.run();
        job.resolve();
      }
    } catch (error) {
      if (job.kind === 'delete') {
        job.reject(error);
      }
    } finally {
      this.advanceQueue();
    }
  }

  private async syncSourceAfterCreate(
    sourceName: string,
    sourceKind: ManagedSourceKind,
  ): Promise<void> {
    try {
      const syncResult = await this.skillSyncService.syncSource(sourceName);
      if (syncResult.failed > 0) {
        logger.warn(
          {
            sourceName,
            failed: syncResult.failed,
            errors: syncResult.errors,
          },
          `Initial ${sourceKind} source sync completed with errors`,
        );
      }
    } catch (error) {
      logger.warn(
        {
          sourceName,
          error: error instanceof Error ? error.message : String(error),
        },
        `Initial ${sourceKind} source sync failed after source creation`,
      );
    }
  }

  private assertManagedSourceNameAvailable(name: string): void {
    const normalizedName = name.trim().toLowerCase();
    const reservedNames = new Set(this.skillSourceRegistry.getBuiltInSourceNames());
    if (reservedNames.has(normalizedName)) {
      throw new ValidationError('Source name is reserved by a built-in skill source.', {
        name: normalizedName,
      });
    }
  }

  private async validateAndNormalizeFolderPath(folderPath: string): Promise<string> {
    const trimmedPath = folderPath.trim();
    if (!trimmedPath) {
      throw new ValidationError('folderPath is required.', { fieldName: 'folderPath' });
    }
    if (!isAbsolute(trimmedPath)) {
      throw new ValidationError('folderPath must be an absolute path.', {
        fieldName: 'folderPath',
        folderPath: trimmedPath,
      });
    }

    const normalizedPath = resolve(trimmedPath);
    await this.ensureReadableDirectory(normalizedPath, 'folderPath');
    await this.ensureReadableDirectory(join(normalizedPath, 'skills'), 'skillsPath');
    return normalizedPath;
  }

  private async ensureReadableDirectory(pathValue: string, fieldName: string): Promise<void> {
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(pathValue);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ValidationError(`${fieldName} does not exist.`, {
          fieldName,
          path: pathValue,
        });
      }
      throw new StorageError(`Failed to validate ${fieldName}.`, {
        fieldName,
        path: pathValue,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (!stats.isDirectory()) {
      throw new ValidationError(`${fieldName} must be a directory.`, {
        fieldName,
        path: pathValue,
      });
    }

    try {
      await fs.access(pathValue, constants.R_OK);
    } catch (error) {
      throw new ValidationError(`${fieldName} is not readable.`, {
        fieldName,
        path: pathValue,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async deleteSourceSkillsDirectory(
    sourceName: string,
    sourceKind: ManagedSourceKind,
  ): Promise<void> {
    const normalizedSourceName = sourceName.trim().toLowerCase();
    const sourcePath = join(homedir(), '.devchain', 'skills', normalizedSourceName);

    try {
      await fs.rm(sourcePath, { recursive: true, force: true });
    } catch (error) {
      const message =
        sourceKind === 'community'
          ? 'Failed to delete community source local skills directory.'
          : 'Failed to delete local source synced skills directory.';
      throw new StorageError(message, {
        sourceName: normalizedSourceName,
        sourcePath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info(
      { sourceName: normalizedSourceName, sourcePath },
      sourceKind === 'community'
        ? 'Deleted local skills directory for community source'
        : 'Deleted synced skills directory for local source',
    );
  }

  private createAlreadyRunningResult(): SyncResult {
    return {
      status: 'already_running',
      added: 0,
      updated: 0,
      removed: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    };
  }
}
