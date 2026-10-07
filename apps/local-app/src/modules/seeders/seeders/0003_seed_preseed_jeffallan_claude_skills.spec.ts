import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ConflictError } from '../../../common/errors/error-types';
import type { CommunitySkillSource, LocalSkillSource } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { WatchersService } from '../../watchers/services/watchers.service';
import type { SeederContext } from '../types/seeder.types';
import { runSeedPreseedJeffallanClaudeSkills } from './0003_seed_preseed_jeffallan_claude_skills';

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

function createLocalSource(overrides?: Partial<LocalSkillSource>): LocalSkillSource {
  return {
    id: overrides?.id ?? 'local-source-1',
    name: overrides?.name ?? 'jeffallan',
    folderPath: overrides?.folderPath ?? '/tmp/jeffallan',
    createdAt: overrides?.createdAt ?? '2024-01-01T00:00:00.000Z',
    updatedAt: overrides?.updatedAt ?? '2024-01-01T00:00:00.000Z',
  };
}

describe('0003_seed_preseed_jeffallan_claude_skills', () => {
  function createContext(overrides?: {
    getCommunitySkillSourceByName?: jest.Mock;
    getLocalSkillSourceByName?: jest.Mock;
    createCommunitySkillSource?: jest.Mock;
    info?: jest.Mock;
  }): SeederContext {
    const storage = {
      getCommunitySkillSourceByName:
        overrides?.getCommunitySkillSourceByName ?? jest.fn().mockResolvedValue(null),
      getLocalSkillSourceByName:
        overrides?.getLocalSkillSourceByName ?? jest.fn().mockResolvedValue(null),
      createCommunitySkillSource:
        overrides?.createCommunitySkillSource ??
        jest.fn().mockResolvedValue(createCommunitySource()),
    } as unknown as StorageService;

    return {
      storage,
      providerEffortSeeding: {} as SeederContext['providerEffortSeeding'],
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
    expect(createSource).toHaveBeenCalledTimes(1);
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
        collidingKind: 'community',
      }),
      'Pre-seed jeffallan community source seeder completed',
    );
  });

  it('skips creation when a local source owns the normalized name', async () => {
    const local = createLocalSource({ id: 'local-existing' });
    const getLocalByName = jest.fn().mockResolvedValue(local);
    const createSource = jest.fn();
    const info = jest.fn();
    const ctx = createContext({
      getLocalSkillSourceByName: getLocalByName,
      createCommunitySkillSource: createSource,
      info,
    });

    await runSeedPreseedJeffallanClaudeSkills(ctx);

    expect(getLocalByName).toHaveBeenCalledWith('jeffallan');
    expect(createSource).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        existingSourceId: 'local-existing',
        sourceName: 'jeffallan',
        collidingKind: 'local',
        skipped: 1,
      }),
      'Pre-seed jeffallan community source seeder completed',
    );
  });

  it('rereads both kinds and skips a transactional name race', async () => {
    const racedLocal = createLocalSource({ id: 'local-race' });
    const getCommunityByName = jest.fn().mockResolvedValue(null);
    const getLocalByName = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(racedLocal);
    const createSource = jest
      .fn()
      .mockRejectedValue(new ConflictError('cross-kind collision', { name: 'jeffallan' }));
    const ctx = createContext({
      getCommunitySkillSourceByName: getCommunityByName,
      getLocalSkillSourceByName: getLocalByName,
      createCommunitySkillSource: createSource,
      info: jest.fn(),
    });

    await expect(runSeedPreseedJeffallanClaudeSkills(ctx)).resolves.toBeUndefined();
    expect(getCommunityByName).toHaveBeenCalledTimes(2);
    expect(getLocalByName).toHaveBeenCalledTimes(2);
  });

  it('rethrows unrelated create conflicts when the normalized name remains absent', async () => {
    const conflict = new ConflictError('Community skill source repository already exists.');
    const ctx = createContext({
      createCommunitySkillSource: jest.fn().mockRejectedValue(conflict),
    });

    await expect(runSeedPreseedJeffallanClaudeSkills(ctx)).rejects.toBe(conflict);
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
});
