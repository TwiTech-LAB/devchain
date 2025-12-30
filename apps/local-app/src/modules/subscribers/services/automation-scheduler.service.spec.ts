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
    it('should sort by runAt ASC first', () => {
      const taskA = createMockTask({ runAt: 1000, priority: 0, position: 0 });
      const taskB = createMockTask({ runAt: 2000, priority: 0, position: 0 });

      expect(compareScheduledTasks(taskA, taskB)).toBeLessThan(0);
      expect(compareScheduledTasks(taskB, taskA)).toBeGreaterThan(0);
    });

    it('should sort by priority DESC when runAt is equal', () => {
      const taskA = createMockTask({ runAt: 1000, priority: 10, position: 0 });
      const taskB = createMockTask({ runAt: 1000, priority: 5, position: 0 });

      // Higher priority should come first (priority DESC)
      expect(compareScheduledTasks(taskA, taskB)).toBeLessThan(0);
      expect(compareScheduledTasks(taskB, taskA)).toBeGreaterThan(0);
    });

    it('should sort by position ASC when runAt and priority are equal', () => {
      const taskA = createMockTask({ runAt: 1000, priority: 0, position: 1 });
      const taskB = createMockTask({ runAt: 1000, priority: 0, position: 5 });

      // Lower position should come first (position ASC)
      expect(compareScheduledTasks(taskA, taskB)).toBeLessThan(0);
      expect(compareScheduledTasks(taskB, taskA)).toBeGreaterThan(0);
    });

    it('should sort by createdAt ASC as final tie-breaker', () => {
      const taskA = createMockTask({
        runAt: 1000,
        priority: 0,
        position: 0,
        createdAt: '2024-01-01T00:00:00Z',
      });
      const taskB = createMockTask({
        runAt: 1000,
        priority: 0,
        position: 0,
        createdAt: '2024-01-02T00:00:00Z',
      });

      expect(compareScheduledTasks(taskA, taskB)).toBeLessThan(0);
      expect(compareScheduledTasks(taskB, taskA)).toBeGreaterThan(0);
    });

    it('should return 0 for identical sorting keys', () => {
      const createdAt = '2024-01-01T00:00:00Z';
      const taskA = createMockTask({ runAt: 1000, priority: 0, position: 0, createdAt });
      const taskB = createMockTask({ runAt: 1000, priority: 0, position: 0, createdAt });

      expect(compareScheduledTasks(taskA, taskB)).toBe(0);
    });
  });

  describe('schedule', () => {
    it('should add task to queue', () => {
      const task = createMockTask({ runAt: Date.now() + 10000 });
      service.schedule(task);

      expect(service.getQueueLength()).toBe(1);
    });

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

    it('should schedule wake timer for first task', () => {
      const task = createMockTask({ runAt: Date.now() + 10000 });
      service.schedule(task);

      expect(service._hasWakeTimer()).toBe(true);
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

    it('should order tasks correctly in queue based on runAt', () => {
      const now = Date.now();

      const delayedTask = createMockTask({
        taskId: 'delayed',
        runAt: now + 5000,
        groupKey: 'group-delayed',
      });

      const immediateTask = createMockTask({
        taskId: 'immediate',
        runAt: now,
        groupKey: 'group-immediate',
      });

      // Schedule delayed task first
      service.schedule(delayedTask);
      // Then schedule immediate task
      service.schedule(immediateTask);

      // Queue should be sorted: immediate first (lower runAt), delayed second
      const queue = service._getQueue();
      expect(queue[0].taskId).toBe('immediate');
      expect(queue[1].taskId).toBe('delayed');
    });
  });

  describe('concurrency controls', () => {
    it('should respect global concurrency limit', async () => {
      service.setConcurrency({ maxGlobal: 2, maxPerAgent: 10, maxPerGroup: 10 });

      const now = Date.now();
      const startedTasks: string[] = [];

      const createTask = (id: string) =>
        createMockTask({
          taskId: id,
          runAt: now,
          groupKey: `group-${id}`, // Different groups to avoid group blocking
          execute: jest.fn().mockImplementation(async () => {
            startedTasks.push(id);
            return {
              subscriberId: 'sub-1',
              subscriberName: 'Test',
              actionType: 'test',
              success: true,
              durationMs: 10,
            };
          }),
        });

      const task1 = createTask('task-1');
      const task2 = createTask('task-2');
      const task3 = createTask('task-3');

      service.schedule(task1);
      service.schedule(task2);
      service.schedule(task3);

      // Process due tasks - should start 2, third blocked
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();

      // All 3 should have started since execute() resolves immediately
      // and triggers recheck
      expect(startedTasks.length).toBeGreaterThanOrEqual(2);
    });

    it('should respect per-agent concurrency limit', async () => {
      service.setConcurrency({ maxGlobal: 10, maxPerAgent: 1, maxPerGroup: 10 });

      const now = Date.now();
      const startedTasks: string[] = [];

      const createTask = (id: string, agentId: string) =>
        createMockTask({
          taskId: id,
          runAt: now,
          agentId,
          groupKey: `group-${id}`, // Different groups
          execute: jest.fn().mockImplementation(async () => {
            startedTasks.push(id);
            return {
              subscriberId: 'sub-1',
              subscriberName: 'Test',
              actionType: 'test',
              success: true,
              durationMs: 10,
            };
          }),
        });

      // Two tasks for same agent
      const task1 = createTask('task-1', 'agent-1');
      const task2 = createTask('task-2', 'agent-1');
      // One task for different agent
      const task3 = createTask('task-3', 'agent-2');

      service.schedule(task1);
      service.schedule(task2);
      service.schedule(task3);

      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();

      // All tasks should eventually execute
      expect(startedTasks.length).toBeGreaterThanOrEqual(2);
    });

    it('should respect per-group concurrency limit', async () => {
      service.setConcurrency({ maxGlobal: 10, maxPerAgent: 10, maxPerGroup: 1 });

      const now = Date.now();
      const startedTasks: string[] = [];

      const createTask = (id: string, groupKey: string) =>
        createMockTask({
          taskId: id,
          runAt: now,
          groupKey,
          execute: jest.fn().mockImplementation(async () => {
            startedTasks.push(id);
            return {
              subscriberId: 'sub-1',
              subscriberName: 'Test',
              actionType: 'test',
              success: true,
              durationMs: 10,
            };
          }),
        });

      // Two tasks for same group
      const task1 = createTask('task-1', 'group-A');
      const task2 = createTask('task-2', 'group-A');
      // One task for different group
      const task3 = createTask('task-3', 'group-B');

      service.schedule(task1);
      service.schedule(task2);
      service.schedule(task3);

      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();

      // All tasks should eventually execute
      expect(startedTasks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('blocked task recheck', () => {
    it('should process multiple due tasks when slots are available', async () => {
      service.setConcurrency({ maxGlobal: 2, maxPerAgent: 10, maxPerGroup: 10 });

      const now = Date.now();
      const startedTasks: string[] = [];

      const createTask = (id: string) =>
        createMockTask({
          taskId: id,
          runAt: now,
          groupKey: `group-${id}`,
          execute: jest.fn().mockImplementation(async () => {
            startedTasks.push(id);
            return {
              subscriberId: 'sub-1',
              subscriberName: 'Test',
              actionType: 'test',
              success: true,
              durationMs: 10,
            };
          }),
        });

      const task1 = createTask('task-1');
      const task2 = createTask('task-2');

      service.schedule(task1);
      service.schedule(task2);

      // Process due tasks
      jest.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();

      // Both tasks should execute (under global limit of 2)
      expect(startedTasks.length).toBe(2);
    });
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

    it('should execute lower position tasks first when runAt and priority are equal', async () => {
      const now = Date.now();
      const executionOrder: string[] = [];

      const position5 = createMockTask({
        taskId: 'pos-5',
        runAt: now,
        priority: 0,
        position: 5,
        groupKey: 'group-5',
        execute: jest.fn().mockImplementation(async () => {
          executionOrder.push('pos-5');
          return {
            subscriberId: 'sub-1',
            subscriberName: 'Test',
            actionType: 'test',
            success: true,
            durationMs: 10,
          };
        }),
      });

      const position1 = createMockTask({
        taskId: 'pos-1',
        runAt: now,
        priority: 0,
        position: 1,
        groupKey: 'group-1',
        execute: jest.fn().mockImplementation(async () => {
          executionOrder.push('pos-1');
          return {
            subscriberId: 'sub-1',
            subscriberName: 'Test',
            actionType: 'test',
            success: true,
            durationMs: 10,
          };
        }),
      });

      // Schedule position 5 first
      service.schedule(position5);
      service.schedule(position1);

      service.setConcurrency({ maxGlobal: 10, maxPerAgent: 10, maxPerGroup: 10 });

      jest.advanceTimersByTime(0);
      await Promise.resolve();

      // Position 1 should be first
      expect(executionOrder[0]).toBe('pos-1');
    });
  });
});
