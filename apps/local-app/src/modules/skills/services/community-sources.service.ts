import { Inject, Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { StorageError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import type { CommunitySkillSource } from '../../storage/models/domain.models';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { CreateCommunitySourceDto } from '../dtos/community-sources.dto';

const logger = createLogger('CommunitySourcesService');

@Injectable()
export class CommunitySourcesService {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  async listCommunitySources(): Promise<CommunitySkillSource[]> {
    return this.storage.listCommunitySkillSources();
  }

  async createCommunitySource(data: CreateCommunitySourceDto): Promise<CommunitySkillSource> {
    return this.storage.createCommunitySkillSource({
      name: data.name,
      repoOwner: data.repoOwner,
      repoName: data.repoName,
      branch: data.branch,
    });
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
}
