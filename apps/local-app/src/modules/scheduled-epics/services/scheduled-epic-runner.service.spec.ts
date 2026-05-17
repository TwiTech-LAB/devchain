import { ScheduledEpicRunnerService } from './scheduled-epic-runner.service';
import type { StorageService, ClaimRunResult } from '../../storage/interfaces/storage.interface';
import type {
  ScheduledEpic,
  ScheduledEpicRun,
  Epic,
  Project,
} from '../../storage/models/domain.models';
import type { EpicsService } from '../../epics/services/epics.service';

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

function makeRun(overrides: Partial<ScheduledEpicRun> = {}): ScheduledEpicRun {
  return {
    id: 'run-1',
    scheduleId: 'sched-1',
    plannedFor: '2026-06-01T09:00:00.000Z',
    source: 'scheduler',
    status: 'pending',
    createdEpicId: null,
    startedAt: null,
    finishedAt: null,
    errorMessage: null,
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  };
}

function makeEpic(): Epic {
  return {
    id: 'epic-1',
    projectId: 'proj-1',
    title: 'Generated',
    description: null,
    statusId: 'status-1',
    parentId: null,
    agentId: null,
    version: 1,
    data: null,
    skillsRequired: null,
    tags: [],
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
  };
}

function claimOk(run: ScheduledEpicRun): ClaimRunResult {
  return { claimed: true, run };
}

function claimDuplicate(run: ScheduledEpicRun): ClaimRunResult {
  return { claimed: false, run };
}

function createMockStorage(): jest.Mocked<
  Pick<
    StorageService,
    | 'listProjects'
    | 'listDueScheduledEpics'
    | 'listScheduledEpics'
    | 'getScheduledEpic'
    | 'createScheduledEpicRun'
    | 'getScheduledEpicRun'
    | 'listScheduledEpicRuns'
    | 'updateScheduledEpicRun'
    | 'updateScheduledEpicRuntimeState'
    | 'claimScheduledEpicRun'
  >
> {
  return {
    listProjects: jest.fn(),
    listDueScheduledEpics: jest.fn(),
    listScheduledEpics: jest.fn(),
    getScheduledEpic: jest.fn(),
    createScheduledEpicRun: jest.fn(),
    getScheduledEpicRun: jest.fn(),
    listScheduledEpicRuns: jest.fn(),
    updateScheduledEpicRun: jest.fn(),
    updateScheduledEpicRuntimeState: jest.fn(),
    claimScheduledEpicRun: jest.fn(),
  };
}

function createMockEpicsService(): jest.Mocked<Pick<EpicsService, 'createEpicForProject'>> {
  return {
    createEpicForProject: jest.fn(),
  };
}

type RunnerInternals = {
  processSchedule(schedule: ScheduledEpic, now: string): Promise<void>;
  claimAndExecute(schedule: ScheduledEpic, plannedFor: string, source: string): Promise<void>;
  scanProject(projectId: string): Promise<void>;
  recoverStaleRuns(projectId: string, now: string): Promise<void>;
  computeMissedSlots(schedule: ScheduledEpic, now: string): string[];
};

