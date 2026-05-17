import { ScheduledEpicsService } from './scheduled-epics.service';
import type {
  ScheduledEpicStorage,
  ClaimRunResult,
} from '../../storage/interfaces/storage.interface';
import type { ScheduledEpic } from '../../storage/models/domain.models';
import type { ScheduledEpicRunnerRefresh } from './scheduled-epics.service';

function makeSchedule(overrides: Partial<ScheduledEpic> = {}): ScheduledEpic {
  return {
    id: 'sched-1',
    projectId: 'proj-1',
    name: 'Daily Standup',
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    enabled: true,
    titleTemplate: 'Standup {{date}}',
    descriptionTemplate: null,
    templateStatusId: null,
    templateParentEpicId: null,
    templateAgentId: null,
    templateTags: [],
    allowOverlap: false,
    missedRunPolicy: 'skip',
    configVersion: 1,
    nextRunAt: '2026-06-01T09:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    lastError: null,
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
    ...overrides,
  };
}

function createMockStorage(): jest.Mocked<ScheduledEpicStorage> {
  return {
    createScheduledEpic: jest.fn(),
    getScheduledEpic: jest.fn(),
    listScheduledEpics: jest.fn(),
    updateScheduledEpic: jest.fn(),
    deleteScheduledEpic: jest.fn(),
    updateScheduledEpicRuntimeState: jest.fn(),
    listDueScheduledEpics: jest.fn(),
    createScheduledEpicRun: jest.fn(),
    getScheduledEpicRun: jest.fn(),
    listScheduledEpicRuns: jest.fn(),
    updateScheduledEpicRun: jest.fn(),
  };
}

