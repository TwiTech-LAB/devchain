import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import type { SubscriberExecutionResult } from './subscriber-executor.service';

const logger = createLogger('AutomationSchedulerService');

/**
 * A scheduled task in the automation queue.
 */
export interface ScheduledTask {
  /** Unique task ID */
  taskId: string;
  /** The subscriber ID this task executes */
  subscriberId: string;
  /** Optional event ID for tracking */
  eventId?: string;
  /** Absolute timestamp when task should run (ms since epoch) */
  runAt: number;
  /** Priority for tie-breaking (higher runs first) */
  priority: number;
  /** Position within group for tie-breaking (lower runs first) */
  position: number;
  /** Creation timestamp for stable tie-breaking */
  createdAt: string;
  /** Agent ID for per-agent concurrency (optional) */
  agentId?: string;
  /** Group key for per-group concurrency: groupName ?? "event:" + eventName */
  groupKey: string;
  /** The function to execute when the task runs */
  execute: () => Promise<SubscriberExecutionResult>;
}

/**
 * Concurrency configuration for the scheduler.
 */
export interface ConcurrencyConfig {
  /** Maximum concurrent tasks globally */
  maxGlobal: number;
  /** Maximum concurrent tasks per agent (when agentId is set) */
  maxPerAgent: number;
  /** Maximum concurrent tasks per group */
  maxPerGroup: number;
}

/** Default concurrency limits */
const DEFAULT_CONCURRENCY: ConcurrencyConfig = {
  maxGlobal: 4,
  maxPerAgent: 1,
  maxPerGroup: 1,
};

/** Delay when tasks are blocked by concurrency (ms) */
const BLOCKED_RECHECK_DELAY_MS = 50;

/**
 * Comparator for scheduling priority.
 * Order: runAt ASC, priority DESC, position ASC, createdAt ASC
 */
export function compareScheduledTasks(a: ScheduledTask, b: ScheduledTask): number {
  // 1. runAt ASC (earlier runs first)
  if (a.runAt !== b.runAt) {
    return a.runAt - b.runAt;
  }
  // 2. priority DESC (higher priority runs first)
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  // 3. position ASC (lower position runs first)
  if (a.position !== b.position) {
    return a.position - b.position;
  }
  // 4. createdAt ASC (stable fallback)
  return a.createdAt.localeCompare(b.createdAt);
}

/**
 * AutomationSchedulerService manages a priority queue of scheduled tasks
 * with concurrency controls and independent scheduling.
 *
 * Key features:
 * - Tasks are ordered by runAt, priority, position, createdAt
 * - Concurrency limits: global, per-agent, per-group
 * - No busy loops: uses timers to wake at the right time
 * - No re-entrancy: processDueTasks is never called from finally blocks
 */
@Injectable()
export class AutomationSchedulerService implements OnModuleDestroy {
  /** The task queue, kept sorted by the 4-key comparator */
  private queue: ScheduledTask[] = [];

  /** Timer for the next scheduled wake-up */
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Currently executing task IDs */
  private executingTasks = new Set<string>();

  /** Count of currently executing tasks per agent */
  private executingByAgent = new Map<string, number>();

  /** Count of currently executing tasks per group */
  private executingByGroup = new Map<string, number>();

  /** Concurrency configuration */
  private concurrency: ConcurrencyConfig = { ...DEFAULT_CONCURRENCY };

  /** Flag to prevent scheduling during shutdown */
  private isShuttingDown = false;

  constructor() {
    logger.info('AutomationSchedulerService initialized');
  }

  /**
   * Clean up timers on module destroy.
   */
  onModuleDestroy(): void {
    logger.info('AutomationSchedulerService shutting down');
    this.isShuttingDown = true;
    this.clearWakeTimer();
    this.queue = [];
  }

  /**
   * Configure concurrency limits.
   */
  setConcurrency(config: Partial<ConcurrencyConfig>): void {
    this.concurrency = { ...this.concurrency, ...config };
    logger.debug({ concurrency: this.concurrency }, 'Concurrency configuration updated');
  }

  /**
   * Get current concurrency configuration.
   */
  getConcurrency(): ConcurrencyConfig {
    return { ...this.concurrency };
  }

