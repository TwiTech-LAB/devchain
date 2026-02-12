import { Inject, Injectable } from '@nestjs/common';
import { CommunitySkillSourceAdapter } from '../adapters/community-skill-source.adapter';
import { SKILL_SOURCE_ADAPTERS, type SkillSourceAdapter } from '../adapters/skill-source.adapter';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';

@Injectable()
export class SkillSourceRegistryService {
  constructor(
    @Inject(SKILL_SOURCE_ADAPTERS) private readonly builtInAdapters: SkillSourceAdapter[],
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async getAdapters(): Promise<SkillSourceAdapter[]> {
    const communitySources = await this.storage.listCommunitySkillSources();
    const communityAdapters = communitySources.map(
      (source) => new CommunitySkillSourceAdapter(source),
    );
    return [...this.builtInAdapters, ...communityAdapters];
  }

  async getAdapterBySourceName(name: string): Promise<SkillSourceAdapter | null> {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName) {
      return null;
    }

    const adapters = await this.getAdapters();
    return (
      adapters.find((adapter) => adapter.sourceName.trim().toLowerCase() === normalizedName) ?? null
    );
  }
}
