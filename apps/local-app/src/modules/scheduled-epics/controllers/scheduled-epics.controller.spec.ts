import { BadRequestException } from '@nestjs/common';
import { ScheduledEpicsController } from './scheduled-epics.controller';
import type { ScheduledEpicsService } from '../services/scheduled-epics.service';
import type { ScheduledEpic } from '../../storage/models/domain.models';
import { ConflictError } from '../../../common/errors/error-types';

function makeSchedule(overrides: Partial<ScheduledEpic> = {}): ScheduledEpic {
  return {
    id: 'sched-1',
    projectId: 'proj-1',
    name: 'Daily Standup',
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
    enabled: true,
    titleTemplate: 'Standup for today',
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

function createMockService(): jest.Mocked<
  Pick<
    ScheduledEpicsService,
    'list' | 'get' | 'create' | 'update' | 'delete' | 'toggle' | 'runNow' | 'listRuns'
  >
> {
  return {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    toggle: jest.fn(),
    runNow: jest.fn(),
    listRuns: jest.fn(),
  };
}

describe('ScheduledEpicsController', () => {
  let controller: ScheduledEpicsController;
  let service: ReturnType<typeof createMockService>;

  beforeEach(() => {
    service = createMockService();
    controller = new ScheduledEpicsController(service as unknown as ScheduledEpicsService);
  });

  describe('GET /api/scheduled-epics', () => {
    it('requires projectId query parameter', async () => {
      await expect(controller.list()).rejects.toThrow(BadRequestException);
    });

    it('returns a plain array of schedules (not paginated)', async () => {
      const schedule = makeSchedule();
      service.list.mockResolvedValue({
        items: [schedule],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await controller.list('proj-1');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('sched-1');
    });

    it('passes enabled filter as boolean', async () => {
      service.list.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });

      await controller.list('proj-1', 'true');
      expect(service.list).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ enabled: true }),
      );
    });
  });

  describe('GET /api/scheduled-epics/:id', () => {
    it('returns schedule by id', async () => {
      service.get.mockResolvedValue(makeSchedule());
      const result = await controller.get('sched-1');
      expect(result.id).toBe('sched-1');
    });
  });

  describe('POST /api/scheduled-epics', () => {
    it('creates a schedule with valid body', async () => {
      service.create.mockResolvedValue(makeSchedule());

      const result = await controller.create({
        projectId: '00000000-0000-0000-0000-000000000001',
        name: 'Daily',
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        titleTemplate: 'Standup for today',
      });

      expect(result.id).toBe('sched-1');
      expect(service.create).toHaveBeenCalled();
    });

    it('rejects invalid body', async () => {
      await expect(controller.create({ name: '' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('PUT /api/scheduled-epics/:id', () => {
    it('updates with configVersion', async () => {
      service.update.mockResolvedValue(makeSchedule({ name: 'Updated', configVersion: 2 }));

      const result = await controller.update('sched-1', {
        configVersion: 1,
        name: 'Updated',
      });

      expect(result.configVersion).toBe(2);
      expect(service.update).toHaveBeenCalledWith('sched-1', { name: 'Updated' }, 1);
    });

    it('rejects missing configVersion', async () => {
      await expect(controller.update('sched-1', { name: 'Updated' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('propagates 409 ConflictError on stale version', async () => {
      service.update.mockRejectedValue(
        new ConflictError('Version conflict', { expectedVersion: 1, currentVersion: 2 }),
      );

      await expect(
        controller.update('sched-1', { configVersion: 1, name: 'Stale' }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('DELETE /api/scheduled-epics/:id', () => {
    it('returns success on delete', async () => {
      service.delete.mockResolvedValue();
      const result = await controller.delete('sched-1');
      expect(result).toEqual({ success: true });
    });
  });

  describe('POST /api/scheduled-epics/:id/toggle', () => {
    it('toggles with configVersion', async () => {
      service.toggle.mockResolvedValue(makeSchedule({ enabled: false, configVersion: 2 }));

      const result = await controller.toggle('sched-1', {
        enabled: false,
        configVersion: 1,
      });

      expect(result.enabled).toBe(false);
      expect(service.toggle).toHaveBeenCalledWith('sched-1', false, 1);
    });

    it('rejects missing enabled field', async () => {
      await expect(controller.toggle('sched-1', { configVersion: 1 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects extra fields (strict)', async () => {
      await expect(
        controller.toggle('sched-1', { enabled: true, configVersion: 1, extra: 'bleed' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('POST /api/scheduled-epics/:id/run-now', () => {
    it('triggers manual run', async () => {
      service.runNow.mockResolvedValue({
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

      const result = await controller.runNow('sched-1');
      expect(result.claimed).toBe(true);
    });
  });

  describe('GET /api/scheduled-epics/:id/runs', () => {
    it('returns paginated runs with { items, total, limit, offset } shape', async () => {
      service.listRuns.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      const result = await controller.listRuns('sched-1');
      expect(result).toEqual(
        expect.objectContaining({
          items: expect.any(Array),
          total: expect.any(Number),
          limit: expect.any(Number),
          offset: expect.any(Number),
        }),
      );
    });

    it('passes status filter', async () => {
      service.listRuns.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });

      await controller.listRuns('sched-1', 'pending');
      expect(service.listRuns).toHaveBeenCalledWith(
        'sched-1',
        expect.objectContaining({ status: 'pending' }),
      );
    });
  });
});
