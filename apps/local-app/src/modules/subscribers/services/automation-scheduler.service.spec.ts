import {
  AutomationSchedulerService,
  compareScheduledTasks,
  type ScheduledTask,
} from './automation-scheduler.service';
import type { SubscriberExecutionResult } from './subscriber-executor.service';

describe('AutomationSchedulerService', () => {
  let service: AutomationSchedulerService;

  // Helper to create mock tasks
  const createMockTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
    taskId: `task-${Math.random().toString(36).substr(2, 9)}`,
    subscriberId: 'subscriber-1',
    eventId: 'event-1',
    runAt: Date.now(),
    priority: 0,
    position: 0,
    createdAt: new Date().toISOString(),
    agentId: undefined,
    groupKey: 'event:test.event',
    execute: jest.fn().mockResolvedValue({
      subscriberId: 'subscriber-1',
      subscriberName: 'Test Subscriber',
      actionType: 'send_agent_message',
      success: true,
      durationMs: 10,
    } as SubscriberExecutionResult),
    ...overrides,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    service = new AutomationSchedulerService();
  });

  afterEach(() => {
    if (service) {
      service.onModuleDestroy();
    }
    jest.useRealTimers();
  });

  describe('compareScheduledTasks', () => {
    it.each([
      {
        name: 'runAt ascending',
        a: { runAt: 1000, priority: 0, position: 0 },
        b: { runAt: 2000, priority: 0, position: 0 },
        sign: -1,
      },
      {
        name: 'priority descending',
        a: { runAt: 1000, priority: 10, position: 0 },
        b: { runAt: 1000, priority: 5, position: 0 },
        sign: -1,
      },
      {
        name: 'position ascending',
        a: { runAt: 1000, priority: 0, position: 1 },
        b: { runAt: 1000, priority: 0, position: 5 },
        sign: -1,
      },
      {
        name: 'creation ascending',
        a: { runAt: 1000, priority: 0, position: 0, createdAt: '2024-01-01T00:00:00Z' },
        b: { runAt: 1000, priority: 0, position: 0, createdAt: '2024-01-02T00:00:00Z' },
        sign: -1,
      },
      {
        name: 'equal sorting keys',
        a: { runAt: 1000, priority: 0, position: 0, createdAt: '2024-01-01T00:00:00Z' },
        b: { runAt: 1000, priority: 0, position: 0, createdAt: '2024-01-01T00:00:00Z' },
        sign: 0,
      },
    ])('compares $name', ({ a, b, sign }) => {
      const first = createMockTask(a),
        second = createMockTask(b);
      expect(Math.sign(compareScheduledTasks(first, second))).toBe(sign);
      expect(Math.sign(compareScheduledTasks(second, first))).toBe(sign === 0 ? 0 : -sign);
    });
  });

  describe('schedule', () => {
    it('should maintain sorted order when scheduling multiple tasks', () => {
      const now = Date.now();
      const task1 = createMockTask({ taskId: 'task-1', runAt: now + 5000 });
      const task2 = createMockTask({ taskId: 'task-2', runAt: now + 1000 });
      const task3 = createMockTask({ taskId: 'task-3', runAt: now + 3000 });

      service.schedule(task1);
      service.schedule(task2);
      service.schedule(task3);

      const queue = service._getQueue();
      expect(queue[0].taskId).toBe('task-2'); // runAt: now + 1000
      expect(queue[1].taskId).toBe('task-3'); // runAt: now + 3000
      expect(queue[2].taskId).toBe('task-1'); // runAt: now + 5000
    });
  });

  describe('cancel', () => {
    it('should remove task from queue', () => {
      const task = createMockTask({ taskId: 'cancel-me' });
      service.schedule(task);

      expect(service.getQueueLength()).toBe(1);
      expect(service.cancel('cancel-me')).toBe(true);
      expect(service.getQueueLength()).toBe(0);
    });

    it('should return false for non-existent task', () => {
      expect(service.cancel('non-existent')).toBe(false);
    });
  });

  describe('cancelBySubscriber', () => {
    it('should remove all tasks for a subscriber', () => {
      const task1 = createMockTask({ subscriberId: 'sub-1' });
      const task2 = createMockTask({ subscriberId: 'sub-1' });
      const task3 = createMockTask({ subscriberId: 'sub-2' });

      service.schedule(task1);
      service.schedule(task2);
      service.schedule(task3);

      expect(service.getQueueLength()).toBe(3);
      expect(service.cancelBySubscriber('sub-1')).toBe(2);
      expect(service.getQueueLength()).toBe(1);
    });
  });

  describe('task execution', () => {
    it('should execute task when due', async () => {
      const now = Date.now();
      const executeFn = jest.fn().mockResolvedValue({
        subscriberId: 'subscriber-1',
        subscriberName: 'Test',
        actionType: 'test',
        success: true,
        durationMs: 10,
      });
      const task = createMockTask({ runAt: now, execute: executeFn });

      service.schedule(task);

      // Advance timers to trigger execution
      jest.advanceTimersByTime(0);
      await Promise.resolve(); // Flush promises

      expect(executeFn).toHaveBeenCalled();
    });
  });

  describe('concurrency controls', () => {
    it.each([
      {
        name: 'global',
        limits: { maxGlobal: 2, maxPerAgent: 10, maxPerGroup: 10 },
        sameAgent: false,
        sameGroup: false,
        blocked: 'task-3',
        started: ['task-1', 'task-2'],
      },
      {
        name: 'per-agent',
        limits: { maxGlobal: 10, maxPerAgent: 1, maxPerGroup: 10 },
        sameAgent: true,
        sameGroup: false,
        blocked: 'task-2',
        started: ['task-1', 'task-3'],
      },
      {
        name: 'per-group',
        limits: { maxGlobal: 10, maxPerAgent: 10, maxPerGroup: 1 },
        sameAgent: false,
        sameGroup: true,
        blocked: 'task-2',
        started: ['task-1', 'task-3'],
      },
    ])(
      'holds queued work until a $name concurrency slot is released',
      async ({ limits, sameAgent, sameGroup, blocked, started }) => {
        service.setConcurrency(limits);
        const startedTasks: string[] = [];
        const releases = new Map<string, (result: SubscriberExecutionResult) => void>();
        for (let i = 1; i <= 3; i++) {
          const id = 'task-' + i;
          const pending = new Promise<SubscriberExecutionResult>((resolve) =>
            releases.set(id, resolve),
          );
          service.schedule(
            createMockTask({
              taskId: id,
              runAt: Date.now(),
              agentId: sameAgent && i < 3 ? 'shared-agent' : 'agent-' + i,
              groupKey: sameGroup && i < 3 ? 'shared-group' : 'group-' + i,
              execute: jest.fn(() => {
                startedTasks.push(id);
                return pending;
              }),
            }),
          );
        }
        await jest.advanceTimersByTimeAsync(100);
        expect(startedTasks).toEqual(started);
        expect(service.getExecutingCount()).toBe(2);
        expect(service.getQueueLength()).toBe(1);
        expect(service.isExecuting(blocked)).toBe(false);
        const result: SubscriberExecutionResult = {
          subscriberId: 'sub-1',
          subscriberName: 'Test',
          actionType: 'test',
          success: true,
          durationMs: 10,
        };
        releases.get('task-1')!(result);
        await jest.advanceTimersByTimeAsync(50);
        expect(startedTasks).toEqual([...started, blocked]);
        expect(service.getExecutingCount()).toBe(2);
        expect(service.getQueueLength()).toBe(0);
        for (const release of releases.values()) release(result);
        await jest.advanceTimersByTimeAsync(0);
        expect(service.getExecutingCount()).toBe(0);
      },
    );
  });

  describe('shutdown', () => {
    it('should clear queue and timers on destroy', () => {
      const task = createMockTask({ runAt: Date.now() + 10000 });
      service.schedule(task);

      expect(service.getQueueLength()).toBe(1);
      expect(service._hasWakeTimer()).toBe(true);

      service.onModuleDestroy();

      expect(service.getQueueLength()).toBe(0);
      expect(service._hasWakeTimer()).toBe(false);
    });

    it('should not schedule new tasks after shutdown', () => {
      service.onModuleDestroy();

      const task = createMockTask();
      service.schedule(task);

      expect(service.getQueueLength()).toBe(0);
    });
  });

  describe('priority ordering integration', () => {
    it('should execute higher priority tasks first when runAt is equal', async () => {
      const now = Date.now();
      const executionOrder: string[] = [];

      const lowPriority = createMockTask({
        taskId: 'low',
        runAt: now,
        priority: -10,
        groupKey: 'group-low',
        execute: jest.fn().mockImplementation(async () => {
          executionOrder.push('low');
          return {
            subscriberId: 'sub-1',
            subscriberName: 'Test',
            actionType: 'test',
            success: true,
            durationMs: 10,
          };
        }),
      });

      const highPriority = createMockTask({
        taskId: 'high',
        runAt: now,
        priority: 10,
        groupKey: 'group-high',
        execute: jest.fn().mockImplementation(async () => {
          executionOrder.push('high');
          return {
            subscriberId: 'sub-1',
            subscriberName: 'Test',
            actionType: 'test',
            success: true,
            durationMs: 10,
          };
        }),
      });

      // Schedule low priority first
      service.schedule(lowPriority);
      service.schedule(highPriority);

      // Set high concurrency to let both run
      service.setConcurrency({ maxGlobal: 10, maxPerAgent: 10, maxPerGroup: 10 });

      jest.advanceTimersByTime(0);
      await Promise.resolve();

      // High priority should be first in execution order
      expect(executionOrder[0]).toBe('high');
    });
  });
});
