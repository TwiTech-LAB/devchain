import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import {
  STORAGE_SERVICE,
  type StorageService,
} from '../../storage/interfaces/storage.interface';
import type { ScheduledEpic } from '../../storage/models/domain.models';
import { SchedulesService } from './schedules.service';
import { EpicsService } from '../../epics/services/epics.service';
import { EventsService } from '../../events/services/events.service';
import Handlebars from 'handlebars';

const TICK_INTERVAL_MS = 30_000;

@Injectable()
export class SchedulerRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('SchedulerRunnerService');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly schedulesService: SchedulesService,
    private readonly epicsService: EpicsService,
    private readonly eventsService: EventsService,
  ) {}

  async onModuleInit() {
    this.logger.info('Starting scheduler runner');
    await this.recomputeAllNextRuns();
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async recomputeAllNextRuns(): Promise<void> {
    try {
      const { scheduledEpics } = await import('../../storage/db/schema');
      const { eq } = await import('drizzle-orm');
      const db = (
        this.storage as unknown as {
          db: import('drizzle-orm/better-sqlite3').BetterSQLite3Database;
        }
      ).db;

      if (!db) return;

      const rows = await db
        .select()
        .from(scheduledEpics)
        .where(eq(scheduledEpics.enabled, true));

      for (const row of rows) {
        try {
          const nextRunAt = this.schedulesService.computeNextRun(
            row.cronExpression as string,
            row.timezone as string,
          );
          await db
            .update(scheduledEpics)
            .set({ nextRunAt, updatedAt: new Date().toISOString() })
            .where(eq(scheduledEpics.id, row.id as string));
        } catch (error) {
          this.logger.warn({ id: row.id, error }, 'Failed to recompute nextRunAt');
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to recompute next runs');
    }
  }

  private async tick(): Promise<void> {
    try {
      const dueSchedules = await this.schedulesService.listDueScheduledEpics();

      for (const schedule of dueSchedules) {
        await this.executeSchedule(schedule);
      }
    } catch (error) {
      this.logger.error({ error }, 'Scheduler tick failed');
    }
  }

  private async executeSchedule(schedule: ScheduledEpic): Promise<void> {
    const now = new Date();
    const nowIso = now.toISOString();

    try {
      if (
        schedule.maxOccurrences !== null &&
        schedule.occurrenceCount >= schedule.maxOccurrences
      ) {
        await this.storage.updateScheduledEpic(schedule.id, {
          enabled: false,
          nextRunAt: null,
        });
        this.logger.info(
          { id: schedule.id },
          'Scheduled epic reached max occurrences, disabling',
        );
        return;
      }

      if (schedule.cooldownMs > 0 && schedule.lastRunAt) {
        const elapsed = now.getTime() - new Date(schedule.lastRunAt).getTime();
        if (elapsed < schedule.cooldownMs) {
          this.logger.debug({ id: schedule.id }, 'Scheduled epic on cooldown, skipping');
          return;
        }
      }

      const context = {
        date: now.toISOString().split('T')[0],
        time: now.toTimeString().split(' ')[0],
        datetime: nowIso,
        sequence: schedule.occurrenceCount + 1,
        lastRunAt: schedule.lastRunAt ?? '',
      };

      const title = this.renderTemplate(schedule.templateTitle, context);
      const description = schedule.templateDescription
        ? this.renderTemplate(schedule.templateDescription, context)
        : null;

      const epic = await this.epicsService.createEpicForProject(schedule.projectId, {
        title,
        description,
        statusId: schedule.templateStatusId ?? undefined,
        agentId: schedule.templateAgentId ?? undefined,
        parentId: schedule.templateParentId ?? undefined,
        tags: schedule.templateTags ?? undefined,
        skillsRequired: schedule.templateSkillsRequired ?? undefined,
      });

      const nextRunAt = this.schedulesService.computeNextRun(
        schedule.cronExpression,
        schedule.timezone,
      );

      await this.storage.updateScheduledEpic(schedule.id, {
        lastRunAt: nowIso,
        nextRunAt,
        occurrenceCount: schedule.occurrenceCount + 1,
      });

      await this.storage.createScheduledEpicRun({
        scheduledEpicId: schedule.id,
        epicId: epic.id,
        status: 'success',
        error: null,
        scheduledAt: schedule.nextRunAt ?? nowIso,
        executedAt: nowIso,
      });

      try {
        await this.eventsService.publish('scheduled_epic.executed', {
          scheduledEpicId: schedule.id,
          epicId: epic.id,
          projectId: schedule.projectId,
          templateTitle: title,
          occurrenceCount: schedule.occurrenceCount + 1,
        });
      } catch (eventError) {
        this.logger.warn(
          { eventError },
          'Failed to publish scheduled_epic.executed event',
        );
      }

      this.logger.info(
        { id: schedule.id, epicId: epic.id, title },
        'Scheduled epic executed successfully',
      );
    } catch (error) {
      const nextRunAt = this.schedulesService.computeNextRun(
        schedule.cronExpression,
        schedule.timezone,
      );

      await this.storage.updateScheduledEpic(schedule.id, {
        nextRunAt,
      });

      await this.storage.createScheduledEpicRun({
        scheduledEpicId: schedule.id,
        epicId: null,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        scheduledAt: schedule.nextRunAt ?? nowIso,
        executedAt: nowIso,
      });

      this.logger.error({ id: schedule.id, error }, 'Scheduled epic execution failed');
    }
  }

  private renderTemplate(
    template: string,
    context: Record<string, unknown>,
  ): string {
    try {
      const compiled = Handlebars.compile(template, { noEscape: true });
      return compiled(context);
    } catch {
      return template;
    }
  }
}
