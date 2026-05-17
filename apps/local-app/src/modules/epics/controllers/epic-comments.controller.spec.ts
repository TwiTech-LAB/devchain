import { Test, TestingModule } from '@nestjs/testing';
import { ZodError } from 'zod';
import { EpicCommentsController } from './epic-comments.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { EpicsService } from '../services/epics.service';

describe('EpicCommentsController', () => {
  let controller: EpicCommentsController;
  const storage = {
    listEpicComments: jest.fn(),
    deleteEpicComment: jest.fn(),
  };
  const epicsService = {
    addEpicCommentFromRest: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EpicCommentsController],
      providers: [
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: EpicsService, useValue: epicsService },
      ],
    }).compile();

    controller = module.get<EpicCommentsController>(EpicCommentsController);
    jest.clearAllMocks();
  });

  it('creates comments via EpicsService so event publication stays in service layer', async () => {
    const comment = {
      id: 'comment-1',
      epicId: 'epic-1',
      authorName: 'Agent',
      content: 'Hello',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    epicsService.addEpicCommentFromRest.mockResolvedValue(comment);

    const result = await controller.createEpicComment('epic-1', {
      authorName: 'Agent',
      content: 'Hello',
    });

    expect(epicsService.addEpicCommentFromRest).toHaveBeenCalledWith('epic-1', 'Agent', 'Hello');
    expect(result).toEqual(comment);
  });

  it('rejects invalid create body', async () => {
    await expect(
      controller.createEpicComment('epic-1', { content: 'missing author' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(epicsService.addEpicCommentFromRest).not.toHaveBeenCalled();
  });

  it('keeps list behavior unchanged (delegates to storage with parsed options)', async () => {
    const comments = { items: [], total: 0 };
    storage.listEpicComments.mockResolvedValue(comments);

    const result = await controller.listEpicComments('epic-1', '10', '5');

    expect(storage.listEpicComments).toHaveBeenCalledWith('epic-1', { limit: 10, offset: 5 });
    expect(result).toEqual(comments);
  });

  it('keeps delete behavior unchanged (delegates to storage)', async () => {
    storage.deleteEpicComment.mockResolvedValue(undefined);

    await controller.deleteEpicComment('comment-1');

    expect(storage.deleteEpicComment).toHaveBeenCalledWith('comment-1');
  });
});
