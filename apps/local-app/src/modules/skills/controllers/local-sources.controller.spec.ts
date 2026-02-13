import { Test, TestingModule } from '@nestjs/testing';
import { LocalSourcesController } from './local-sources.controller';
import { LocalSourcesService } from '../services/local-sources.service';

describe('LocalSourcesController', () => {
  let controller: LocalSourcesController;
  let localSourcesService: {
    listLocalSources: jest.Mock;
    createLocalSource: jest.Mock;
    deleteLocalSource: jest.Mock;
  };

  const sampleSource = {
    id: '00000000-0000-0000-0000-000000000121',
    name: 'local-source',
    folderPath: '/tmp/local-source',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    localSourcesService = {
      listLocalSources: jest.fn().mockResolvedValue([]),
      createLocalSource: jest.fn().mockResolvedValue(sampleSource),
      deleteLocalSource: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LocalSourcesController],
      providers: [
        {
          provide: LocalSourcesService,
          useValue: localSourcesService,
        },
      ],
    }).compile();

    controller = module.get(LocalSourcesController);
  });

  it('lists all local sources', async () => {
    localSourcesService.listLocalSources.mockResolvedValue([sampleSource]);

    const result = await controller.listLocalSources();

    expect(localSourcesService.listLocalSources).toHaveBeenCalledWith();
    expect(result).toEqual([sampleSource]);
  });

  it('creates local source from request payload', async () => {
    const result = await controller.createLocalSource({
      name: 'local-source',
      folderPath: '/tmp/local-source/../local-source',
    });

    expect(localSourcesService.createLocalSource).toHaveBeenCalledWith({
      name: 'local-source',
      folderPath: '/tmp/local-source/../local-source',
    });
    expect(result).toEqual(sampleSource);
  });

  it('deletes local source by id', async () => {
    const result = await controller.deleteLocalSource({
      id: '00000000-0000-0000-0000-000000000121',
    });

    expect(localSourcesService.deleteLocalSource).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000121',
    );
    expect(result).toEqual({ success: true });
  });
});