  /**
   * Schedule a task to run at the specified time.
   * @param task The task to schedule
   */
  schedule(task: ScheduledTask): void {
    if (this.isShuttingDown) {
      logger.warn({ taskId: task.taskId }, 'Ignoring schedule during shutdown');
      return;
    }

    // Insert task in sorted position
    this.insertSorted(task);

    logger.debug(
      {
        taskId: task.taskId,
        subscriberId: task.subscriberId,
        runAt: new Date(task.runAt).toISOString(),
        priority: task.priority,
        position: task.position,
        groupKey: task.groupKey,
        queueLength: this.queue.length,
      },
      'Task scheduled',
    );

    // Reschedule wake timer if needed
    this.scheduleNextWake();
  }

  /**
   * Cancel a scheduled task by ID.
   * @returns true if task was found and removed
   */
  cancel(taskId: string): boolean {
    const index = this.queue.findIndex((t) => t.taskId === taskId);
    if (index === -1) {
      return false;
    }

    this.queue.splice(index, 1);
    logger.debug({ taskId }, 'Task cancelled');

    // Reschedule wake timer
    this.scheduleNextWake();
    return true;
  }

  /**
   * Cancel all tasks for a subscriber.
   * @returns number of tasks cancelled
   */
  cancelBySubscriber(subscriberId: string): number {
    const before = this.queue.length;
    this.queue = this.queue.filter((t) => t.subscriberId !== subscriberId);
    const cancelled = before - this.queue.length;

    if (cancelled > 0) {
      logger.debug({ subscriberId, cancelled }, 'Tasks cancelled for subscriber');
      this.scheduleNextWake();
    }

    return cancelled;
  }

  /**
   * Get the current queue length.
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Get the number of currently executing tasks.
   */
  getExecutingCount(): number {
    return this.executingTasks.size;
  }

  /**
   * Check if a task is currently executing.
   */
  isExecuting(taskId: string): boolean {
    return this.executingTasks.has(taskId);
  }

  /**
   * Insert a task in sorted position (binary search for efficiency).
   */
  private insertSorted(task: ScheduledTask): void {
    // Binary search for insertion point
    let low = 0;
    let high = this.queue.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareScheduledTasks(this.queue[mid], task) <= 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    this.queue.splice(low, 0, task);
  }

