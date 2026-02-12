import type { CommunitySkillSource } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SkillSourceAdapter } from '../adapters/skill-source.adapter';
import { SkillSourceRegistryService } from './skill-source-registry.service';

const makeCommunitySource = (overrides: Partial<CommunitySkillSource>): CommunitySkillSource => ({
  id: 'community-id',
  name: 'community',
  repoOwner: 'example',
  repoName: 'skills-repo',
  branch: 'main',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const makeBuiltInAdapter = (sourceName: string, repoUrl: string): SkillSourceAdapter => ({
  sourceName,
  repoUrl,
  createSyncContext: jest.fn(),
  listSkills: jest.fn(),
  downloadSkill: jest.fn(),
  getLatestCommit: jest.fn(),
});

describe('SkillSourceRegistryService', () => {
  let storage: { listCommunitySkillSources: jest.Mock };

  beforeEach(() => {
    storage = {
      listCommunitySkillSources: jest.fn().mockResolvedValue([]),
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns built-in adapters followed by community adapters', async () => {
    const builtIn = [makeBuiltInAdapter('anthropic', 'https://github.com/anthropics/skills')];
    storage.listCommunitySkillSources.mockResolvedValue([
      makeCommunitySource({
        name: 'community',
        repoOwner: 'Jeffallan',
        repoName: 'claude-skills',
        branch: 'main',
      }),
    ]);

    const service = new SkillSourceRegistryService(builtIn, storage as unknown as StorageService);
    const adapters = await service.getAdapters();

    expect(adapters).toHaveLength(2);
    expect(adapters[0]).toBe(builtIn[0]);
    expect(adapters[1]?.sourceName).toBe('community');
    expect(adapters[1]?.repoUrl).toBe('https://github.com/Jeffallan/claude-skills');
  });

  it('finds adapter by source name case-insensitively', async () => {
    const builtIn = [makeBuiltInAdapter('anthropic', 'https://github.com/anthropics/skills')];
    storage.listCommunitySkillSources.mockResolvedValue([
      makeCommunitySource({
        name: 'CommunitySource',
        repoOwner: 'foo',
        repoName: 'bar',
        branch: 'main',
      }),
    ]);

    const service = new SkillSourceRegistryService(builtIn, storage as unknown as StorageService);

    const builtInMatch = await service.getAdapterBySourceName('ANTHROPIC');
    const communityMatch = await service.getAdapterBySourceName('communitysource');

    expect(builtInMatch?.sourceName).toBe('anthropic');
    expect(communityMatch?.sourceName).toBe('CommunitySource');
  });

  it('returns null for unknown or blank source names', async () => {
    const service = new SkillSourceRegistryService([], storage as unknown as StorageService);

    await expect(service.getAdapterBySourceName('missing')).resolves.toBeNull();
    await expect(service.getAdapterBySourceName('   ')).resolves.toBeNull();
  });
});
