import type { CommunitySkillSource, LocalSkillSource } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { SkillSourceAdapter } from '../adapters/skill-source.adapter';
import { SkillSourceRegistryService } from './skill-source-registry.service';

jest.mock('../../../common/logging/logger', () => ({
  __mockLoggerWarn: jest.fn(),
  createLogger: jest.fn(() => ({
    warn: jest.requireMock('../../../common/logging/logger').__mockLoggerWarn,
  })),
}));

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

const makeLocalSource = (overrides: Partial<LocalSkillSource>): LocalSkillSource => ({
  id: 'local-id',
  name: 'local',
  folderPath: '/tmp/local-skills',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('SkillSourceRegistryService', () => {
  let storage: { listCommunitySkillSources: jest.Mock; listLocalSkillSources: jest.Mock };
  let mockLoggerWarn: jest.Mock;

  beforeEach(() => {
    mockLoggerWarn = jest.requireMock('../../../common/logging/logger').__mockLoggerWarn;
    mockLoggerWarn.mockReset();
    storage = {
      listCommunitySkillSources: jest.fn().mockResolvedValue([]),
      listLocalSkillSources: jest.fn().mockResolvedValue([]),
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns built-in adapters followed by community and local adapters', async () => {
    const builtIn = [makeBuiltInAdapter('anthropic', 'https://github.com/anthropics/skills')];
    storage.listCommunitySkillSources.mockResolvedValue([
      makeCommunitySource({
        name: 'community',
        repoOwner: 'Jeffallan',
        repoName: 'claude-skills',
        branch: 'main',
      }),
    ]);
    storage.listLocalSkillSources.mockResolvedValue([
      makeLocalSource({
        name: 'local-source',
        folderPath: '/tmp/local-source',
      }),
    ]);

    const service = new SkillSourceRegistryService(builtIn, storage as unknown as StorageService);
    const adapters = await service.getAdapters();

    expect(adapters).toHaveLength(3);
    expect(adapters[0]).toBe(builtIn[0]);
    expect(adapters[1]?.sourceName).toBe('community');
    expect(adapters[1]?.repoUrl).toBe('https://github.com/Jeffallan/claude-skills');
    expect(adapters[2]?.sourceName).toBe('local-source');
    expect(adapters[2]?.repoUrl).toBe('file:///tmp/local-source');
  });

  it('lists registered sources with kind metadata', async () => {
    const builtIn = [makeBuiltInAdapter('openai', 'https://github.com/openai/skills')];
    storage.listCommunitySkillSources.mockResolvedValue([
      makeCommunitySource({
        name: 'community',
        repoOwner: 'foo',
        repoName: 'bar',
        branch: 'main',
      }),
    ]);
    storage.listLocalSkillSources.mockResolvedValue([
      makeLocalSource({
        name: 'local-source',
        folderPath: '/tmp/local-source',
      }),
    ]);

    const service = new SkillSourceRegistryService(builtIn, storage as unknown as StorageService);
    const sources = await service.listRegisteredSources();

    expect(sources).toEqual([
      {
        name: 'community',
        repoUrl: 'https://github.com/foo/bar',
        kind: 'community',
      },
      {
        name: 'local-source',
        repoUrl: 'file:///tmp/local-source',
        kind: 'local',
      },
      {
        name: 'openai',
        repoUrl: 'https://github.com/openai/skills',
        kind: 'builtin',
      },
    ]);
  });

  it('returns normalized built-in source names', () => {
    const builtIn = [
      makeBuiltInAdapter(' OpenAI ', 'https://github.com/openai/skills'),
      makeBuiltInAdapter('anthropic', 'https://github.com/anthropics/skills'),
      makeBuiltInAdapter('openai', 'https://github.com/openai/skills'),
    ];
    const service = new SkillSourceRegistryService(builtIn, storage as unknown as StorageService);

    expect(service.getBuiltInSourceNames()).toEqual(['anthropic', 'openai']);
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
    storage.listLocalSkillSources.mockResolvedValue([
      makeLocalSource({
        name: 'localsource',
        folderPath: '/tmp/localsource',
      }),
    ]);

    const service = new SkillSourceRegistryService(builtIn, storage as unknown as StorageService);

    const builtInMatch = await service.getAdapterBySourceName('ANTHROPIC');
    const communityMatch = await service.getAdapterBySourceName('communitysource');
    const localMatch = await service.getAdapterBySourceName('localsource');

    expect(builtInMatch?.sourceName).toBe('anthropic');
    expect(communityMatch?.sourceName).toBe('CommunitySource');
    expect(localMatch?.sourceName).toBe('localsource');
  });

  it('returns null for unknown or blank source names', async () => {
    const service = new SkillSourceRegistryService([], storage as unknown as StorageService);

    await expect(service.getAdapterBySourceName('missing')).resolves.toBeNull();
    await expect(service.getAdapterBySourceName('   ')).resolves.toBeNull();
  });

  it('dedupes duplicate adapters in getAdapters and logs warning', async () => {
    const builtIn = [makeBuiltInAdapter('openai', 'https://github.com/openai/skills')];
    storage.listCommunitySkillSources.mockResolvedValue([
      makeCommunitySource({
        name: 'openai',
        repoOwner: 'foo',
        repoName: 'bar',
      }),
    ]);
    storage.listLocalSkillSources.mockResolvedValue([
      makeLocalSource({
        name: 'openai',
        folderPath: '/tmp/openai',
      }),
    ]);

    const service = new SkillSourceRegistryService(builtIn, storage as unknown as StorageService);
    const adapters = await service.getAdapters();

    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toBe(builtIn[0]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceName: 'openai', kind: 'community', existingKind: 'builtin' }),
      'Duplicate source name detected in registry adapters; skipping',
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceName: 'openai', kind: 'local', existingKind: 'builtin' }),
      'Duplicate source name detected in registry adapters; skipping',
    );
  });

  it('logs warning when duplicate source names are skipped in listRegisteredSources', async () => {
    const builtIn = [makeBuiltInAdapter('openai', 'https://github.com/openai/skills')];
    storage.listCommunitySkillSources.mockResolvedValue([
      makeCommunitySource({
        name: 'openai',
        repoOwner: 'foo',
        repoName: 'bar',
      }),
    ]);
    storage.listLocalSkillSources.mockResolvedValue([
      makeLocalSource({
        name: 'openai',
        folderPath: '/tmp/openai',
      }),
    ]);

    const service = new SkillSourceRegistryService(builtIn, storage as unknown as StorageService);
    const sources = await service.listRegisteredSources();

    expect(sources).toEqual([
      {
        name: 'openai',
        repoUrl: 'https://github.com/openai/skills',
        kind: 'builtin',
      },
    ]);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceName: 'openai', kind: 'community' }),
      'Duplicate source name detected in registry; skipping',
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceName: 'openai', kind: 'local' }),
      'Duplicate source name detected in registry; skipping',
    );
  });
});
