import { Test, TestingModule } from '@nestjs/testing';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type {
  ScheduledEpic,
  ScheduledEpicRun,
} from '../../storage/models/domain.models';
import { SchedulesService } from './schedules.service';
import { SchedulerRunnerService } from './scheduler-runner.service';
import { EpicsService } from '../../epics/services/epics.service';
import { EventsService } from '../../events/services/events.service';

describe('SchedulerRunnerService', () => {
  let runner: SchedulerRunnerService;
  let mockStorage: {
    updateScheduledEpic: jest.Mock;
    createScheduledEpicRun: jest.Mock;
    listDueScheduledEpics: jest.Mock;
    getScheduledEpic: jest.Mock;
    listScheduledEpics: jest.Mock;
    createScheduledEpic: jest.Mock;
    deleteScheduledEpic: jest.Mock;
    listScheduledEpicRuns: jest.Mock;
  };
  let mockEpicsService: {
    createEpicForProject: jest.Mock;
  };
  let mockEventsService: {
    publish: jest.Mock;
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
    templateTitle: 'Daily standup - {{date}}',
    templateDescription: 'Description for {{sequence}}',
    templateStatusId: 'status-1',
    templateAgentId: 'agent-1',
    templateParentId: null,
    templateTags: ['tag-1'],
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
      updateScheduledEpic: jest.fn().mockResolvedValue(createMockSchedule()),
      createScheduledEpicRun: jest.fn().mockResolvedValue({}),
      listDueScheduledEpics: jest.fn().mockResolvedValue([]),
      getScheduledEpic: jest.fn().mockResolvedValue(null),
      listScheduledEpics: jest.fn().mockResolvedValue([]),
      createScheduledEpic: jest.fn().mockResolvedValue(createMockSchedule()),
      deleteScheduledEpic: jest.fn().mockResolvedValue(undefined),
      listScheduledEpicRuns: jest.fn().mockResolvedValue([]),
    };

    mockEpicsService = {
      createEpicForProject: jest.fn().mockResolvedValue({
        id: 'epic-1',
        projectId: 'project-1',
        title: 'Daily standup - 2026-05-12',
        description: 'Description for 1',
        statusId: 'status-1',
        agentId: 'agent-1',
        parentId: null,
        version: 1,
        data: null,
        skillsRequired: null,
        tags: ['tag-1'],
        createdAt: '2026-05-12T10:00:00.000Z',
        updatedAt: '2026-05-12T10:00:00.000Z',
      }),
    };

    mockEventsService = {
      publish: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerRunnerService,
        SchedulesService,
        { provide: STORAGE_SERVICE, useValue: mockStorage },
        { provide: EpicsService, useValue: mockEpicsService },
        { provide: EventsService, useValue: mockEventsService },
      ],
    }).compile();

    runner = module.get<SchedulerRunnerService>(SchedulerRunnerService);
  });

  afterEach(() => {
    runner.onModuleDestroy();
  });

  describe('onModuleInit', () => {
    it('initializes without error', async () => {
      await expect(runner.onModuleInit()).resolves.not.toThrow();
    });
  });

  describe('tick', () => {
    it('does nothing when no schedules are due', async () => {
      mockStorage.listDueScheduledEpics.mockResolvedValue([]);

      // Access private tick method
      await (runner as any).tick();

      expect(mockStorage.createScheduledEpicRun).not.toHaveBeenCalled();
    });

    it('executes due schedules', async () => {
      const schedule = createMockSchedule();
      mockStorage.listDueScheduledEpics.mockResolvedValue([schedule]);

      await (runner as any).tick();

      expect(mockEpicsService.createEpicForProject).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({
          title: expect.stringContaining('Daily standup'),
          statusId: 'status-1',
          agentId: 'agent-1',
        }),
      );
      expect(mockStorage.updateScheduledEpic).toHaveBeenCalledWith(
        'schedule-1',
        expect.objectContaining({
          occurrenceCount: 1,
          lastRunAt: expect.any(String),
          nextRunAt: expect.any(String),
        }),
      );
      expect(mockStorage.createScheduledEpicRun).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledEpicId: 'schedule-1',
          epicId: 'epic-1',
          status: 'success',
        }),
      );
      expect(mockEventsService.publish).toHaveBeenCalledWith(
        'scheduled_epic.executed',
        expect.objectContaining({
          scheduledEpicId: 'schedule-1',
          epicId: 'epic-1',
          projectId: 'project-1',
        }),
      );
    });
  });

  describe('executeSchedule - maxOccurrences', () => {
    it('disables schedule when maxOccurrences is reached', async () => {
      const schedule = createMockSchedule({
        maxOccurrences: 5,
        occurrenceCount: 5,
      });
      mockStorage.listDueScheduledEpics.mockResolvedValue([schedule]);

      await (runner as any).tick();

      expect(mockStorage.updateScheduledEpic).toHaveBeenCalledWith('schedule-1', {
        enabled: false,
        nextRunAt: null,
      });
      expect(mockEpicsService.createEpicForProject).not.toHaveBeenCalled();
    });

    it('does not disable when occurrenceCount is below max', async () => {
      const schedule = createMockSchedule({
        maxOccurrences: 10,
        occurrenceCount: 5,
      });
      mockStorage.listDueScheduledEpics.mockResolvedValue([schedule]);

      await (runner as any).tick();

      expect(mockEpicsService.createEpicForProject).toHaveBeenCalled();
    });
  });

  describe('executeSchedule - cooldown', () => {
    it('skips execution when on cooldown', async () => {
      const schedule = createMockSchedule({
        cooldownMs: 60000,
        lastRunAt: new Date().toISOString(),
      });
      mockStorage.listDueScheduledEpics.mockResolvedValue([schedule]);

      await (runner as any).tick();

      expect(mockEpicsService.createEpicForProject).not.toHaveBeenCalled();
    });

    it('executes when cooldown has passed', async () => {
      const schedule = createMockSchedule({
        cooldownMs: 1000,
        lastRunAt: new Date(Date.now() - 5000).toISOString(),
      });
      mockStorage.listDueScheduledEpics.mockResolvedValue([schedule]);

      await (runner as any).tick();

      expect(mockEpicsService.createEpicForProject).toHaveBeenCalled();
    });
  });

  describe('executeSchedule - error handling', () => {
    it('logs failed run when epic creation fails', async () => {
      const schedule = createMockSchedule();
      mockStorage.listDueScheduledEpics.mockResolvedValue([schedule]);
      mockEpicsService.createEpicForProject.mockRejectedValue(new Error('DB error'));

      await (runner as any).tick();

      expect(mockStorage.createScheduledEpicRun).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledEpicId: 'schedule-1',
          epicId: null,
          status: 'failed',
          error: 'DB error',
        }),
      );
    });

    it('continues with next schedule after failure', async () => {
      const schedule1 = createMockSchedule({ id: 's-1' });
      const schedule2 = createMockSchedule({ id: 's-2' });
      mockStorage.listDueScheduledEpics.mockResolvedValue([schedule1, schedule2]);
      mockEpicsService.createEpicForProject
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ id: 'epic-2' });

      await (runner as any).tick();

      expect(mockStorage.createScheduledEpicRun).toHaveBeenCalledTimes(2);
    });
  });

  describe('executeSchedule - template rendering', () => {
    it('renders Handlebars templates with context variables', async () => {
      const schedule = createMockSchedule({
        templateTitle: 'Task {{sequence}} - {{date}}',
        templateDescription: 'Run #{{sequence}} at {{time}}',
      });
      mockStorage.listDueScheduledEpics.mockResolvedValue([schedule]);

      await (runner as any).tick();

      expect(mockEpicsService.createEpicForProject).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({
          title: expect.stringMatching(/^Task 1 - \d{4}-\d{2}-\d{2}$/),
          description: expect.stringMatching(/^Run #1 at \d{2}:\d{2}:\d{2}$/),
        }),
      );
    });

    it('handles null templateDescription', async () => {
      const schedule = createMockSchedule({ templateDescription: null });
      mockStorage.listDueScheduledEpics.mockResolvedValue([schedule]);

      await (runner as any).tick();

      expect(mockEpicsService.createEpicForProject).toHaveBeenCalledWith(
        'project-1',
        expect.objectContaining({ description: null }),
      );
    });

    it('handles broken Handlebars gracefully', async () => {
      const schedule = createMockSchedule({
        templateTitle: 'Task {{#if broken}}}oops{{/if}}',
      });
      mockStorage.listDueScheduledEpics.mockResolvedValue([schedule]);

      await (runner as any).tick();

      expect(mockEpicsService.createEpicForProject).toHaveBeenCalled();
    });
  });
});
