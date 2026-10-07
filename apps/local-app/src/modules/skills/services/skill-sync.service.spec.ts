import { NotFoundError } from '../../../common/errors/error-types';
import { rm } from 'node:fs/promises';
import { SkillSourceAdapter, SkillSourceSyncContext } from '../adapters/skill-source.adapter';
import { SkillSyncService } from './skill-sync.service';

jest.mock('node:fs/promises', () => ({
  rm: jest.fn(),
}));

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
    discoveryErrors: [],
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
  let skillSourceRegistry: {
    getAdapters: jest.Mock;
    getAdapterBySourceName: jest.Mock;
  };
  let skillsService: {
    getSkillBySlug: jest.Mock;
    upsertSkill: jest.Mock;
    listSkillsBySource: jest.Mock;
    deleteSkillBySlug: jest.Mock;
  };
  let skillCategoryService: {
    deriveCategory: jest.Mock;
  };
  let settingsService: {
    getSkillSourcesEnabled: jest.Mock;
    getSkillsCompletedSyncs: jest.Mock;
    setSkillCompletedSync: jest.Mock;
  };
  let service: SkillSyncService;

  beforeEach(() => {
    skillSourceRegistry = {
      getAdapters: jest.fn().mockResolvedValue([]),
      getAdapterBySourceName: jest.fn().mockResolvedValue(null),
    };
    skillsService = {
      getSkillBySlug: jest.fn().mockRejectedValue(new NotFoundError('Skill', 'missing')),
      upsertSkill: jest.fn().mockResolvedValue(undefined),
      listSkillsBySource: jest.fn().mockResolvedValue([]),
      deleteSkillBySlug: jest.fn().mockResolvedValue(true),
    };
    skillCategoryService = {
      deriveCategory: jest.fn().mockReturnValue('general'),
    };
    settingsService = {
      getSkillSourcesEnabled: jest.fn().mockReturnValue({}),
      getSkillsCompletedSyncs: jest.fn().mockReturnValue({}),
      setSkillCompletedSync: jest.fn(),
    };
    jest.mocked(rm).mockReset();
    jest.mocked(rm).mockResolvedValue(undefined);
    service = new SkillSyncService(
      skillSourceRegistry as never,
      skillsService as never,
      skillCategoryService as never,
      settingsService as never,
    );
  });

  it('skips a completed source and reports its stored skill count', async () => {
    const adapter = makeAdapter('openai', makeContext(['skill-a', 'skill-b']));
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
    settingsService.getSkillsCompletedSyncs.mockReturnValue({
      openai: { commit: 'openai-sha', skillCount: 2 },
    });
    skillsService.listSkillsBySource.mockResolvedValue([
      { slug: 'openai/skill-a', status: 'available' },
      { slug: 'openai/skill-b', status: 'available' },
    ]);

    const result = await service.syncSource('openai');

    expect(adapter.createSyncContext).not.toHaveBeenCalled();
    expect(result).toMatchObject({ unchanged: 2, added: 0, failed: 0 });
    expect(settingsService.setSkillCompletedSync).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: 'changed commit',
      commit: 'old-sha',
      skillCount: 1,
      skills: [{ slug: 'openai/skill-a', status: 'available' }],
    },
    { reason: 'deleted and re-added source', commit: 'openai-sha', skillCount: 1, skills: [] },
    {
      reason: 'sync error',
      commit: 'openai-sha',
      skillCount: 1,
      skills: [{ slug: 'openai/skill-a', status: 'sync_error' }],
    },
  ])('downloads the source after $reason', async ({ commit, skillCount, skills }) => {
    const adapter = makeAdapter('openai', makeContext(['skill-a']));
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
    settingsService.getSkillsCompletedSyncs.mockReturnValue({ openai: { commit, skillCount } });
    skillsService.listSkillsBySource.mockResolvedValue(skills);

    await service.syncSource('openai');

    expect(adapter.createSyncContext).toHaveBeenCalledTimes(1);
  });

  it.each(['source', 'all'])(
    'forces a %s sync even with a matching completed entry',
    async (scope) => {
      const adapter = makeAdapter('openai', makeContext(['skill-a']));
      skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
      skillSourceRegistry.getAdapters.mockResolvedValue([adapter]);
      settingsService.getSkillsCompletedSyncs.mockReturnValue({
        openai: { commit: 'openai-sha', skillCount: 1 },
      });
      skillsService.listSkillsBySource.mockResolvedValue([
        { slug: 'openai/skill-a', status: 'available' },
      ]);

      if (scope === 'source') await service.syncSource('openai', { force: true });
      else await service.syncAll({ force: true });

      expect(adapter.createSyncContext).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, { commit: 'old-sha', skillCount: 2 }])(
    'recovers an interrupted sync without replacing its previous completion record',
    async (previous) => {
      const stored = new Map<string, { slug: string; sourceCommit: string; status: string }>();
      const entries = previous ? { openai: previous } : {};
      settingsService.getSkillsCompletedSyncs.mockImplementation(() => entries);
      settingsService.setSkillCompletedSync.mockImplementation((name, entry) => {
        Object.assign(entries, { [name]: entry });
      });
      skillsService.getSkillBySlug.mockImplementation(async (slug) => {
        if (!stored.has(slug)) throw new NotFoundError('Skill', slug);
        return stored.get(slug);
      });
      skillsService.upsertSkill.mockImplementation(async (slug, payload) => {
        stored.set(slug, { slug, ...payload });
      });
      skillsService.listSkillsBySource.mockImplementation(async () => [...stored.values()]);
      const adapter = makeAdapter('openai', makeContext(['skill-a', 'skill-b']));
      skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
      skillsService.getSkillBySlug.mockImplementationOnce(async () => {
        throw new NotFoundError('Skill', 'skill-a');
      });
      skillsService.getSkillBySlug.mockImplementationOnce(async () => {
        throw new Error('interrupted');
      });

      await expect(service.syncSource('openai')).rejects.toThrow('interrupted');
      expect(settingsService.setSkillCompletedSync).not.toHaveBeenCalled();

      const result = await service.syncSource('openai');
      expect(adapter.createSyncContext).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ added: 1, unchanged: 1, failed: 0 });
      expect(stored.size).toBe(2);
      expect(settingsService.setSkillCompletedSync).toHaveBeenCalledWith('openai', {
        commit: 'openai-sha',
        skillCount: 2,
      });
    },
  );

  it('records the stored count after stale cleanup succeeds', async () => {
    const adapter = makeAdapter('openai', makeContext(['skill-a']));
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
    skillsService.listSkillsBySource.mockResolvedValueOnce([
      { slug: 'openai/skill-a' },
      { slug: 'openai/stale' },
    ]);

    await service.syncSource('openai');

    expect(settingsService.setSkillCompletedSync).toHaveBeenCalledWith('openai', {
      commit: 'openai-sha',
      skillCount: 1,
    });
    expect(skillsService.deleteSkillBySlug.mock.invocationCallOrder[0]).toBeLessThan(
      settingsService.setSkillCompletedSync.mock.invocationCallOrder[0],
    );
  });

  it('calls commit lookup and sync context creation once for a source sync run', async () => {
    const context = makeContext(['skill-a', 'skill-b']);
    const adapter = makeAdapter('anthropic', context);
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
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
      removed: 0,
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
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
    const result = await service.syncSource('openai');

    expect(result.added).toBe(1);
    expect(result.failed).toBe(1);
    expect(settingsService.setSkillCompletedSync).not.toHaveBeenCalled();
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

  it('removes stale skills that are no longer present in source manifests', async () => {
    const order: string[] = [];
    const context = makeContext(['skill-a']);
    const adapter = makeAdapter('openai', context);
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
    skillsService.listSkillsBySource.mockResolvedValue([
      { slug: 'openai/skill-a' },
      { slug: 'openai/stale-skill' },
    ]);
    jest.mocked(rm).mockImplementation(async () => {
      order.push('filesystem');
    });
    skillsService.deleteSkillBySlug.mockImplementation(async () => {
      order.push('database');
      return true;
    });

    const result = await service.syncSource('openai');

    expect(skillsService.deleteSkillBySlug).toHaveBeenCalledTimes(1);
    expect(skillsService.deleteSkillBySlug).toHaveBeenCalledWith('openai/stale-skill');
    expect(rm).toHaveBeenCalledWith(
      expect.stringContaining('/.devchain/skills/openai/stale-skill'),
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(result.removed).toBe(1);
    expect(order).toEqual(['filesystem', 'database']);
  });

  it('retains database-only cleanup for malformed stale slugs', async () => {
    const context = makeContext([]);
    const adapter = makeAdapter('openai', context);
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
    skillsService.listSkillsBySource.mockResolvedValue([{ slug: 'malformed-stale-skill' }]);

    const result = await service.syncSource('openai');

    expect(rm).not.toHaveBeenCalled();
    expect(skillsService.deleteSkillBySlug).toHaveBeenCalledWith('malformed-stale-skill');
    expect(result.removed).toBe(1);
  });

  it('does not run stale cleanup when sync context setup fails', async () => {
    const context = makeContext(['skill-a']);
    const adapter = makeAdapter('openai', context);
    adapter.createSyncContext.mockRejectedValue(new Error('setup failed'));
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);

    const result = await service.syncSource('openai');

    expect(skillsService.listSkillsBySource).not.toHaveBeenCalled();
    expect(skillsService.deleteSkillBySlug).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(result.removed).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('keeps stale skill database state when filesystem cleanup fails', async () => {
    const context = makeContext(['skill-a']);
    const adapter = makeAdapter('openai', context);
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
    skillsService.listSkillsBySource.mockResolvedValue([{ slug: 'openai/stale-skill' }]);
    jest.mocked(rm).mockRejectedValue(new Error('permission denied'));

    const result = await service.syncSource('openai');

    expect(skillsService.deleteSkillBySlug).not.toHaveBeenCalled();
    expect(result.removed).toBe(0);
    expect(result.failed).toBe(1);
    expect(settingsService.setSkillCompletedSync).not.toHaveBeenCalled();
    expect(result.errors).toEqual([
      expect.objectContaining({
        sourceName: 'openai',
        skillSlug: 'openai/stale-skill',
        message: 'permission denied',
      }),
    ]);
  });

  it('reports database deletion failure after filesystem cleanup and remains retryable', async () => {
    const context = makeContext([]);
    const adapter = makeAdapter('openai', context);
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);
    skillsService.listSkillsBySource.mockResolvedValue([{ slug: 'openai/stale-skill' }]);
    skillsService.deleteSkillBySlug.mockRejectedValueOnce(new Error('database failed'));

    const first = await service.syncSource('openai');
    expect(rm).toHaveBeenCalledTimes(1);
    expect(first.removed).toBe(0);
    expect(first.failed).toBe(1);
    expect(first.errors).toEqual([
      expect.objectContaining({ skillSlug: 'openai/stale-skill', message: 'database failed' }),
    ]);

    const second = await service.syncSource('openai');
    expect(rm).toHaveBeenCalledTimes(2);
    expect(second.removed).toBe(1);
    expect(second.failed).toBe(0);
  });

  it('bounds source-level sync calls to once per source during syncAll', async () => {
    const anthropicContext = makeContext(['skill-a']);
    const openaiContext = makeContext(['skill-b']);
    const anthropicAdapter = makeAdapter('anthropic', anthropicContext);
    const openaiAdapter = makeAdapter('openai', openaiContext);
    skillSourceRegistry.getAdapters.mockResolvedValue([anthropicAdapter, openaiAdapter]);
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
    skillSourceRegistry.getAdapters.mockResolvedValue([anthropicAdapter, openaiAdapter]);

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
    skillSourceRegistry.getAdapterBySourceName.mockResolvedValue(adapter);

    const result = await service.syncSource('openai');

    expect(adapter.getLatestCommit).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'completed',
      added: 0,
      updated: 0,
      removed: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    });
  });
});