  /**
   * Clear the wake timer.
   */
  private clearWakeTimer(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  /**
   * Schedule the next wake-up based on the first task's runAt.
   */
  private scheduleNextWake(): void {
    this.clearWakeTimer();

    if (this.isShuttingDown || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const nextTask = this.queue[0];
    const delay = Math.max(0, nextTask.runAt - now);

    const timer = setTimeout(() => {
      this.wakeTimer = null;
      this.processDueTasks();
    }, delay);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.wakeTimer = timer;

    logger.debug(
      {
        nextTaskId: nextTask.taskId,
        delay,
        runAt: new Date(nextTask.runAt).toISOString(),
      },
      'Wake timer scheduled',
    );
  }

  /**
   * Process all tasks that are due and can run under concurrency limits.
   * This method is NOT re-entrant - it should never call itself from finally.
   */
  private processDueTasks(): void {
    if (this.isShuttingDown) {
      return;
    }

    const now = Date.now();
    let tasksStarted = 0;
    let tasksBlocked = 0;

    // Process tasks from the front of the queue
    while (this.queue.length > 0) {
      const task = this.queue[0];

      // If first task is not due yet, stop processing
      if (task.runAt > now) {
        break;
      }

      // Check concurrency limits
      if (!this.canExecute(task)) {
        // Task is blocked by concurrency - don't remove from queue
        // Move past this task to check others
        tasksBlocked++;

        // Check if there are other due tasks we can run
        let foundRunnable = false;
        for (let i = 1; i < this.queue.length && this.queue[i].runAt <= now; i++) {
          if (this.canExecute(this.queue[i])) {
            // Found a runnable task - execute it
            const runnableTask = this.queue.splice(i, 1)[0];
            this.executeTask(runnableTask);
            tasksStarted++;
            foundRunnable = true;
            break;
          }
        }

        if (!foundRunnable) {
          // All due tasks are blocked - schedule recheck with small delay
          break;
        }
        continue;
      }

      // Remove task from queue and execute
      this.queue.shift();
      this.executeTask(task);
      tasksStarted++;
    }

    logger.debug(
      {
        tasksStarted,
        tasksBlocked,
        queueRemaining: this.queue.length,
        executing: this.executingTasks.size,
      },
      'processDueTasks completed',
    );

    // Schedule next wake
    if (tasksBlocked > 0 && this.queue.length > 0 && this.queue[0].runAt <= now) {
      // Some tasks are due but blocked - schedule recheck
      const timer = setTimeout(() => {
        this.wakeTimer = null;
        this.processDueTasks();
      }, BLOCKED_RECHECK_DELAY_MS);
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        (timer as unknown as { unref: () => void }).unref();
      }
      this.wakeTimer = timer;
    } else {
      this.scheduleNextWake();
    }
  }

  /**
   * Check if a task can execute under current concurrency limits.
   */
  private canExecute(task: ScheduledTask): boolean {
    // Check global limit
    if (this.executingTasks.size >= this.concurrency.maxGlobal) {
      return false;
    }

    // Check per-agent limit
    if (task.agentId) {
      const agentCount = this.executingByAgent.get(task.agentId) ?? 0;
      if (agentCount >= this.concurrency.maxPerAgent) {
        return false;
      }
    }

    // Check per-group limit
    const groupCount = this.executingByGroup.get(task.groupKey) ?? 0;
    if (groupCount >= this.concurrency.maxPerGroup) {
      return false;
    }

    return true;
  }

  /**
   * Execute a task and track concurrency.
   */
  private executeTask(task: ScheduledTask): void {
    // Mark as executing
    this.executingTasks.add(task.taskId);

    if (task.agentId) {
      this.executingByAgent.set(task.agentId, (this.executingByAgent.get(task.agentId) ?? 0) + 1);
    }

    this.executingByGroup.set(task.groupKey, (this.executingByGroup.get(task.groupKey) ?? 0) + 1);

    logger.info(
      {
        taskId: task.taskId,
        subscriberId: task.subscriberId,
        groupKey: task.groupKey,
        agentId: task.agentId,
        globalConcurrency: this.executingTasks.size,
      },
      'Executing task',
    );

    // Execute the task (fire and forget from scheduler perspective)
    // The caller is responsible for handling the result
    task
      .execute()
      .then((result) => {
        logger.debug(
          {
            taskId: task.taskId,
            subscriberId: task.subscriberId,
            success: result.success,
          },
          'Task execution completed',
        );
      })
      .catch((error) => {
        logger.error(
          {
            taskId: task.taskId,
            subscriberId: task.subscriberId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Task execution failed',
        );
      })
      .finally(() => {
        // Release concurrency slots
        this.releaseTask(task);

        // Use setTimeout(0) to trigger recheck without re-entrancy
        // This allows blocked tasks to be reconsidered on the next event loop tick
        if (!this.isShuttingDown && this.queue.length > 0 && !this.wakeTimer) {
          const now = Date.now();
          if (this.queue[0].runAt <= now) {
            // Schedule immediate recheck for blocked tasks
            const timer = setTimeout(() => {
              this.wakeTimer = null;
              this.processDueTasks();
            }, 0);
            if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
              (timer as unknown as { unref: () => void }).unref();
            }
            this.wakeTimer = timer;
          }
        }
      });
  }

  /**
   * Release concurrency slots when a task completes.
   */
  private releaseTask(task: ScheduledTask): void {
    this.executingTasks.delete(task.taskId);

    if (task.agentId) {
      const agentCount = this.executingByAgent.get(task.agentId) ?? 1;
      if (agentCount <= 1) {
        this.executingByAgent.delete(task.agentId);
      } else {
        this.executingByAgent.set(task.agentId, agentCount - 1);
      }
    }

    const groupCount = this.executingByGroup.get(task.groupKey) ?? 1;
    if (groupCount <= 1) {
      this.executingByGroup.delete(task.groupKey);
    } else {
      this.executingByGroup.set(task.groupKey, groupCount - 1);
    }

    logger.debug(
      {
        taskId: task.taskId,
        globalConcurrency: this.executingTasks.size,
      },
      'Task released',
    );
  }

  // ============================================
  // Testing helpers (not for production use)
  // ============================================

  /**
   * Get the current queue (for testing).
   */
  _getQueue(): ScheduledTask[] {
    return [...this.queue];
  }

  /**
   * Force process due tasks immediately (for testing).
   */
  _processDueTasks(): void {
    this.processDueTasks();
  }

  /**
   * Check if wake timer is active (for testing).
   */
  _hasWakeTimer(): boolean {
    return this.wakeTimer !== null;
  }
}
