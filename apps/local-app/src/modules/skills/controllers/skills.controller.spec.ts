import { Test, TestingModule } from '@nestjs/testing';
import { SkillsController } from './skills.controller';
import { SkillSyncService } from '../services/skill-sync.service';
import { SkillsService } from '../services/skills.service';

describe('SkillsController', () => {
  let controller: SkillsController;
  let skillSyncService: {
    syncAll: jest.Mock;
    syncSource: jest.Mock;
  };
  let skillsService: {
    listSources: jest.Mock;
    setSourceEnabled: jest.Mock;
    listDisabled: jest.Mock;
    disableAll: jest.Mock;
    enableAll: jest.Mock;
    disableSkill: jest.Mock;
    enableSkill: jest.Mock;
    listAllForProject: jest.Mock;
    listSkills: jest.Mock;
    resolveSkillSummariesBySlugs: jest.Mock;
    getSkillBySlug: jest.Mock;
    getSkill: jest.Mock;
  };

  const projectId = '00000000-0000-0000-0000-000000000001';
  const skillId = '00000000-0000-0000-0000-000000000002';

  beforeEach(async () => {
    skillSyncService = {
      syncAll: jest.fn(),
      syncSource: jest.fn(),
    };
    skillsService = {
      listSources: jest.fn().mockResolvedValue([]),
      setSourceEnabled: jest.fn().mockImplementation(async (name: string, enabled: boolean) => ({
        name,
        enabled,
      })),
      listDisabled: jest.fn().mockResolvedValue([]),
      disableAll: jest.fn().mockResolvedValue(0),
      enableAll: jest.fn().mockResolvedValue(0),
      disableSkill: jest.fn().mockResolvedValue(undefined),
      enableSkill: jest.fn().mockResolvedValue(undefined),
      listAllForProject: jest.fn().mockResolvedValue([]),
      listSkills: jest.fn().mockResolvedValue([]),
      resolveSkillSummariesBySlugs: jest.fn().mockResolvedValue({}),
      getSkillBySlug: jest.fn(),
      getSkill: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SkillsController],
      providers: [
        {
          provide: SkillsService,
          useValue: skillsService,
        },
        {
          provide: SkillSyncService,
          useValue: skillSyncService,
        },
      ],
    }).compile();

    controller = module.get(SkillsController);
  });

  it('returns explicit already_running sync result for concurrent sync calls', async () => {
    skillSyncService.syncAll.mockResolvedValue({
      status: 'already_running',
      added: 0,
      updated: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    });

    const result = await controller.syncSkills({});

    expect(skillSyncService.syncAll).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('already_running');
  });

  it('calls syncSource when sourceName is provided', async () => {
    skillSyncService.syncSource.mockResolvedValue({
      status: 'completed',
      added: 1,
      updated: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    });

    const result = await controller.syncSkills({ sourceName: 'openai' });

    expect(skillSyncService.syncSource).toHaveBeenCalledWith('openai');
    expect(result.status).toBe('completed');
    expect(result.added).toBe(1);
  });

  it('lists disabled skills for a project', async () => {
    skillsService.listDisabled.mockResolvedValue([skillId]);

    const result = await controller.listDisabled({ projectId });

    expect(skillsService.listDisabled).toHaveBeenCalledWith(projectId);
    expect(result).toEqual([skillId]);
  });

  it('lists skill sources with enablement and metadata', async () => {
    const expected = [
      { name: 'openai', enabled: true, repoUrl: 'https://example.test/openai', skillCount: 5 },
    ];
    skillsService.listSources.mockResolvedValue(expected);

    const result = await controller.listSources();

    expect(skillsService.listSources).toHaveBeenCalledWith();
    expect(result).toEqual(expected);
  });

  it('enables a skill source', async () => {
    skillsService.setSourceEnabled.mockResolvedValue({ name: 'openai', enabled: true });

    const result = await controller.enableSource({ name: 'OpenAI' });

    expect(skillsService.setSourceEnabled).toHaveBeenCalledWith('openai', true);
    expect(result).toEqual({ name: 'openai', enabled: true });
  });

  it('disables a skill source', async () => {
    skillsService.setSourceEnabled.mockResolvedValue({ name: 'openai', enabled: false });

    const result = await controller.disableSource({ name: 'openai' });

    expect(skillsService.setSourceEnabled).toHaveBeenCalledWith('openai', false);
    expect(result).toEqual({ name: 'openai', enabled: false });
  });

  it('disables all skills for a project', async () => {
    skillsService.disableAll.mockResolvedValue(3);

    const result = await controller.disableAll({ projectId });

    expect(skillsService.disableAll).toHaveBeenCalledWith(projectId);
    expect(result).toEqual({ projectId, disabledCount: 3 });
  });

  it('enables all skills for a project', async () => {
    skillsService.enableAll.mockResolvedValue(2);

    const result = await controller.enableAll({ projectId });

    expect(skillsService.enableAll).toHaveBeenCalledWith(projectId);
    expect(result).toEqual({ projectId, enabledCount: 2 });
  });

  it('disables a single skill via action route payload', async () => {
    const result = await controller.disableSkill({ id: skillId }, { projectId });

    expect(skillsService.disableSkill).toHaveBeenCalledWith(projectId, skillId);
    expect(result).toEqual({ projectId, skillId });
  });

  it('enables a single skill via action route payload', async () => {
    const result = await controller.enableSkill({ id: skillId }, { projectId });

    expect(skillsService.enableSkill).toHaveBeenCalledWith(projectId, skillId);
    expect(result).toEqual({ projectId, skillId });
  });

  it('uses listAllForProject when projectId is provided', async () => {
    const expected = [{ id: skillId, disabled: true }];
    skillsService.listAllForProject.mockResolvedValue(expected);

    const result = await controller.listSkills({ projectId, q: 'review' });

    expect(skillsService.listAllForProject).toHaveBeenCalledWith(projectId, {
      q: 'review',
      source: undefined,
      category: undefined,
    });
    expect(result).toEqual(expected);
  });

  it('resolves skill summaries in a single batch payload', async () => {
    const resolved = {
      'openai/review': {
        id: skillId,
        slug: 'openai/review',
        name: 'review',
        displayName: 'Review',
        source: 'openai',
        category: 'analysis',
        shortDescription: 'Short',
        description: 'Long',
      },
    };
    skillsService.resolveSkillSummariesBySlugs.mockResolvedValue(resolved);

    const result = await controller.resolveSkills({
      slugs: [' OpenAI/Review ', 'openai/review'],
    });

    expect(skillsService.resolveSkillSummariesBySlugs).toHaveBeenCalledWith(['openai/review']);
    expect(result).toEqual(resolved);
  });
});