describe('ScheduledEpicRunnerService', () => {
  let runner: ScheduledEpicRunnerService;
  let internals: RunnerInternals;
  let storage: ReturnType<typeof createMockStorage>;
  let epicsService: ReturnType<typeof createMockEpicsService>;

  beforeEach(() => {
    storage = createMockStorage();
    epicsService = createMockEpicsService();
    runner = new ScheduledEpicRunnerService(
      storage as unknown as StorageService,
      epicsService as unknown as EpicsService,
    );
    internals = runner as unknown as RunnerInternals;
    storage.updateScheduledEpicRun.mockImplementation(async (_id, data) =>
      makeRun({ ...data } as Partial<ScheduledEpicRun>),
    );
    storage.updateScheduledEpicRuntimeState.mockImplementation(async (_id, data) =>
      makeSchedule({ ...data } as Partial<ScheduledEpic>),
    );
    storage.listScheduledEpicRuns.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    storage.claimScheduledEpicRun.mockImplementation(async (runId) =>
      claimOk(makeRun({ id: runId, status: 'running' })),
    );
  });

  afterEach(() => {
    runner.onModuleDestroy();
  });

  describe('executeRun — shared claim path', () => {
    it('executes a pending run via EpicsService.createEpicForProject', async () => {
      const schedule = makeSchedule();
      const run = makeRun();
      storage.getScheduledEpic.mockResolvedValue(schedule);
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await runner.executeRun(run);

      expect(epicsService.createEpicForProject).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ title: expect.any(String) }),
      );
      expect(storage.updateScheduledEpicRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'completed', createdEpicId: 'epic-1' }),
      );
    });

    it('executes manual runs even when schedule is disabled', async () => {
      const schedule = makeSchedule({ enabled: false });
      const run = makeRun({ source: 'manual' });
      storage.getScheduledEpic.mockResolvedValue(schedule);
      storage.claimScheduledEpicRun.mockResolvedValue(
        claimOk(makeRun({ id: run.id, source: 'manual', status: 'running' })),
      );
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await runner.executeRun(run);

      expect(epicsService.createEpicForProject).toHaveBeenCalled();
    });

    it('skips scheduler runs when schedule is disabled', async () => {
      const schedule = makeSchedule({ enabled: false });
      const run = makeRun({ source: 'scheduler' });
      storage.getScheduledEpic.mockResolvedValue(schedule);
      storage.claimScheduledEpicRun.mockResolvedValue(
        claimOk(makeRun({ id: run.id, source: 'scheduler', status: 'running' })),
      );

      await runner.executeRun(run);

      expect(epicsService.createEpicForProject).not.toHaveBeenCalled();
      expect(storage.updateScheduledEpicRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'skipped' }),
      );
    });

    it('records failure when execution throws', async () => {
      const schedule = makeSchedule();
      const run = makeRun();
      storage.getScheduledEpic.mockResolvedValue(schedule);
      epicsService.createEpicForProject.mockRejectedValue(new Error('DB down'));

      await runner.executeRun(run);

      expect(storage.updateScheduledEpicRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'failed', errorMessage: 'DB down' }),
      );
      expect(storage.updateScheduledEpicRuntimeState).toHaveBeenCalledWith(
        'sched-1',
        expect.objectContaining({ lastRunStatus: 'failed', lastError: 'DB down' }),
      );
    });

    it('marks run failed when schedule not found', async () => {
      const run = makeRun();
      storage.getScheduledEpic.mockRejectedValue(new Error('NotFound'));

      await runner.executeRun(run);

      expect(storage.updateScheduledEpicRun).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ status: 'failed', errorMessage: 'Schedule not found' }),
      );
    });

    it('does not execute non-pending runs', async () => {
      const run = makeRun({ status: 'running' });

      await runner.executeRun(run);

      expect(storage.getScheduledEpic).not.toHaveBeenCalled();
    });
  });

  describe('catch-up — missedRunPolicy', () => {
    it('skip policy: advances nextRunAt without creating runs for missed slots', async () => {
      const now = new Date();
      const schedule = makeSchedule({
        missedRunPolicy: 'skip',
        cronExpression: '* * * * *',
        nextRunAt: new Date(now.getTime() - 10 * 60 * 1_000).toISOString(),
      });

      storage.createScheduledEpicRun.mockResolvedValue(claimOk(makeRun()));
      storage.getScheduledEpic.mockResolvedValue(schedule);
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await internals.processSchedule(schedule, now.toISOString());

      expect(storage.createScheduledEpicRun).not.toHaveBeenCalled();
      expect(storage.updateScheduledEpicRuntimeState).toHaveBeenCalledWith(
        'sched-1',
        expect.objectContaining({ nextRunAt: expect.any(String) }),
      );
    });

    it('run_once policy: claims only the latest missed slot', async () => {
      const now = new Date();
      const schedule = makeSchedule({
        missedRunPolicy: 'run_once',
        cronExpression: '* * * * *',
        nextRunAt: new Date(now.getTime() - 10 * 60 * 1_000).toISOString(),
      });

      storage.createScheduledEpicRun.mockResolvedValue(claimOk(makeRun()));
      storage.getScheduledEpic.mockResolvedValue(schedule);
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await internals.processSchedule(schedule, now.toISOString());

      expect(storage.createScheduledEpicRun).toHaveBeenCalledTimes(1);
    });

    it('run_all policy: claims each missed slot within horizon', async () => {
      const now = new Date();
      const schedule = makeSchedule({
        missedRunPolicy: 'run_all',
        cronExpression: '0 * * * *',
        nextRunAt: new Date(now.getTime() - 5 * 60 * 60 * 1_000).toISOString(),
      });

      storage.createScheduledEpicRun.mockResolvedValue(claimOk(makeRun()));
      storage.getScheduledEpic.mockResolvedValue(schedule);
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await internals.processSchedule(schedule, now.toISOString());

      expect(storage.createScheduledEpicRun.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('atomic claim behavior', () => {
    it('uses claimScheduledEpicRun for atomic pending-to-running transition', async () => {
      const schedule = makeSchedule();
      storage.createScheduledEpicRun.mockResolvedValue(claimOk(makeRun()));
      storage.getScheduledEpic.mockResolvedValue(schedule);
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await internals.claimAndExecute(schedule, schedule.nextRunAt!, 'scheduler');

      expect(storage.claimScheduledEpicRun).toHaveBeenCalledWith('run-1');
      expect(epicsService.createEpicForProject).toHaveBeenCalled();
    });

    it('retries atomic claim once when first attempt returns pending', async () => {
      const schedule = makeSchedule();
      const pendingRun = makeRun({ status: 'pending' });
      storage.createScheduledEpicRun.mockResolvedValue(claimDuplicate(pendingRun));
      storage.claimScheduledEpicRun
        .mockResolvedValueOnce(claimDuplicate(pendingRun))
        .mockResolvedValueOnce(claimOk(makeRun({ status: 'running' })));
      storage.getScheduledEpic.mockResolvedValue(schedule);
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await internals.claimAndExecute(schedule, schedule.nextRunAt!, 'scheduler');

      expect(storage.claimScheduledEpicRun).toHaveBeenCalledTimes(2);
      expect(epicsService.createEpicForProject).toHaveBeenCalled();
    });

    it('does not execute when claim returns already-running', async () => {
      const schedule = makeSchedule();
      const runningRun = makeRun({ status: 'running' });
      storage.createScheduledEpicRun.mockResolvedValue(claimDuplicate(runningRun));
      storage.claimScheduledEpicRun.mockResolvedValue(claimDuplicate(runningRun));
      storage.getScheduledEpic.mockResolvedValue(schedule);

      await internals.claimAndExecute(schedule, schedule.nextRunAt!, 'scheduler');

      expect(epicsService.createEpicForProject).not.toHaveBeenCalled();
    });

    it('does not execute when claim returns completed', async () => {
      const schedule = makeSchedule();
      const completedRun = makeRun({ status: 'completed' });
      storage.createScheduledEpicRun.mockResolvedValue(claimDuplicate(completedRun));
      storage.claimScheduledEpicRun.mockResolvedValue(claimDuplicate(completedRun));
      storage.getScheduledEpic.mockResolvedValue(schedule);

      await internals.claimAndExecute(schedule, schedule.nextRunAt!, 'scheduler');

      expect(epicsService.createEpicForProject).not.toHaveBeenCalled();
    });

    it('losing claim path does not call EpicsService.createEpicForProject', async () => {
      const schedule = makeSchedule();
      const runningRun = makeRun({ status: 'running' });
      storage.createScheduledEpicRun.mockResolvedValue(claimOk(makeRun()));
      storage.claimScheduledEpicRun.mockResolvedValue(claimDuplicate(runningRun));
      storage.getScheduledEpic.mockResolvedValue(schedule);

      await internals.claimAndExecute(schedule, schedule.nextRunAt!, 'scheduler');

      expect(epicsService.createEpicForProject).not.toHaveBeenCalled();
    });
  });

  describe('per-schedule failure isolation', () => {
    it('continues processing other schedules when one fails', async () => {
      const schedule1 = makeSchedule({ id: 'sched-1', nextRunAt: '2026-06-01T09:00:00.000Z' });
      const schedule2 = makeSchedule({ id: 'sched-2', nextRunAt: '2026-06-01T09:00:00.000Z' });

      storage.listProjects.mockResolvedValue({
        items: [{ id: 'proj-1' } as Project],
        total: 1,
        limit: 500,
        offset: 0,
      });
      storage.listDueScheduledEpics.mockResolvedValue([schedule1, schedule2]);
      storage.listScheduledEpics.mockResolvedValue({
        items: [schedule1, schedule2],
        total: 2,
        limit: 500,
        offset: 0,
      });

      let callCount = 0;
      storage.createScheduledEpicRun.mockImplementation(async (data) => {
        callCount++;
        if (callCount === 1) throw new Error('First schedule explodes');
        return claimOk(makeRun({ id: `run-${callCount}`, scheduleId: data.scheduleId }));
      });
      storage.getScheduledEpic.mockResolvedValue(schedule2);
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await internals.scanProject('proj-1');

      expect(storage.createScheduledEpicRun).toHaveBeenCalledTimes(2);
    });
  });

  describe('stale running recovery', () => {
    it('marks stale running runs as failed with STALE_RUNNING_RECOVERED', async () => {
      const schedule = makeSchedule();
      const staleRun = makeRun({
        status: 'running',
        startedAt: new Date(Date.now() - 20 * 60 * 1_000).toISOString(),
      });

      storage.listScheduledEpics.mockResolvedValue({
        items: [schedule],
        total: 1,
        limit: 500,
        offset: 0,
      });
      storage.listScheduledEpicRuns.mockResolvedValue({
        items: [staleRun],
        total: 1,
        limit: 50,
        offset: 0,
      });

      await internals.recoverStaleRuns('proj-1', new Date().toISOString());

      expect(storage.updateScheduledEpicRun).toHaveBeenCalledWith(
        staleRun.id,
        expect.objectContaining({
          status: 'failed',
          errorMessage: 'STALE_RUNNING_RECOVERED',
        }),
      );
      expect(storage.updateScheduledEpicRuntimeState).toHaveBeenCalledWith(
        schedule.id,
        expect.objectContaining({
          lastRunStatus: 'failed',
          lastError: 'STALE_RUNNING_RECOVERED',
        }),
      );
    });

    it('does not recover recently started runs', async () => {
      const schedule = makeSchedule();
      const recentRun = makeRun({
        status: 'running',
        startedAt: new Date(Date.now() - 5 * 60 * 1_000).toISOString(),
      });

      storage.listScheduledEpics.mockResolvedValue({
        items: [schedule],
        total: 1,
        limit: 500,
        offset: 0,
      });
      storage.listScheduledEpicRuns.mockResolvedValue({
        items: [recentRun],
        total: 1,
        limit: 50,
        offset: 0,
      });

      await internals.recoverStaleRuns('proj-1', new Date().toISOString());

      expect(storage.updateScheduledEpicRun).not.toHaveBeenCalled();
    });
  });

  describe('catch-up horizon and count caps', () => {
    it('run_all processes at most 10 slots per scan and preserves backlog', async () => {
      const now = new Date();
      const schedule = makeSchedule({
        missedRunPolicy: 'run_all',
        cronExpression: '* * * * *',
        nextRunAt: new Date(now.getTime() - 60 * 60 * 1_000).toISOString(),
      });

      storage.createScheduledEpicRun.mockResolvedValue(claimOk(makeRun()));
      storage.getScheduledEpic.mockResolvedValue(schedule);
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await internals.processSchedule(schedule, now.toISOString());

      expect(storage.createScheduledEpicRun.mock.calls.length).toBeLessThanOrEqual(10);
      const runtimeCalls = storage.updateScheduledEpicRuntimeState.mock.calls;
      const lastCall = runtimeCalls[runtimeCalls.length - 1];
      const nextRunAt = (lastCall?.[1] as Record<string, unknown>)?.nextRunAt as string;
      expect(new Date(nextRunAt).getTime()).toBeLessThan(now.getTime());
    });

    it('excludes slots older than 24h', () => {
      const schedule = makeSchedule({
        cronExpression: '0 9 * * *',
        nextRunAt: new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString(),
      });

      const slots = internals.computeMissedSlots(schedule, new Date().toISOString());
      const horizonCutoff = Date.now() - 24 * 60 * 60 * 1_000;

      for (const slot of slots) {
        expect(new Date(slot).getTime()).toBeGreaterThanOrEqual(horizonCutoff);
      }
    });

    it('returns single slot when schedule is just due', () => {
      const now = new Date();
      const schedule = makeSchedule({
        cronExpression: '0 9 * * *',
        nextRunAt: new Date(now.getTime() - 30_000).toISOString(),
      });

      const slots = internals.computeMissedSlots(schedule, now.toISOString());

      expect(slots.length).toBe(1);
    });
  });

  describe('disable-during-in-flight', () => {
    it('allows an already-claimed manual run to execute even after disable', async () => {
      const schedule = makeSchedule({ enabled: false });
      const run = makeRun({ source: 'manual', status: 'pending' });
      storage.getScheduledEpic.mockResolvedValue(schedule);
      storage.claimScheduledEpicRun.mockResolvedValue(
        claimOk(makeRun({ id: run.id, source: 'manual', status: 'running' })),
      );
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await runner.executeRun(run);

      expect(epicsService.createEpicForProject).toHaveBeenCalled();
      expect(storage.updateScheduledEpicRun).toHaveBeenCalledWith(
        run.id,
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('skips new scheduler runs after schedule is disabled', async () => {
      const schedule = makeSchedule({ enabled: false });
      const run = makeRun({ source: 'scheduler', status: 'pending' });
      storage.getScheduledEpic.mockResolvedValue(schedule);
      storage.claimScheduledEpicRun.mockResolvedValue(
        claimOk(makeRun({ id: run.id, source: 'scheduler', status: 'running' })),
      );

      await runner.executeRun(run);

      expect(epicsService.createEpicForProject).not.toHaveBeenCalled();
      expect(storage.updateScheduledEpicRun).toHaveBeenCalledWith(
        run.id,
        expect.objectContaining({ status: 'skipped', errorMessage: 'Schedule disabled' }),
      );
    });
  });

  describe('template render failure', () => {
    it('records failure when title template render throws', async () => {
      const schedule = makeSchedule({ titleTemplate: '{{#if}}broken{{/wrong}}' });
      const run = makeRun();
      storage.getScheduledEpic.mockResolvedValue(schedule);

      await runner.executeRun(run);

      expect(storage.updateScheduledEpicRun).toHaveBeenCalledWith(
        run.id,
        expect.objectContaining({ status: 'failed', errorMessage: expect.any(String) }),
      );
      expect(epicsService.createEpicForProject).not.toHaveBeenCalled();
    });
  });

  describe('regression: race semantics', () => {
    it('duplicate pending run requires winning atomic claim before epic creation', async () => {
      const schedule = makeSchedule();
      const pendingRun = makeRun({ status: 'pending' });

      storage.createScheduledEpicRun.mockResolvedValue(claimDuplicate(pendingRun));
      storage.claimScheduledEpicRun.mockResolvedValue(
        claimDuplicate(makeRun({ status: 'running' })),
      );
      storage.getScheduledEpic.mockResolvedValue(schedule);

      await internals.claimAndExecute(schedule, schedule.nextRunAt!, 'scheduler');

      expect(storage.claimScheduledEpicRun).toHaveBeenCalled();
      expect(epicsService.createEpicForProject).not.toHaveBeenCalled();
    });

    it('overlapping drain and scheduler claim on same run: only winner creates epic', async () => {
      const schedule = makeSchedule();
      const run = makeRun({ status: 'pending' });

      let claimCallCount = 0;
      storage.claimScheduledEpicRun.mockImplementation(async () => {
        claimCallCount++;
        if (claimCallCount === 1) {
          return claimOk(makeRun({ id: run.id, status: 'running' }));
        }
        return claimDuplicate(makeRun({ id: run.id, status: 'running' }));
      });
      storage.getScheduledEpic.mockResolvedValue(schedule);
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await runner.executeRun(run);
      await runner.executeRun(run);

      expect(epicsService.createEpicForProject).toHaveBeenCalledTimes(1);
    });

    it('capped catch-up continues backlog across simulated scans', async () => {
      const now = new Date();
      const schedule = makeSchedule({
        missedRunPolicy: 'run_all',
        cronExpression: '* * * * *',
        nextRunAt: new Date(now.getTime() - 30 * 60 * 1_000).toISOString(),
      });

      storage.createScheduledEpicRun.mockResolvedValue(claimOk(makeRun()));
      storage.getScheduledEpic.mockResolvedValue(schedule);
      epicsService.createEpicForProject.mockResolvedValue(makeEpic());

      await internals.processSchedule(schedule, now.toISOString());

      const scan1Claims = storage.createScheduledEpicRun.mock.calls.length;
      expect(scan1Claims).toBeLessThanOrEqual(10);

      const runtimeCalls = storage.updateScheduledEpicRuntimeState.mock.calls;
      const lastRuntimeCall = runtimeCalls[runtimeCalls.length - 1];
      const preservedNextRunAt = (lastRuntimeCall?.[1] as Record<string, unknown>)
        ?.nextRunAt as string;

      expect(preservedNextRunAt).toBeDefined();
      expect(new Date(preservedNextRunAt).getTime()).toBeLessThan(now.getTime());

      storage.createScheduledEpicRun.mockClear();
      storage.updateScheduledEpicRuntimeState.mockImplementation(async (_id, data) =>
        makeSchedule({ ...data } as Partial<ScheduledEpic>),
      );

      const scan2Schedule = makeSchedule({
        ...schedule,
        nextRunAt: preservedNextRunAt,
      });

      await internals.processSchedule(scan2Schedule, now.toISOString());

      const scan2Claims = storage.createScheduledEpicRun.mock.calls.length;
      expect(scan2Claims).toBeGreaterThan(0);
      expect(scan1Claims + scan2Claims).toBeGreaterThan(10);
    });
  });
});
