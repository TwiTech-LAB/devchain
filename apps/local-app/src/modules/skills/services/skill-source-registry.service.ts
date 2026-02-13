import { Inject, Injectable } from '@nestjs/common';
import { CommunitySkillSourceAdapter } from '../adapters/community-skill-source.adapter';
import { LocalSkillSourceAdapter } from '../adapters/local-skill-source.adapter';
import { SKILL_SOURCE_ADAPTERS, type SkillSourceAdapter } from '../adapters/skill-source.adapter';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { createLogger } from '../../../common/logging/logger';

export type SkillSourceKind = 'builtin' | 'community' | 'local';

export interface RegisteredSkillSource {
  name: string;
  repoUrl: string;
  kind: SkillSourceKind;
}

const logger = createLogger('SkillSourceRegistryService');

@Injectable()
export class SkillSourceRegistryService {
  constructor(
    @Inject(SKILL_SOURCE_ADAPTERS) private readonly builtInAdapters: SkillSourceAdapter[],
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  getBuiltInSourceNames(): string[] {
    return this.dedupeAndSort(
      this.builtInAdapters.map((adapter) => adapter.sourceName.trim().toLowerCase()),
    );
  }

  async getAdapters(): Promise<SkillSourceAdapter[]> {
    const [communityAdapters, localAdapters] = await Promise.all([
      this.getCommunityAdapters(),
      this.getLocalAdapters(),
    ]);

    const uniqueAdapters: SkillSourceAdapter[] = [];
    const seenSourceNames = new Map<string, SkillSourceKind>();
    const adapterGroups: Array<{ kind: SkillSourceKind; adapters: SkillSourceAdapter[] }> = [
      { kind: 'builtin', adapters: this.builtInAdapters },
      { kind: 'community', adapters: communityAdapters },
      { kind: 'local', adapters: localAdapters },
    ];

    for (const group of adapterGroups) {
      for (const adapter of group.adapters) {
        const normalizedName = adapter.sourceName.trim().toLowerCase();
        if (!normalizedName) {
          continue;
        }

        const existingKind = seenSourceNames.get(normalizedName);
        if (existingKind) {
          logger.warn(
            {
              sourceName: normalizedName,
              kind: group.kind,
              existingKind,
            },
            'Duplicate source name detected in registry adapters; skipping',
          );
          continue;
        }

        seenSourceNames.set(normalizedName, group.kind);
        uniqueAdapters.push(adapter);
      }
    }

    return uniqueAdapters;
  }

  async listRegisteredSources(): Promise<RegisteredSkillSource[]> {
    const sourceMap = new Map<string, RegisteredSkillSource>();

    for (const adapter of this.builtInAdapters) {
      const normalizedName = adapter.sourceName.trim().toLowerCase();
      if (!normalizedName) {
        continue;
      }
      if (sourceMap.has(normalizedName)) {
        logger.warn(
          { sourceName: normalizedName, kind: 'builtin' as SkillSourceKind },
          'Duplicate source name detected in registry; skipping',
        );
        continue;
      }
      sourceMap.set(normalizedName, {
        name: normalizedName,
        repoUrl: adapter.repoUrl,
        kind: 'builtin',
      });
    }

    const communityAdapters = await this.getCommunityAdapters();
    for (const adapter of communityAdapters) {
      const normalizedName = adapter.sourceName.trim().toLowerCase();
      if (!normalizedName) {
        continue;
      }
      if (sourceMap.has(normalizedName)) {
        logger.warn(
          { sourceName: normalizedName, kind: 'community' as SkillSourceKind },
          'Duplicate source name detected in registry; skipping',
        );
        continue;
      }
      sourceMap.set(normalizedName, {
        name: normalizedName,
        repoUrl: adapter.repoUrl,
        kind: 'community',
      });
    }

    const localAdapters = await this.getLocalAdapters();
    for (const adapter of localAdapters) {
      const normalizedName = adapter.sourceName.trim().toLowerCase();
      if (!normalizedName) {
        continue;
      }
      if (sourceMap.has(normalizedName)) {
        logger.warn(
          { sourceName: normalizedName, kind: 'local' as SkillSourceKind },
          'Duplicate source name detected in registry; skipping',
        );
        continue;
      }
      sourceMap.set(normalizedName, {
        name: normalizedName,
        repoUrl: adapter.repoUrl,
        kind: 'local',
      });
    }

    return [...sourceMap.values()].sort((left, right) => left.name.localeCompare(right.name));
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

  private async getCommunityAdapters(): Promise<CommunitySkillSourceAdapter[]> {
    const communitySources = await this.storage.listCommunitySkillSources();
    return communitySources.map((source) => new CommunitySkillSourceAdapter(source));
  }

  private async getLocalAdapters(): Promise<LocalSkillSourceAdapter[]> {
    const localSources = await this.storage.listLocalSkillSources();
    return localSources.map((source) => new LocalSkillSourceAdapter(source));
  }

  private dedupeAndSort(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.length > 0))].sort((left, right) =>
      left.localeCompare(right),
    );
  }
}
