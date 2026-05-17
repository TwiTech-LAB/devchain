import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SchedulesService } from './schedules.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type {
  ScheduledEpic,
  CreateScheduledEpic,
  UpdateScheduledEpic,
  ScheduledEpicRun,
} from '../../storage/models/domain.models';

describe('SchedulesService', () => {
  let service: SchedulesService;
  let mockStorage: {
    listScheduledEpics: jest.Mock;
    getScheduledEpic: jest.Mock;
    createScheduledEpic: jest.Mock;
    updateScheduledEpic: jest.Mock;
    deleteScheduledEpic: jest.Mock;
    listDueScheduledEpics: jest.Mock;
    createScheduledEpicRun: jest.Mock;
    listScheduledEpicRuns: jest.Mock;
  };

  const createMockScheduledEpic = (overrides: Partial<ScheduledEpic> = {}): ScheduledEpic => ({
    id: 'schedule-1',
    projectId: 'project-1',
    name: 'Daily Standup',
    description: null,
    enabled: true,
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    lastRunAt: null,
    nextRunAt: '2026-05-13T09:00:00.000Z',
    templateTitle: 'Daily standup - {{date}}',
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

  beforeEach(async () => {
    mockStorage = {
      listScheduledEpics: jest.fn(),
      getScheduledEpic: jest.fn(),
      createScheduledEpic: jest.fn(),
      updateScheduledEpic: jest.fn(),
      deleteScheduledEpic: jest.fn(),
      listDueScheduledEpics: jest.fn(),
      createScheduledEpicRun: jest.fn(),
      listScheduledEpicRuns: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulesService,
        { provide: STORAGE_SERVICE, useValue: mockStorage },
      ],
    }).compile();

    service = module.get<SchedulesService>(SchedulesService);
  });

  describe('listScheduledEpics', () => {
    it('returns scheduled epics for a project', async () => {
      const schedules = [createMockScheduledEpic(), createMockScheduledEpic({ id: 'schedule-2' })];
      mockStorage.listScheduledEpics.mockResolvedValue(schedules);

      const result = await service.listScheduledEpics('project-1');

      expect(result).toEqual(schedules);
      expect(mockStorage.listScheduledEpics).toHaveBeenCalledWith('project-1');
    });

    it('returns empty array when no schedules exist', async () => {
      mockStorage.listScheduledEpics.mockResolvedValue([]);

      const result = await service.listScheduledEpics('project-1');

      expect(result).toEqual([]);
    });
  });

  describe('getScheduledEpic', () => {
    it('returns a scheduled epic by id', async () => {
      const schedule = createMockScheduledEpic();
      mockStorage.getScheduledEpic.mockResolvedValue(schedule);

      const result = await service.getScheduledEpic('schedule-1');

      expect(result).toEqual(schedule);
    });

    it('throws NotFoundException when not found', async () => {
      mockStorage.getScheduledEpic.mockResolvedValue(null);

      await expect(service.getScheduledEpic('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createScheduledEpic', () => {
    it('creates a scheduled epic with computed nextRunAt', async () => {
      const createData: CreateScheduledEpic = {
        projectId: 'project-1',
        name: 'Daily Standup',
        description: null,
        enabled: true,
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        templateTitle: 'Daily standup',
        templateDescription: null,
        templateStatusId: null,
        templateAgentId: null,
        templateParentId: null,
        templateTags: null,
        templateSkillsRequired: null,
        templateData: null,
        maxOccurrences: null,
        cooldownMs: 0,
        position: 0,
      };

      const created = createMockScheduledEpic();
      mockStorage.createScheduledEpic.mockResolvedValue(created);

      const result = await service.createScheduledEpic(createData);

      expect(mockStorage.createScheduledEpic).toHaveBeenCalledWith(
        expect.objectContaining({
          ...createData,
          nextRunAt: expect.any(String),
        }),
      );
      expect(result).toEqual(created);
    });

    it('rejects invalid cron expression', async () => {
      const createData = {
        projectId: 'project-1',
        name: 'Bad',
        cronExpression: 'not-valid-cron-at-all',
        templateTitle: 'Test',
        enabled: true,
        timezone: 'UTC',
        description: null,
        templateDescription: null,
        templateStatusId: null,
        templateAgentId: null,
        templateParentId: null,
        templateTags: null,
        templateSkillsRequired: null,
        templateData: null,
        maxOccurrences: null,
        cooldownMs: 0,
        position: 0,
      };

      await expect(service.createScheduledEpic(createData as CreateScheduledEpic)).rejects.toThrow();
    });
  });

  describe('updateScheduledEpic', () => {
    it('updates a scheduled epic and recomputes nextRunAt if cron changes', async () => {
      const existing = createMockScheduledEpic();
      const updated = createMockScheduledEpic({ cronExpression: '0 */6 * * *' });

      mockStorage.getScheduledEpic.mockResolvedValue(existing);
      mockStorage.updateScheduledEpic.mockResolvedValue(updated);

      const result = await service.updateScheduledEpic('schedule-1', {
        cronExpression: '0 */6 * * *',
      });

      expect(mockStorage.updateScheduledEpic).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({
          cronExpression: '0 */6 * * *',
          nextRunAt: expect.any(String),
        }),
      );
      expect(result).toEqual(updated);
    });

    it('does not recompute nextRunAt if cron is unchanged', async () => {
      const existing = createMockScheduledEpic();
      mockStorage.getScheduledEpic.mockResolvedValue(existing);
      mockStorage.updateScheduledEpic.mockResolvedValue(createMockScheduledEpic({ name: 'Updated' }));

      await service.updateScheduledEpic('schedule-1', { name: 'Updated' });

      expect(mockStorage.updateScheduledEpic).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({
          name: 'Updated',
          nextRunAt: existing.nextRunAt,
        }),
      );
    });

    it('throws NotFoundException when not found', async () => {
      mockStorage.getScheduledEpic.mockResolvedValue(null);

      await expect(
        service.updateScheduledEpic('nonexistent', { name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteScheduledEpic', () => {
    it('deletes an existing scheduled epic', async () => {
      mockStorage.getScheduledEpic.mockResolvedValue(createMockScheduledEpic());
      mockStorage.deleteScheduledEpic.mockResolvedValue(undefined);

      await service.deleteScheduledEpic('schedule-1');

      expect(mockStorage.deleteScheduledEpic).toHaveBeenCalledWith('schedule-1');
    });

    it('throws NotFoundException when not found', async () => {
      mockStorage.getScheduledEpic.mockResolvedValue(null);

      await expect(service.deleteScheduledEpic('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('toggleScheduledEpic', () => {
    it('enables a disabled schedule and computes nextRunAt', async () => {
      const disabled = createMockScheduledEpic({ enabled: false, nextRunAt: null });
      mockStorage.getScheduledEpic.mockResolvedValue(disabled);
      mockStorage.updateScheduledEpic.mockResolvedValue(
        createMockScheduledEpic({ enabled: true, nextRunAt: '2026-05-13T09:00:00.000Z' }),
      );

      const result = await service.toggleScheduledEpic('schedule-1', true);

      expect(mockStorage.updateScheduledEpic).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({ enabled: true, nextRunAt: expect.any(String) }),
      );
    });

    it('disables a schedule without computing nextRunAt', async () => {
      mockStorage.getScheduledEpic.mockResolvedValue(createMockScheduledEpic());
      mockStorage.updateScheduledEpic.mockResolvedValue(
        createMockScheduledEpic({ enabled: false }),
      );

      await service.toggleScheduledEpic('schedule-1', false);

      expect(mockStorage.updateScheduledEpic).toHaveBeenCalledWith('schedule-1', {
        enabled: false,
      });
    });
  });

  describe('listScheduledEpicRuns', () => {
    it('returns run history', async () => {
      const runs: ScheduledEpicRun[] = [
        {
          id: 'run-1',
          scheduledEpicId: 'schedule-1',
          epicId: 'epic-1',
          status: 'success',
          error: null,
          scheduledAt: '2026-05-12T09:00:00.000Z',
          executedAt: '2026-05-12T09:00:01.000Z',
        },
      ];
      mockStorage.listScheduledEpicRuns.mockResolvedValue(runs);

      const result = await service.listScheduledEpicRuns('schedule-1');

      expect(result).toEqual(runs);
    });
  });

  describe('validateCronExpression', () => {
    it('accepts valid cron expressions', () => {
      expect(() => service.validateCronExpression('0 * * * *')).not.toThrow();
      expect(() => service.validateCronExpression('0 */6 * * *')).not.toThrow();
      expect(() => service.validateCronExpression('0 0 * * 1')).not.toThrow();
    });

    it('rejects invalid cron expressions', () => {
      expect(() => service.validateCronExpression('invalid')).toThrow();
    });
  });

  describe('computeNextRun', () => {
    it('returns an ISO timestamp for a valid cron expression', () => {
      const result = service.computeNextRun('0 9 * * *', 'UTC');

      expect(result).toBeTruthy();
      expect(() => new Date(result)).not.toThrow();
      const nextDate = new Date(result);
      expect(nextDate.getTime()).toBeGreaterThan(Date.now() - 1000);
    });

    it('returns current time for invalid cron (graceful fallback)', () => {
      const result = service.computeNextRun('invalid', 'UTC');

      expect(result).toBeTruthy();
    });
  });
});
