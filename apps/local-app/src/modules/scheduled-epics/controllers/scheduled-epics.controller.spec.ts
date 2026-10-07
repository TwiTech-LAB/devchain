import { BadRequestException } from '@nestjs/common';
import { ScheduledEpicsController } from './scheduled-epics.controller';
import type { ScheduledEpicsService } from '../services/scheduled-epics.service';
import type { ScheduledEpic } from '../../storage/models/domain.models';

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

  describe('POST /api/scheduled-epics', () => {
    it.each([
      { name: 'controller.create', invoke: () => controller.create({ name: '' }) },
      {
        name: 'controller.update',
        invoke: () => controller.update('sched-1', { name: 'Updated' }),
      },
      {
        name: 'controller.toggle',
        invoke: () => controller.toggle('sched-1', { configVersion: 1 }),
      },
    ])('maps invalid input in $name to bad request', async ({ invoke }) => {
      await expect(invoke()).rejects.toThrow(BadRequestException);
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
  });
});
