import { Inject, Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { NotFoundError, StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { LocalSkillSource } from '../../storage/models/domain.models';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { CreateLocalSourceDto } from '../dtos/local-sources.dto';
import { SkillSyncService } from './skill-sync.service';
import { SkillsService } from './skills.service';

const logger = createLogger('LocalSourcesService');

@Injectable()
export class LocalSourcesService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly skillsService: SkillsService,
    private readonly skillSyncService: SkillSyncService,
  ) {}

  async listLocalSources(): Promise<LocalSkillSource[]> {
    return this.storage.listLocalSkillSources();
  }

  async createLocalSource(data: CreateLocalSourceDto): Promise<LocalSkillSource> {
    this.validateSourceName(data.name);
    const normalizedFolderPath = await this.validateAndNormalizeFolderPath(data.folderPath);

    const source = await this.storage.createLocalSkillSource({
      name: data.name,
      folderPath: normalizedFolderPath,
    });

    const projectIds = await this.listAllProjectIds();
    for (const projectId of projectIds) {
      await this.storage.seedSourceProjectDisabled(projectId, [source.name]);
    }

    await this.syncSourceAfterCreate(source.name);

    return source;
  }

  async deleteLocalSource(id: string): Promise<void> {
    const source = await this.storage.getLocalSkillSource(id);
    if (!source) {
      throw new NotFoundError('Local skill source', id);
    }

    await this.storage.deleteLocalSkillSource(id);
    await this.deleteSourceSkillsDirectory(source.name);
  }

  private validateSourceName(name: string): void {
    const normalizedName = name.trim().toLowerCase();
    const reservedNames = new Set(this.skillsService.getReservedSourceNames());

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

  private async deleteSourceSkillsDirectory(sourceName: string): Promise<void> {
    const normalizedSourceName = sourceName.trim().toLowerCase();
    const sourcePath = join(homedir(), '.devchain', 'skills', normalizedSourceName);

    try {
      await fs.rm(sourcePath, { recursive: true, force: true });
    } catch (error) {
      throw new StorageError('Failed to delete local source synced skills directory.', {
        sourceName: normalizedSourceName,
        sourcePath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info(
      { sourceName: normalizedSourceName, sourcePath },
      'Deleted synced skills directory for local source',
    );
  }

  private async listAllProjectIds(): Promise<string[]> {
    const projectIds: string[] = [];
    const limit = 200;
    let offset = 0;

    while (true) {
      const page = await this.storage.listProjects({ limit, offset });
      projectIds.push(...page.items.map((project) => project.id));
      offset += page.items.length;

      if (page.items.length === 0 || offset >= page.total) {
        break;
      }
    }

    return projectIds;
  }

  private async syncSourceAfterCreate(sourceName: string): Promise<void> {
    try {
      const syncResult = await this.skillSyncService.syncSource(sourceName);
      if (syncResult.failed > 0) {
        logger.warn(
          {
            sourceName,
            failed: syncResult.failed,
            errors: syncResult.errors,
          },
          'Initial local source sync completed with errors',
        );
      }
    } catch (error) {
      logger.warn(
        {
          sourceName,
          error: error instanceof Error ? error.message : String(error),
        },
        'Initial local source sync failed after source creation',
      );
    }
  }
}
