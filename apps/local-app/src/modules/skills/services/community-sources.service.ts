import { Inject, Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { CommunitySkillSource } from '../../storage/models/domain.models';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { CreateCommunitySourceDto } from '../dtos/community-sources.dto';
import { SkillSyncService } from './skill-sync.service';
import { SkillsService } from './skills.service';

const logger = createLogger('CommunitySourcesService');

@Injectable()
export class CommunitySourcesService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly skillsService: SkillsService,
    private readonly skillSyncService: SkillSyncService,
  ) {}

  async listCommunitySources(): Promise<CommunitySkillSource[]> {
    return this.storage.listCommunitySkillSources();
  }

  async createCommunitySource(data: CreateCommunitySourceDto): Promise<CommunitySkillSource> {
    await this.validateSourceName(data.name);
    const source = await this.storage.createCommunitySkillSource({
      name: data.name,
      repoOwner: data.repoOwner,
      repoName: data.repoName,
      branch: data.branch,
    });

    const projectIds = await this.listAllProjectIds();
    for (const projectId of projectIds) {
      await this.storage.seedSourceProjectDisabled(projectId, [source.name]);
    }

    await this.syncSourceAfterCreate(source.name);

    return source;
  }

  async deleteCommunitySource(id: string): Promise<void> {
    const source = await this.storage.getCommunitySkillSource(id);
    await this.storage.deleteCommunitySkillSource(id);
    await this.deleteSourceSkillsDirectory(source.name);
  }

  private async deleteSourceSkillsDirectory(sourceName: string): Promise<void> {
    const normalizedSourceName = sourceName.trim().toLowerCase();
    const sourcePath = join(homedir(), '.devchain', 'skills', normalizedSourceName);

    try {
      await fs.rm(sourcePath, { recursive: true, force: true });
    } catch (error) {
      throw new StorageError('Failed to delete community source local skills directory.', {
        sourceName: normalizedSourceName,
        sourcePath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info(
      { sourceName: normalizedSourceName, sourcePath },
      'Deleted local skills directory for community source',
    );
  }

  private async validateSourceName(name: string): Promise<void> {
    const normalizedName = name.trim().toLowerCase();
    const reservedNames = new Set(this.skillsService.getReservedSourceNames());

    if (reservedNames.has(normalizedName)) {
      throw new ValidationError('Source name is reserved by a built-in skill source.', {
        name: normalizedName,
      });
    }

    const localSourceNames = new Set(
      (await this.storage.listLocalSkillSources()).map((source) =>
        source.name.trim().toLowerCase(),
      ),
    );
    if (localSourceNames.has(normalizedName)) {
      throw new ValidationError('Source name is already used by a local skill source.', {
        name: normalizedName,
      });
    }
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
          'Initial community source sync completed with errors',
        );
      }
    } catch (error) {
      logger.warn(
        {
          sourceName,
          error: error instanceof Error ? error.message : String(error),
        },
        'Initial community source sync failed after source creation',
      );
    }
  }
}
