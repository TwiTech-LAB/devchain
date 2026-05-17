import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  STORAGE_SERVICE,
  type StorageService,
  type CreateEpicForProjectInput,
  type ClaimRunResult,
} from '../../storage/interfaces/storage.interface';
import type {
  ScheduledEpic,
  ScheduledEpicRun,
  ScheduledEpicRunSource,
} from '../../storage/models/domain.models';
import { EpicsService } from '../../epics/services/epics.service';
import { EventsService } from '../../events/services/events.service';
import { createLogger } from '../../../common/logging/logger';
import { getNextRunAt } from '../helpers/cron-helpers';
import { renderScheduledEpicTemplate } from '../helpers/template-helpers';
import type { ScheduledEpicRunnerRefresh } from './scheduled-epics.service';
import type { ScheduledEpicErrorCode } from '../../events/catalog/scheduled-epic.executed';

const logger = createLogger('ScheduledEpicRunnerService');

const SCAN_INTERVAL_MS = 60_000;
const MIN_WAKE_MS = 1_000;
const MAX_CATCHUP_RUNS_PER_SCAN = 10;
const CATCHUP_HORIZON_MS = 24 * 60 * 60 * 1_000;
const STALE_RUNNING_THRESHOLD_MS = 15 * 60 * 1_000;

