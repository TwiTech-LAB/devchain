import { Test, TestingModule } from '@nestjs/testing';
import { CommunitySourcesController } from './community-sources.controller';
import { CommunitySourcesService } from '../services/community-sources.service';

describe('CommunitySourcesController', () => {
  let controller: CommunitySourcesController;
  let communitySourcesService: {
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
    communitySourcesService = {
      listCommunitySources: jest.fn().mockResolvedValue([]),
      createCommunitySource: jest.fn().mockResolvedValue(sampleSource),
      deleteCommunitySource: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CommunitySourcesController],
      providers: [
        {
          provide: CommunitySourcesService,
          useValue: communitySourcesService,
        },
      ],
    }).compile();

    controller = module.get(CommunitySourcesController);
  });

  it('lists all community sources', async () => {
    communitySourcesService.listCommunitySources.mockResolvedValue([sampleSource]);

    const result = await controller.listCommunitySources();

    expect(communitySourcesService.listCommunitySources).toHaveBeenCalledWith();
    expect(result).toEqual([sampleSource]);
  });

  it('creates source from explicit owner/repo payload', async () => {
    const result = await controller.createCommunitySource({
      name: 'jeffallan',
      repoOwner: 'JeffAllan',
      repoName: 'Claude-Skills',
      branch: 'main',
    });

    expect(communitySourcesService.createCommunitySource).toHaveBeenCalledWith({
      name: 'jeffallan',
      repoOwner: 'JeffAllan',
      repoName: 'Claude-Skills',
      branch: 'main',
    });
    expect(result).toEqual(sampleSource);
  });

  it('creates source from github url payload', async () => {
    await controller.createCommunitySource({
      name: 'jeffallan',
      url: 'https://github.com/JeffAllan/claude-skills',
    });

    expect(communitySourcesService.createCommunitySource).toHaveBeenCalledWith({
      name: 'jeffallan',
      repoOwner: 'JeffAllan',
      repoName: 'claude-skills',
      branch: 'main',
    });
  });

  it('deletes a source by id', async () => {
    const result = await controller.deleteCommunitySource({
      id: '00000000-0000-0000-0000-000000000011',
    });

    expect(communitySourcesService.deleteCommunitySource).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000011',
    );
    expect(result).toEqual({ success: true });
  });
});
