import { Test, TestingModule } from '@nestjs/testing';
import { CommunitySourcesController } from './community-sources.controller';
import { SkillSourceLifecycleService } from '../services/skill-source-lifecycle.service';

describe('CommunitySourcesController', () => {
  let controller: CommunitySourcesController;
  let skillSourceLifecycle: {
    listCommunitySources: jest.Mock;
    createCommunitySource: jest.Mock;
    deleteCommunitySource: jest.Mock;
  };

  const sampleSource = {
    id: '00000000-0000-0000-0000-000000000011',
    name: 'jeffallan',
    repoOwner: 'jeffallan',
    repoName: 'claude-skills',
    branch: 'main',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    skillSourceLifecycle = {
      listCommunitySources: jest.fn().mockResolvedValue([]),
      createCommunitySource: jest.fn().mockResolvedValue(sampleSource),
      deleteCommunitySource: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommunitySourcesController],
      providers: [
        {
          provide: SkillSourceLifecycleService,
          useValue: skillSourceLifecycle,
        },
      ],
    }).compile();

    controller = module.get(CommunitySourcesController);
  });

  it('lists all community sources', async () => {
    skillSourceLifecycle.listCommunitySources.mockResolvedValue([sampleSource]);

    const result = await controller.listCommunitySources();

    expect(skillSourceLifecycle.listCommunitySources).toHaveBeenCalledWith();
    expect(result).toEqual([sampleSource]);
  });

  it('creates source from explicit owner/repo payload', async () => {
    const result = await controller.createCommunitySource({
      name: 'jeffallan',
      repoOwner: 'JeffAllan',
      repoName: 'Claude-Skills',
      branch: 'main',
    });

    expect(skillSourceLifecycle.createCommunitySource).toHaveBeenCalledWith({
      name: 'jeffallan',
      repoOwner: 'JeffAllan',
      repoName: 'Claude-Skills',
      branch: 'main',
      existingProjects: { mode: 'none' },
    });
    expect(result).toEqual(sampleSource);
  });

  it('creates source from github url payload', async () => {
    await controller.createCommunitySource({
      name: 'jeffallan',
      url: 'https://github.com/JeffAllan/claude-skills',
    });

    expect(skillSourceLifecycle.createCommunitySource).toHaveBeenCalledWith({
      name: 'jeffallan',
      repoOwner: 'JeffAllan',
      repoName: 'claude-skills',
      branch: 'main',
      existingProjects: { mode: 'none' },
    });
  });

  it('deletes a source by id', async () => {
    const result = await controller.deleteCommunitySource({
      id: '00000000-0000-0000-0000-000000000011',
    });

    expect(skillSourceLifecycle.deleteCommunitySource).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000011',
    );
    expect(result).toEqual({ success: true });
  });
});