describe('ScheduledEpicsService', () => {
  let service: ScheduledEpicsService;
  let storage: jest.Mocked<ScheduledEpicStorage>;
  let runnerRefresh: jest.Mocked<ScheduledEpicRunnerRefresh>;

  beforeEach(() => {
    storage = createMockStorage();
    runnerRefresh = { refreshScheduleWindow: jest.fn() };
    service = new ScheduledEpicsService(storage, runnerRefresh);
  });

  describe('runNow', () => {
    it('creates a manual run and notifies the runner', async () => {
      const schedule = makeSchedule();
      storage.getScheduledEpic.mockResolvedValue(schedule);

      const claimResult: ClaimRunResult = {
        claimed: true,
        run: {
          id: 'run-1',
          scheduleId: 'sched-1',
          plannedFor: '2026-05-16T12:00:00.000Z',
          source: 'manual',
          status: 'pending',
          createdEpicId: null,
          startedAt: null,
          finishedAt: null,
          errorMessage: null,
          createdAt: '2026-05-16T12:00:00.000Z',
          updatedAt: '2026-05-16T12:00:00.000Z',
        },
      };
      storage.createScheduledEpicRun.mockResolvedValue(claimResult);

      const result = await service.runNow('sched-1');

      expect(result.claimed).toBe(true);
      expect(result.run.source).toBe('manual');
      expect(storage.createScheduledEpicRun).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: 'sched-1',
          source: 'manual',
          status: 'pending',
        }),
      );
      expect(runnerRefresh.refreshScheduleWindow).toHaveBeenCalledTimes(1);
    });

    it('does not mutate nextRunAt on the schedule', async () => {
      const schedule = makeSchedule({ nextRunAt: '2026-06-01T09:00:00.000Z' });
      storage.getScheduledEpic.mockResolvedValue(schedule);
      storage.createScheduledEpicRun.mockResolvedValue({
        claimed: true,
        run: {
          id: 'run-1',
          scheduleId: 'sched-1',
          plannedFor: '2026-05-16T12:00:00.000Z',
          source: 'manual',
          status: 'pending',
          createdEpicId: null,
          startedAt: null,
          finishedAt: null,
          errorMessage: null,
          createdAt: '2026-05-16T12:00:00.000Z',
          updatedAt: '2026-05-16T12:00:00.000Z',
        },
      });

      await service.runNow('sched-1');

      expect(storage.updateScheduledEpic).not.toHaveBeenCalled();
      expect(storage.updateScheduledEpicRuntimeState).not.toHaveBeenCalled();
    });

    it('returns duplicate claim result when run already exists', async () => {
      const schedule = makeSchedule();
      storage.getScheduledEpic.mockResolvedValue(schedule);

      const duplicateResult: ClaimRunResult = {
        claimed: false,
        run: {
          id: 'existing-run',
          scheduleId: 'sched-1',
          plannedFor: '2026-05-16T12:00:00.000Z',
          source: 'scheduler',
          status: 'running',
          createdEpicId: null,
          startedAt: '2026-05-16T12:00:01.000Z',
          finishedAt: null,
          errorMessage: null,
          createdAt: '2026-05-16T12:00:00.000Z',
          updatedAt: '2026-05-16T12:00:01.000Z',
        },
      };
      storage.createScheduledEpicRun.mockResolvedValue(duplicateResult);

      const result = await service.runNow('sched-1');

      expect(result.claimed).toBe(false);
      expect(runnerRefresh.refreshScheduleWindow).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundError for nonexistent schedule', async () => {
      storage.getScheduledEpic.mockRejectedValue(new Error('NotFoundError'));

      await expect(service.runNow('nonexistent')).rejects.toThrow();
      expect(storage.createScheduledEpicRun).not.toHaveBeenCalled();
    });
  });

  describe('toggle', () => {
    it('notifies the runner after toggling', async () => {
      const schedule = makeSchedule({ enabled: true });
      storage.updateScheduledEpic.mockResolvedValue({
        ...schedule,
        enabled: false,
        configVersion: 2,
      });

      await service.toggle('sched-1', false, 1);

      expect(runnerRefresh.refreshScheduleWindow).toHaveBeenCalledTimes(1);
    });

    it('recomputes nextRunAt when re-enabling without one', async () => {
      const schedule = makeSchedule({ enabled: false, nextRunAt: null });
      storage.updateScheduledEpic.mockResolvedValue({
        ...schedule,
        enabled: true,
        configVersion: 2,
        nextRunAt: null,
      });
      storage.updateScheduledEpicRuntimeState.mockResolvedValue({
        ...schedule,
        enabled: true,
        configVersion: 2,
        nextRunAt: '2026-06-01T09:00:00.000Z',
      });

      const result = await service.toggle('sched-1', true, 1);

      expect(storage.updateScheduledEpicRuntimeState).toHaveBeenCalledWith(
        'sched-1',
        expect.objectContaining({ nextRunAt: expect.any(String) }),
      );
      expect(result.nextRunAt).toBe('2026-06-01T09:00:00.000Z');
    });
  });

  describe('update', () => {
    it('recomputes nextRunAt when cron expression changes', async () => {
      const schedule = makeSchedule();
      storage.getScheduledEpic.mockResolvedValue(schedule);
      storage.updateScheduledEpic.mockResolvedValue({
        ...schedule,
        cronExpression: '0 10 * * *',
        configVersion: 2,
      });
      storage.updateScheduledEpicRuntimeState.mockResolvedValue({
        ...schedule,
        cronExpression: '0 10 * * *',
        configVersion: 2,
        nextRunAt: '2026-06-01T10:00:00.000Z',
      });

      await service.update('sched-1', { cronExpression: '0 10 * * *' }, 1);

      expect(storage.updateScheduledEpicRuntimeState).toHaveBeenCalledWith(
        'sched-1',
        expect.objectContaining({ nextRunAt: expect.any(String) }),
      );
    });

    it('does not recompute nextRunAt when only name changes', async () => {
      const schedule = makeSchedule();
      storage.getScheduledEpic.mockResolvedValue(schedule);
      storage.updateScheduledEpic.mockResolvedValue({
        ...schedule,
        name: 'New Name',
        configVersion: 2,
      });

      await service.update('sched-1', { name: 'New Name' }, 1);

      expect(storage.updateScheduledEpicRuntimeState).not.toHaveBeenCalled();
    });

    it('notifies the runner after update', async () => {
      const schedule = makeSchedule();
      storage.getScheduledEpic.mockResolvedValue(schedule);
      storage.updateScheduledEpic.mockResolvedValue({ ...schedule, name: 'New', configVersion: 2 });

      await service.update('sched-1', { name: 'New' }, 1);

      expect(runnerRefresh.refreshScheduleWindow).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete', () => {
    it('notifies the runner after deletion', async () => {
      storage.getScheduledEpic.mockResolvedValue(makeSchedule());
      storage.deleteScheduledEpic.mockResolvedValue();

      await service.delete('sched-1');

      expect(storage.deleteScheduledEpic).toHaveBeenCalledWith('sched-1');
      expect(runnerRefresh.refreshScheduleWindow).toHaveBeenCalledTimes(1);
    });
  });

  describe('create', () => {
    it('notifies the runner after creation', async () => {
      const schedule = makeSchedule();
      storage.createScheduledEpic.mockResolvedValue(schedule);

      await service.create({
        projectId: '00000000-0000-0000-0000-000000000001',
        name: 'Daily Standup',
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        titleTemplate: 'Standup for today',
      });

      expect(runnerRefresh.refreshScheduleWindow).toHaveBeenCalledTimes(1);
    });
  });

  describe('runNow — cadence preservation (reviewer clarification)', () => {
    it('does not call updateScheduledEpic at all', async () => {
      storage.getScheduledEpic.mockResolvedValue(
        makeSchedule({ nextRunAt: '2026-06-01T09:00:00.000Z' }),
      );
      storage.createScheduledEpicRun.mockResolvedValue({
        claimed: true,
        run: {
          id: 'run-1',
          scheduleId: 'sched-1',
          plannedFor: new Date().toISOString(),
          source: 'manual',
          status: 'pending',
          createdEpicId: null,
          startedAt: null,
          finishedAt: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      await service.runNow('sched-1');

      expect(storage.updateScheduledEpic).not.toHaveBeenCalled();
      expect(storage.updateScheduledEpicRuntimeState).not.toHaveBeenCalled();
    });

    it('preserves the original nextRunAt value unchanged', async () => {
      const originalNextRunAt = '2026-06-01T09:00:00.000Z';
      storage.getScheduledEpic.mockResolvedValue(makeSchedule({ nextRunAt: originalNextRunAt }));
      storage.createScheduledEpicRun.mockResolvedValue({
        claimed: true,
        run: {
          id: 'run-1',
          scheduleId: 'sched-1',
          plannedFor: new Date().toISOString(),
          source: 'manual',
          status: 'pending',
          createdEpicId: null,
          startedAt: null,
          finishedAt: null,
          errorMessage: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      await service.runNow('sched-1');

      const allCalls = [
        ...storage.updateScheduledEpic.mock.calls,
        ...storage.updateScheduledEpicRuntimeState.mock.calls,
      ];
      const nextRunAtMutations = allCalls.filter(
        (call) => call[1] && 'nextRunAt' in (call[1] as Record<string, unknown>),
      );
      expect(nextRunAtMutations).toHaveLength(0);
    });
  });

  describe('runner refresh resilience', () => {
    it('does not throw when runner refresh fails', async () => {
      runnerRefresh.refreshScheduleWindow.mockImplementation(() => {
        throw new Error('Runner crashed');
      });
      storage.getScheduledEpic.mockResolvedValue(makeSchedule());
      storage.deleteScheduledEpic.mockResolvedValue();

      await expect(service.delete('sched-1')).resolves.toBeUndefined();
    });

    it('works without a runner injected', async () => {
      const serviceNoRunner = new ScheduledEpicsService(storage);
      storage.getScheduledEpic.mockResolvedValue(makeSchedule());
      storage.deleteScheduledEpic.mockResolvedValue();

      await expect(serviceNoRunner.delete('sched-1')).resolves.toBeUndefined();
    });
  });
});