@Injectable()
export class ScheduledEpicRunnerService
  implements ScheduledEpicRunnerRefresh, OnModuleInit, OnModuleDestroy
{
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private scanning = false;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly epicsService: EpicsService,
    private readonly eventsService: EventsService,
  ) {}

  onModuleInit(): void {
    this.scheduleNextWake(MIN_WAKE_MS);
    logger.info('Runner initialized');
  }

  onModuleDestroy(): void {
    this.clearWakeTimer();
    logger.info('Runner destroyed');
  }

  refreshScheduleWindow(): void {
    this.scheduleNextWake(MIN_WAKE_MS);
  }

  private scheduleNextWake(delayMs: number): void {
    this.clearWakeTimer();
    const clamped = Math.max(MIN_WAKE_MS, delayMs);
    this.wakeTimer = setTimeout(() => this.wake(), clamped);
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  private async wake(): Promise<void> {
    if (this.scanning) {
      this.scheduleNextWake(SCAN_INTERVAL_MS);
      return;
    }

    this.scanning = true;
    try {
      await this.scanAndExecute();
    } catch (error) {
      logger.error({ error: String(error) }, 'Scan cycle failed');
    } finally {
      this.scanning = false;
      this.scheduleNextWake(SCAN_INTERVAL_MS);
    }
  }

  private async scanAndExecute(): Promise<void> {
    const projects = await this.storage.listProjects({ limit: 500 });

    for (const project of projects.items) {
      try {
        await this.scanProject(project.id);
      } catch (error) {
        logger.error(
          { projectId: project.id, error: String(error) },
          'Failed to scan project schedules',
        );
      }
    }
  }

  private async scanProject(projectId: string): Promise<void> {
    const now = new Date().toISOString();

    await this.recoverStaleRuns(projectId, now);

    const dueSchedules = await this.storage.listDueScheduledEpics(projectId, now);

    for (const schedule of dueSchedules) {
      try {
        await this.processSchedule(schedule, now);
      } catch (error) {
        logger.error(
          { scheduleId: schedule.id, error: String(error) },
          'Failed to process schedule',
        );
      }
    }

    const allSchedules = await this.storage.listScheduledEpics(projectId, { limit: 500 });
    for (const schedule of allSchedules.items) {
      try {
        await this.drainPendingRuns(schedule.id);
      } catch (error) {
        logger.error(
          { scheduleId: schedule.id, error: String(error) },
          'Failed to drain pending runs',
        );
      }
    }
  }

  private async processSchedule(schedule: ScheduledEpic, now: string): Promise<void> {
    if (!schedule.enabled || !schedule.nextRunAt) return;

    const missedSlots = this.computeMissedSlots(schedule, now);

    if (missedSlots.length <= 1) {
      await this.claimAndExecute(schedule, schedule.nextRunAt, 'scheduler');
      await this.advanceNextRunAt(schedule);
      return;
    }

    switch (schedule.missedRunPolicy) {
      case 'skip':
        logger.info(
          { scheduleId: schedule.id, missed: missedSlots.length },
          'Skipping missed runs per policy',
        );
        await this.advanceNextRunAt(schedule);
        break;

      case 'run_once':
        await this.claimAndExecute(schedule, missedSlots[missedSlots.length - 1]!, 'scheduler');
        await this.advanceNextRunAt(schedule);
        break;

      case 'run_all': {
        const slotsToProcess = missedSlots.slice(0, MAX_CATCHUP_RUNS_PER_SCAN);
        for (const slot of slotsToProcess) {
          await this.claimAndExecute(schedule, slot, 'scheduler');
        }
        if (missedSlots.length > MAX_CATCHUP_RUNS_PER_SCAN) {
          const firstUnprocessed = missedSlots[MAX_CATCHUP_RUNS_PER_SCAN]!;
          await this.storage.updateScheduledEpicRuntimeState(schedule.id, {
            nextRunAt: firstUnprocessed,
          });
          logger.info(
            {
              scheduleId: schedule.id,
              processed: slotsToProcess.length,
              remaining: missedSlots.length - MAX_CATCHUP_RUNS_PER_SCAN,
              nextRunAt: firstUnprocessed,
            },
            'Catch-up capped, preserving backlog for next scan',
          );
        } else {
          await this.advanceNextRunAt(schedule);
        }
        break;
      }
    }
  }

  private computeMissedSlots(schedule: ScheduledEpic, now: string): string[] {
    if (!schedule.nextRunAt) return [];

    const slots: string[] = [];
    let cursor = new Date(schedule.nextRunAt);
    const nowDate = new Date(now);
    const horizonCutoff = new Date(nowDate.getTime() - CATCHUP_HORIZON_MS);
    const enumerationLimit = MAX_CATCHUP_RUNS_PER_SCAN * 10;

    while (cursor <= nowDate && slots.length < enumerationLimit) {
      if (cursor >= horizonCutoff) {
        slots.push(cursor.toISOString());
      }
      const next = getNextRunAt(schedule.cronExpression, schedule.timezone, cursor);
      if (!next || next <= cursor) break;
      cursor = next;
    }

    return slots;
  }

  private async claimAndExecute(
    schedule: ScheduledEpic,
    plannedFor: string,
    source: ScheduledEpicRunSource,
  ): Promise<void> {
    const insertResult = await this.storage.createScheduledEpicRun({
      scheduleId: schedule.id,
      plannedFor,
      source,
      status: 'pending',
    });

    const runId = insertResult.run.id;
    const claimResult = await this.atomicClaim(schedule, runId);

    if (!claimResult.claimed) {
      logger.debug(
        { scheduleId: schedule.id, plannedFor, runId },
        'Claim lost, deferring to next scan',
      );
      return;
    }

    await this.executeClaimedRun(claimResult.run, schedule);
  }

  private async atomicClaim(schedule: ScheduledEpic, runId: string): Promise<ClaimRunResult> {
    let result = await this.storage.claimScheduledEpicRun(runId);

    if (!result.claimed && result.run.status === 'pending') {
      result = await this.storage.claimScheduledEpicRun(runId);
    }

    return result;
  }

  private async drainPendingRuns(scheduleId: string): Promise<void> {
    const runs = await this.storage.listScheduledEpicRuns(scheduleId, {
      status: 'pending',
      limit: 50,
    });

    for (const run of runs.items) {
      let schedule: ScheduledEpic;
      try {
        schedule = await this.storage.getScheduledEpic(run.scheduleId);
      } catch {
        await this.storage.updateScheduledEpicRun(run.id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          errorMessage: 'Schedule not found',
        });
        continue;
      }

      const claimResult = await this.atomicClaim(schedule, run.id);
      if (!claimResult.claimed) continue;
      await this.executeClaimedRun(claimResult.run, schedule);
    }
  }

  async executeRun(run: ScheduledEpicRun): Promise<void> {
    if (run.status !== 'pending') return;

    let schedule: ScheduledEpic;
    try {
      schedule = await this.storage.getScheduledEpic(run.scheduleId);
    } catch {
      logger.warn(
        { runId: run.id, scheduleId: run.scheduleId },
        'Schedule not found for run, marking failed',
      );
      await this.storage.updateScheduledEpicRun(run.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        errorMessage: 'Schedule not found',
      });
      return;
    }

    const claimResult = await this.atomicClaim(schedule, run.id);
    if (!claimResult.claimed) return;

    await this.executeClaimedRun(claimResult.run, schedule);
  }

  private async executeClaimedRun(run: ScheduledEpicRun, schedule: ScheduledEpic): Promise<void> {
    const finishedAt = new Date().toISOString();

    if (!schedule.enabled && run.source !== 'manual') {
      await this.storage.updateScheduledEpicRun(run.id, {
        status: 'skipped',
        finishedAt,
        errorMessage: 'Schedule disabled',
      });
      await this.publishRunOutcome(run, schedule, {
        status: 'skipped',
        finishedAt,
        errorCode: 'SCHEDULE_DISABLED',
        errorMessage: 'Schedule disabled',
        createdEpicId: null,
        createdEpicTitle: null,
      });
      return;
    }

    if (!schedule.allowOverlap) {
      const runningRuns = await this.storage.listScheduledEpicRuns(schedule.id, {
        status: 'running',
        limit: 2,
      });
      const otherRunning = runningRuns.items.filter((r) => r.id !== run.id);
      if (otherRunning.length > 0) {
        logger.debug(
          { scheduleId: schedule.id, runId: run.id },
          'Overlap not allowed and another run is in progress, skipping',
        );
        await this.storage.updateScheduledEpicRun(run.id, {
          status: 'skipped',
          finishedAt,
          errorMessage: 'Overlap not allowed',
        });
        await this.publishRunOutcome(run, schedule, {
          status: 'skipped',
          finishedAt,
          errorCode: 'DUPLICATE_CLAIM',
          errorMessage: 'Overlap not allowed',
          createdEpicId: null,
          createdEpicTitle: null,
        });
        return;
      }
    }

    let errorCode: ScheduledEpicErrorCode | null = null;

    try {
      const templateVars = this.buildTemplateVars(schedule, run);
      let title: string;
      let description: string | null;

      try {
        title = renderScheduledEpicTemplate(schedule.titleTemplate, templateVars);
        description = schedule.descriptionTemplate
          ? renderScheduledEpicTemplate(schedule.descriptionTemplate, templateVars)
          : null;
      } catch (err) {
        errorCode = 'TEMPLATE_RENDER_FAILED';
        throw err;
      }

      const epicInput: CreateEpicForProjectInput = {
        title,
        description,
        tags: schedule.templateTags,
        statusId: schedule.templateStatusId ?? undefined,
        agentId: schedule.templateAgentId ?? undefined,
        parentId: schedule.templateParentEpicId ?? undefined,
      };

      let epic: Awaited<ReturnType<typeof this.epicsService.createEpicForProject>>;
      try {
        epic = await this.epicsService.createEpicForProject(schedule.projectId, epicInput);
      } catch (err) {
        errorCode = 'EPIC_CREATE_FAILED';
        throw err;
      }

      await this.storage.updateScheduledEpicRun(run.id, {
        status: 'completed',
        createdEpicId: epic.id,
        finishedAt,
      });

      await this.storage.updateScheduledEpicRuntimeState(schedule.id, {
        lastRunAt: finishedAt,
        lastRunStatus: 'completed',
        lastError: null,
      });

      logger.info(
        { scheduleId: schedule.id, runId: run.id, epicId: epic.id },
        'Scheduled epic run completed',
      );

      await this.publishRunOutcome(run, schedule, {
        status: 'completed',
        finishedAt,
        errorCode: null,
        errorMessage: null,
        createdEpicId: epic.id,
        createdEpicTitle: epic.title,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const resolvedErrorCode: ScheduledEpicErrorCode = errorCode ?? 'UNKNOWN';

      await this.storage.updateScheduledEpicRun(run.id, {
        status: 'failed',
        finishedAt,
        errorMessage,
      });

      await this.storage.updateScheduledEpicRuntimeState(schedule.id, {
        lastRunAt: finishedAt,
        lastRunStatus: 'failed',
        lastError: errorMessage,
      });

      logger.error(
        { scheduleId: schedule.id, runId: run.id, error: errorMessage },
        'Scheduled epic run failed',
      );

      await this.publishRunOutcome(run, schedule, {
        status: 'failed',
        finishedAt,
        errorCode: resolvedErrorCode,
        errorMessage,
        createdEpicId: null,
        createdEpicTitle: null,
      });
    }
  }

  private async publishRunOutcome(
    run: ScheduledEpicRun,
    schedule: ScheduledEpic,
    outcome: {
      status: 'completed' | 'failed' | 'skipped';
      finishedAt: string;
      errorCode: ScheduledEpicErrorCode | null;
      errorMessage: string | null;
      createdEpicId: string | null;
      createdEpicTitle: string | null;
    },
  ): Promise<void> {
    const lagMs = new Date(outcome.finishedAt).getTime() - new Date(run.plannedFor).getTime();
    try {
      await this.eventsService.publish('scheduled_epic.executed', {
        scheduleId: schedule.id,
        runId: run.id,
        projectId: schedule.projectId,
        scheduleName: schedule.name,
        triggerSource: run.source,
        status: outcome.status,
        plannedFor: run.plannedFor,
        finishedAt: outcome.finishedAt,
        lagMs,
        createdEpicId: outcome.createdEpicId,
        createdEpicTitle: outcome.createdEpicTitle,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
      });
    } catch (error) {
      logger.warn({ error: String(error) }, 'Failed to publish scheduled_epic.executed event');
    }
  }

  private async recoverStaleRuns(projectId: string, now: string): Promise<void> {
    const allSchedules = await this.storage.listScheduledEpics(projectId, { limit: 500 });
    const staleCutoff = new Date(
      new Date(now).getTime() - STALE_RUNNING_THRESHOLD_MS,
    ).toISOString();

    for (const schedule of allSchedules.items) {
      const runningRuns = await this.storage.listScheduledEpicRuns(schedule.id, {
        status: 'running',
        limit: 50,
      });

      for (const run of runningRuns.items) {
        if (run.startedAt && run.startedAt < staleCutoff) {
          logger.warn(
            { runId: run.id, scheduleId: schedule.id, startedAt: run.startedAt },
            'Recovering stale running run',
          );
          await this.storage.updateScheduledEpicRun(run.id, {
            status: 'failed',
            finishedAt: now,
            errorMessage: 'STALE_RUNNING_RECOVERED',
          });
          await this.storage.updateScheduledEpicRuntimeState(schedule.id, {
            lastRunStatus: 'failed',
            lastError: 'STALE_RUNNING_RECOVERED',
          });
          await this.publishRunOutcome(run, schedule, {
            status: 'failed',
            finishedAt: now,
            errorCode: 'STALE_RUNNING_RECOVERED',
            errorMessage: 'STALE_RUNNING_RECOVERED',
            createdEpicId: null,
            createdEpicTitle: null,
          });
        }
      }
    }
  }

  private async advanceNextRunAt(schedule: ScheduledEpic): Promise<void> {
    const nextRunAt = getNextRunAt(schedule.cronExpression, schedule.timezone);
    await this.storage.updateScheduledEpicRuntimeState(schedule.id, {
      nextRunAt: nextRunAt?.toISOString() ?? null,
    });
  }

  private buildTemplateVars(
    schedule: ScheduledEpic,
    run: ScheduledEpicRun,
  ): Record<string, unknown> {
    const plannedDate = new Date(run.plannedFor);
    return {
      schedule_name: schedule.name,
      date: plannedDate.toISOString().split('T')[0],
      datetime: run.plannedFor,
      timestamp: plannedDate.getTime(),
      run_source: run.source,
      project_id: schedule.projectId,
    };
  }
}
