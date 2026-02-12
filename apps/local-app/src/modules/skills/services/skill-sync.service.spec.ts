import { NotFoundError } from '../../../common/errors/error-types';
import { SkillSourceAdapter, SkillSourceSyncContext } from '../adapters/skill-source.adapter';
import { SkillSyncService } from './skill-sync.service';

const makeManifest = (name: string) => ({
  name,
  description: `Description for ${name}`,
  frontmatter: {},
  instructionContent: `Instructions for ${name}`,
  resources: [],
  sourceUrl: `https://example.test/${name}`,
});

const makeContext = (
  skillNames: string[],
  downloadSkill?: (skillName: string, targetPath: string) => Promise<string>,
): jest.Mocked<SkillSourceSyncContext> => {
  const manifests = new Map(skillNames.map((skillName) => [skillName, makeManifest(skillName)]));
  return {
    manifests,
    downloadSkill: jest.fn(
      downloadSkill ?? (async (skillName: string) => `/tmp/skills/${skillName}`),
    ),
    dispose: jest.fn().mockResolvedValue(undefined),
  };
};

const makeAdapter = (
  sourceName: string,
  context: jest.Mocked<SkillSourceSyncContext>,
): jest.Mocked<SkillSourceAdapter> => ({
  sourceName,
  repoUrl: `https://example.test/${sourceName}`,
  createSyncContext: jest.fn().mockResolvedValue(context),
  listSkills: jest.fn(),
  downloadSkill: jest.fn(),
  getLatestCommit: jest.fn().mockResolvedValue(`${sourceName}-sha`),
});

describe('SkillSyncService', () => {
  let skillsService: {
    getSkillBySlug: jest.Mock;
    upsertSkill: jest.Mock;
  };
  let skillCategoryService: {
    deriveCategory: jest.Mock;
  };
  let settingsService: {
    getSkillsSyncOnStartup: jest.Mock;
    getSkillSourcesEnabled: jest.Mock;
  };

  beforeEach(() => {
    skillsService = {
      getSkillBySlug: jest.fn().mockRejectedValue(new NotFoundError('Skill', 'missing')),
      upsertSkill: jest.fn().mockResolvedValue(undefined),
    };
    skillCategoryService = {
      deriveCategory: jest.fn().mockReturnValue('general'),
    };
    settingsService = {
      getSkillsSyncOnStartup: jest.fn().mockReturnValue(false),
      getSkillSourcesEnabled: jest.fn().mockReturnValue({}),
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('calls commit lookup and sync context creation once for a source sync run', async () => {
    const context = makeContext(['skill-a', 'skill-b']);
    const adapter = makeAdapter('anthropic', context);
    const service = new SkillSyncService(
      [adapter],
      skillsService as never,
      skillCategoryService as never,
      settingsService as never,
    );

    const result = await service.syncSource('anthropic');

    expect(adapter.getLatestCommit).toHaveBeenCalledTimes(1);
    expect(adapter.createSyncContext).toHaveBeenCalledTimes(1);
    expect(context.downloadSkill).toHaveBeenCalledTimes(2);
    expect(context.dispose).toHaveBeenCalledTimes(1);
    expect(adapter.listSkills).not.toHaveBeenCalled();
    expect(adapter.downloadSkill).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'completed',
      added: 2,
      updated: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    });
  });

  it('handles per-skill failures without aborting the source sync', async () => {
    const context = makeContext(['skill-a', 'skill-b'], async (skillName: string) => {
      if (skillName === 'skill-b') {
        throw new Error('copy failed');
      }
      return `/tmp/skills/${skillName}`;
    });
    const adapter = makeAdapter('openai', context);
    const service = new SkillSyncService(
      [adapter],
      skillsService as never,
      skillCategoryService as never,
      settingsService as never,
    );

    const result = await service.syncSource('openai');

    expect(result.added).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({
        sourceName: 'openai',
        skillSlug: 'openai/skill-b',
        message: 'copy failed',
      }),
    ]);
    expect(context.dispose).toHaveBeenCalledTimes(1);

    const statuses = skillsService.upsertSkill.mock.calls.map(([, payload]) => payload.status);
    expect(statuses).toContain('available');
    expect(statuses).toContain('sync_error');
  });

  it('bounds source-level sync calls to once per source during syncAll', async () => {
    const anthropicContext = makeContext(['skill-a']);
    const openaiContext = makeContext(['skill-b']);
    const anthropicAdapter = makeAdapter('anthropic', anthropicContext);
    const openaiAdapter = makeAdapter('openai', openaiContext);
    const service = new SkillSyncService(
      [anthropicAdapter, openaiAdapter],
      skillsService as never,
      skillCategoryService as never,
      settingsService as never,
    );

    const result = await service.syncAll();

    expect(anthropicAdapter.getLatestCommit).toHaveBeenCalledTimes(1);
    expect(anthropicAdapter.createSyncContext).toHaveBeenCalledTimes(1);
    expect(openaiAdapter.getLatestCommit).toHaveBeenCalledTimes(1);
    expect(openaiAdapter.createSyncContext).toHaveBeenCalledTimes(1);
    expect(anthropicContext.dispose).toHaveBeenCalledTimes(1);
    expect(openaiContext.dispose).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    expect(result.added).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('skips disabled sources during syncAll', async () => {
    const anthropicContext = makeContext(['skill-a']);
    const openaiContext = makeContext(['skill-b']);
    const anthropicAdapter = makeAdapter('anthropic', anthropicContext);
    const openaiAdapter = makeAdapter('openai', openaiContext);
    settingsService.getSkillSourcesEnabled.mockReturnValue({ openai: false });

    const service = new SkillSyncService(
      [anthropicAdapter, openaiAdapter],
      skillsService as never,
      skillCategoryService as never,
      settingsService as never,
    );

    const result = await service.syncAll();

    expect(anthropicAdapter.getLatestCommit).toHaveBeenCalledTimes(1);
    expect(openaiAdapter.getLatestCommit).not.toHaveBeenCalled();
    expect(result.added).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('returns completed no-op when requested source is disabled', async () => {
    const context = makeContext(['skill-a']);
    const adapter = makeAdapter('openai', context);
    settingsService.getSkillSourcesEnabled.mockReturnValue({ openai: false });

    const service = new SkillSyncService(
      [adapter],
      skillsService as never,
      skillCategoryService as never,
      settingsService as never,
    );

    const result = await service.syncSource('openai');

    expect(adapter.getLatestCommit).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'completed',
      added: 0,
      updated: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    });
  });

  it('returns explicit already_running result for concurrent sync requests', async () => {
    const context = makeContext([]);
    const adapter = makeAdapter('anthropic', context);
    let releaseCommit: ((value: string) => void) | null = null;
    adapter.getLatestCommit.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releaseCommit = resolve;
        }),
    );

    const service = new SkillSyncService(
      [adapter],
      skillsService as never,
      skillCategoryService as never,
      settingsService as never,
    );

    const firstRunPromise = service.syncAll();
    await Promise.resolve();

    const secondRunResult = await service.syncAll();
    expect(secondRunResult).toEqual({
      status: 'already_running',
      added: 0,
      updated: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    });

    releaseCommit?.('anthropic-sha');
    const firstRunResult = await firstRunPromise;
    expect(firstRunResult.status).toBe('completed');
  });
});
