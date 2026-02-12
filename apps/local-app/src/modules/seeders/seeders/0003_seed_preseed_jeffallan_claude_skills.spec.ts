import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { CommunitySkillSource } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { WatchersService } from '../../watchers/services/watchers.service';
import type { SeederContext } from '../services/data-seeder.service';
import {
  runSeedPreseedJeffallanClaudeSkills,
  seedPreseedJeffallanClaudeSkillsSeeder,
} from './0003_seed_preseed_jeffallan_claude_skills';

function createCommunitySource(overrides?: Partial<CommunitySkillSource>): CommunitySkillSource {
  return {
    id: overrides?.id ?? 'source-1',
    name: overrides?.name ?? 'jeffallan',
    repoOwner: overrides?.repoOwner ?? 'jeffallan',
    repoName: overrides?.repoName ?? 'claude-skills',
    branch: overrides?.branch ?? 'main',
    createdAt: overrides?.createdAt ?? '2024-01-01T00:00:00.000Z',
    updatedAt: overrides?.updatedAt ?? '2024-01-01T00:00:00.000Z',
  };
}

describe('0003_seed_preseed_jeffallan_claude_skills', () => {
  function createContext(overrides?: {
    getCommunitySkillSourceByName?: jest.Mock;
    createCommunitySkillSource?: jest.Mock;
    info?: jest.Mock;
  }): SeederContext {
    const storage = {
      getCommunitySkillSourceByName:
        overrides?.getCommunitySkillSourceByName ?? jest.fn().mockResolvedValue(null),
      createCommunitySkillSource:
        overrides?.createCommunitySkillSource ??
        jest.fn().mockResolvedValue(createCommunitySource()),
    } as unknown as StorageService;

    return {
      storage,
      watchersService: {} as WatchersService,
      db: {} as BetterSQLite3Database,
      logger: {
        info: overrides?.info ?? jest.fn(),
      } as unknown as SeederContext['logger'],
    };
  }

  it('creates default jeffallan community source when missing', async () => {
    const getByName = jest.fn().mockResolvedValue(null);
    const createSource = jest
      .fn()
      .mockResolvedValue(createCommunitySource({ id: 'source-created' }));
    const info = jest.fn();
    const ctx = createContext({
      getCommunitySkillSourceByName: getByName,
      createCommunitySkillSource: createSource,
      info,
    });

    await runSeedPreseedJeffallanClaudeSkills(ctx);

    expect(getByName).toHaveBeenCalledWith('jeffallan');
    expect(createSource).toHaveBeenCalledWith({
      name: 'jeffallan',
      repoOwner: 'Jeffallan',
      repoName: 'claude-skills',
      branch: 'main',
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        seederName: '0003_seed_preseed_jeffallan_claude_skills',
        seederVersion: 1,
        created: 1,
        skipped: 0,
        sourceId: 'source-created',
        sourceName: 'jeffallan',
      }),
      'Pre-seed jeffallan community source seeder completed',
    );
  });

  it('skips creation when default community source already exists', async () => {
    const existing = createCommunitySource({ id: 'source-existing' });
    const getByName = jest.fn().mockResolvedValue(existing);
    const createSource = jest.fn();
    const info = jest.fn();
    const ctx = createContext({
      getCommunitySkillSourceByName: getByName,
      createCommunitySkillSource: createSource,
      info,
    });

    await runSeedPreseedJeffallanClaudeSkills(ctx);

    expect(getByName).toHaveBeenCalledWith('jeffallan');
    expect(createSource).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        seederName: '0003_seed_preseed_jeffallan_claude_skills',
        seederVersion: 1,
        created: 0,
        skipped: 1,
        existingSourceId: 'source-existing',
        sourceName: 'jeffallan',
      }),
      'Pre-seed jeffallan community source seeder completed',
    );
  });

  it('is idempotent across repeated runs', async () => {
    let existing: CommunitySkillSource | null = null;

    const getByName = jest.fn().mockImplementation(async () => existing);
    const createSource = jest.fn().mockImplementation(async () => {
      existing = createCommunitySource({ id: 'source-after-create' });
      return existing;
    });

    const ctx = createContext({
      getCommunitySkillSourceByName: getByName,
      createCommunitySkillSource: createSource,
      info: jest.fn(),
    });

    await runSeedPreseedJeffallanClaudeSkills(ctx);
    await runSeedPreseedJeffallanClaudeSkills(ctx);

    expect(createSource).toHaveBeenCalledTimes(1);
    expect(getByName).toHaveBeenCalledTimes(2);
  });

  it('exports seeder metadata and run function', () => {
    expect(seedPreseedJeffallanClaudeSkillsSeeder).toMatchObject({
      name: '0003_seed_preseed_jeffallan_claude_skills',
      version: 1,
      run: runSeedPreseedJeffallanClaudeSkills,
    });
  });
});
