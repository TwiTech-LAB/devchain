import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from '../services/schedules.service';
import type { ScheduledEpic } from '../../storage/models/domain.models';

describe('SchedulesController', () => {
  let controller: SchedulesController;
  let mockService: {
    listScheduledEpics: jest.Mock;
    getScheduledEpic: jest.Mock;
    createScheduledEpic: jest.Mock;
    updateScheduledEpic: jest.Mock;
    deleteScheduledEpic: jest.Mock;
    toggleScheduledEpic: jest.Mock;
    listScheduledEpicRuns: jest.Mock;
    listDueScheduledEpics: jest.Mock;
    validateCronExpression: jest.Mock;
    computeNextRun: jest.Mock;
  };

  const createMockSchedule = (overrides: Partial<ScheduledEpic> = {}): ScheduledEpic => ({
    id: 'schedule-1',
    projectId: 'project-1',
    name: 'Daily Standup',
    description: null,
    enabled: true,
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    lastRunAt: null,
    nextRunAt: '2026-05-13T09:00:00.000Z',
    templateTitle: 'Daily standup',
    templateDescription: null,
    templateStatusId: null,
    templateAgentId: null,
    templateParentId: null,
    templateTags: null,
    templateSkillsRequired: null,
    templateData: null,
    maxOccurrences: null,
    occurrenceCount: 0,
    cooldownMs: 0,
    position: 0,
    createdAt: '2026-05-12T10:00:00.000Z',
    updatedAt: '2026-05-12T10:00:00.000Z',
    ...overrides,
  });

  const validCreateData = {
    projectId: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Daily Standup',
    cronExpression: '0 9 * * *',
    templateTitle: 'Daily standup - {{date}}',
  };

  beforeEach(async () => {
    mockService = {
      listScheduledEpics: jest.fn(),
      getScheduledEpic: jest.fn(),
      createScheduledEpic: jest.fn(),
      updateScheduledEpic: jest.fn(),
      deleteScheduledEpic: jest.fn(),
      toggleScheduledEpic: jest.fn(),
      listScheduledEpicRuns: jest.fn(),
      listDueScheduledEpics: jest.fn(),
      validateCronExpression: jest.fn(),
      computeNextRun: jest.fn().mockReturnValue('2026-05-13T09:00:00.000Z'),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SchedulesController],
      providers: [{ provide: SchedulesService, useValue: mockService }],
    }).compile();

    controller = module.get<SchedulesController>(SchedulesController);
  });

  describe('listPresets', () => {
    it('returns cron presets', () => {
      const result = controller.listPresets();

      expect(result.presets).toBeInstanceOf(Array);
      expect(result.presets.length).toBeGreaterThan(0);
      expect(result.presets[0]).toHaveProperty('label');
      expect(result.presets[0]).toHaveProperty('cronExpression');
      expect(result.presets[0]).toHaveProperty('description');
    });
  });

  describe('listScheduledEpics', () => {
    it('returns schedules for a project', async () => {
      const schedules = [createMockSchedule()];
      mockService.listScheduledEpics.mockResolvedValue(schedules);

      const result = await controller.listScheduledEpics('project-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('schedule-1');
    });

    it('throws BadRequestException when projectId is missing', async () => {
      await expect(controller.listScheduledEpics()).rejects.toThrow(BadRequestException);
    });
  });

  describe('getScheduledEpic', () => {
    it('returns a schedule by id', async () => {
      mockService.getScheduledEpic.mockResolvedValue(createMockSchedule());

      const result = await controller.getScheduledEpic('schedule-1');

      expect(result.id).toBe('schedule-1');
    });
  });

  describe('listRuns', () => {
    it('returns run history', async () => {
      const runs = [{ id: 'run-1', status: 'success', epicId: 'epic-1' }];
      mockService.listScheduledEpicRuns.mockResolvedValue(runs);

      const result = await controller.listRuns('schedule-1');

      expect(mockService.listScheduledEpicRuns).toHaveBeenCalledWith('schedule-1');
    });
  });

  describe('createScheduledEpic', () => {
    it('creates with valid data', async () => {
      mockService.createScheduledEpic.mockResolvedValue(createMockSchedule());

      const result = await controller.createScheduledEpic(validCreateData);

      expect(mockService.createScheduledEpic).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: validCreateData.projectId,
          name: 'Daily Standup',
          cronExpression: '0 9 * * *',
        }),
      );
      expect(result.id).toBe('schedule-1');
    });

    it('rejects missing projectId', async () => {
      await expect(
        controller.createScheduledEpic({ name: 'Test', cronExpression: '0 * * * *', templateTitle: 'T' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects missing name', async () => {
      await expect(
        controller.createScheduledEpic({
          projectId: '550e8400-e29b-41d4-a716-446655440000',
          cronExpression: '0 * * * *',
          templateTitle: 'T',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects missing templateTitle', async () => {
      await expect(
        controller.createScheduledEpic({
          projectId: '550e8400-e29b-41d4-a716-446655440000',
          name: 'Test',
          cronExpression: '0 * * * *',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects missing cronExpression', async () => {
      await expect(
        controller.createScheduledEpic({
          projectId: '550e8400-e29b-41d4-a716-446655440000',
          name: 'Test',
          templateTitle: 'T',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateScheduledEpic', () => {
    it('updates with valid partial data', async () => {
      mockService.updateScheduledEpic.mockResolvedValue(
        createMockSchedule({ name: 'Updated' }),
      );

      const result = await controller.updateScheduledEpic('schedule-1', { name: 'Updated' });

      expect(result.name).toBe('Updated');
    });

    it('rejects invalid name (empty string)', async () => {
      await expect(
        controller.updateScheduledEpic('schedule-1', { name: '' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteScheduledEpic', () => {
    it('deletes an existing schedule', async () => {
      mockService.deleteScheduledEpic.mockResolvedValue(undefined);

      await controller.deleteScheduledEpic('schedule-1');

      expect(mockService.deleteScheduledEpic).toHaveBeenCalledWith('schedule-1');
    });
  });

  describe('toggleScheduledEpic', () => {
    it('toggles enabled status', async () => {
      mockService.toggleScheduledEpic.mockResolvedValue(
        createMockSchedule({ enabled: false }),
      );

      const result = await controller.toggleScheduledEpic('schedule-1', { enabled: false });

      expect(mockService.toggleScheduledEpic).toHaveBeenCalledWith('schedule-1', false);
    });

    it('rejects invalid body', async () => {
      await expect(
        controller.toggleScheduledEpic('schedule-1', { enabled: 'yes' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
