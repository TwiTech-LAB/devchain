import { Test, TestingModule } from '@nestjs/testing';
import { ZodError } from 'zod';
import { EpicsController } from './epics.controller';
import { EpicsService } from '../services/epics.service';

describe('EpicsController - skillsRequired validation', () => {
  let controller: EpicsController;
  let epicsService: {
    createEpic: jest.Mock;
    updateEpic: jest.Mock;
  };

  beforeEach(async () => {
    epicsService = {
      createEpic: jest.fn().mockResolvedValue({ id: 'epic-1' }),
      updateEpic: jest.fn().mockResolvedValue({ id: 'epic-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EpicsController],
      providers: [
        {
          provide: EpicsService,
          useValue: epicsService,
        },
      ],
    }).compile();

    controller = module.get(EpicsController);
  });

  it('normalizes and deduplicates skillsRequired on create', async () => {
    await controller.createEpic({
      projectId: 'project-1',
      title: 'Epic',
      statusId: 'status-1',
      skillsRequired: [' OpenAI/Review ', 'openai/review', 'anthropic/pdf'],
    });

    expect(epicsService.createEpic).toHaveBeenCalledWith(
      expect.objectContaining({
        skillsRequired: ['openai/review', 'anthropic/pdf'],
      }),
    );
  });

  it('rejects malformed skillsRequired on create', async () => {
    await expect(
      controller.createEpic({
        projectId: 'project-1',
        title: 'Epic',
        statusId: 'status-1',
        skillsRequired: ['openai'],
      }),
    ).rejects.toThrow(ZodError);
  });

  it('normalizes and deduplicates skillsRequired on update', async () => {
    await controller.updateEpic('epic-1', {
      version: 3,
      skillsRequired: [' OpenAI/Review ', 'openai/review'],
    });

    expect(epicsService.updateEpic).toHaveBeenCalledWith(
      'epic-1',
      expect.objectContaining({
        skillsRequired: ['openai/review'],
      }),
      3,
    );
  });

  it('rejects malformed skillsRequired on update', async () => {
    await expect(
      controller.updateEpic('epic-1', {
        version: 1,
        skillsRequired: ['openai/review!'],
      }),
    ).rejects.toThrow(ZodError);
  });
});
