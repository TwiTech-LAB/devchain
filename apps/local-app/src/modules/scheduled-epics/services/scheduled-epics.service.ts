import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  STORAGE_SERVICE,
  type ScheduledEpicStorage,
  type ListScheduledEpicsOptions,
  type ListScheduledEpicRunsOptions,
  type ListResult,
} from '../../storage/interfaces/storage.interface';
import type {
  ScheduledEpic,
  ScheduledEpicRun,
  UpdateScheduledEpic,
} from '../../storage/models/domain.models';
import type { ClaimRunResult } from '../../storage/interfaces/storage.interface';
import { ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { getNextRunAt } from '../helpers/cron-helpers';
import {
  CreateScheduledEpicDtoSchema,
  UpdateScheduledEpicDtoSchema,
  type CreateScheduledEpicDto,
  type UpdateScheduledEpicDto,
} from '../dtos/scheduled-epic.dto';

export const SCHEDULED_EPIC_RUNNER_REFRESH = 'SCHEDULED_EPIC_RUNNER_REFRESH';

export interface ScheduledEpicRunnerRefresh {
  refreshScheduleWindow(): void;
}

const logger = createLogger('ScheduledEpicsService');

@Injectable()
export class ScheduledEpicsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ScheduledEpicStorage,
    @Optional()
    @Inject(SCHEDULED_EPIC_RUNNER_REFRESH)
    private readonly runnerRefresh?: ScheduledEpicRunnerRefresh,
  ) {}

  async create(dto: CreateScheduledEpicDto): Promise<ScheduledEpic> {
    const parsed = CreateScheduledEpicDtoSchema.parse(dto);

    const nextRunAt = this.computeNextRunAt(parsed.cronExpression, parsed.timezone);

    const schedule = await this.storage.createScheduledEpic({
      projectId: parsed.projectId,
      name: parsed.name,
      cronExpression: parsed.cronExpression,
      timezone: parsed.timezone,
      enabled: parsed.enabled,
      titleTemplate: parsed.titleTemplate,
      descriptionTemplate: parsed.descriptionTemplate ?? null,
      templateStatusId: parsed.templateStatusId ?? null,
      templateParentEpicId: parsed.templateParentEpicId ?? null,
      templateAgentId: parsed.templateAgentId ?? null,
      templateTags: parsed.templateTags,
      allowOverlap: parsed.allowOverlap,
      missedRunPolicy: parsed.missedRunPolicy,
      nextRunAt: nextRunAt?.toISOString() ?? null,
    });

    logger.info({ scheduleId: schedule.id, name: schedule.name }, 'Scheduled epic created');
    this.notifyRunner();
    return schedule;
  }

  async get(id: string): Promise<ScheduledEpic> {
    return this.storage.getScheduledEpic(id);
  }

  async list(
    projectId: string,
    options?: ListScheduledEpicsOptions,
  ): Promise<ListResult<ScheduledEpic>> {
    return this.storage.listScheduledEpics(projectId, options);
  }

  async update(
    id: string,
    dto: UpdateScheduledEpicDto,
    configVersion: number,
  ): Promise<ScheduledEpic> {
    const parsed = UpdateScheduledEpicDtoSchema.parse(dto);

    if (Object.keys(parsed).length === 0) {
      throw new ValidationError('At least one field must be provided for update');
    }

    const current = await this.storage.getScheduledEpic(id);

    const configUpdate: UpdateScheduledEpic = { ...parsed };
    let schedule = await this.storage.updateScheduledEpic(id, configUpdate, configVersion);

    const cronOrTzChanged = parsed.cronExpression !== undefined || parsed.timezone !== undefined;

    if (cronOrTzChanged) {
      const cronExpression = parsed.cronExpression ?? current.cronExpression;
      const timezone = parsed.timezone ?? current.timezone;
      const nextRunAt = this.computeNextRunAt(cronExpression, timezone);
      schedule = await this.storage.updateScheduledEpicRuntimeState(id, {
        nextRunAt: nextRunAt?.toISOString() ?? null,
      });
    }

    logger.info({ scheduleId: id }, 'Scheduled epic updated');
    this.notifyRunner();
    return schedule;
  }

  async delete(id: string): Promise<void> {
    await this.storage.getScheduledEpic(id);
    await this.storage.deleteScheduledEpic(id);

    logger.info({ scheduleId: id }, 'Scheduled epic deleted');
    this.notifyRunner();
  }

  async toggle(id: string, enabled: boolean, configVersion: number): Promise<ScheduledEpic> {
    let schedule = await this.storage.updateScheduledEpic(id, { enabled }, configVersion);

    if (enabled && !schedule.nextRunAt) {
      const nextRunAt = this.computeNextRunAt(schedule.cronExpression, schedule.timezone);
      schedule = await this.storage.updateScheduledEpicRuntimeState(id, {
        nextRunAt: nextRunAt?.toISOString() ?? null,
      });
    }

    logger.info({ scheduleId: id, enabled }, 'Scheduled epic toggled');
    this.notifyRunner();
    return schedule;
  }

  async runNow(id: string): Promise<ClaimRunResult> {
    await this.storage.getScheduledEpic(id);

    const plannedFor = new Date().toISOString();
    const result = await this.storage.createScheduledEpicRun({
      scheduleId: id,
      plannedFor,
      source: 'manual',
      status: 'pending',
    });

    logger.info(
      { scheduleId: id, runId: result.run.id, claimed: result.claimed },
      'Manual run requested',
    );
    this.notifyRunner();
    return result;
  }

  async listRuns(
    scheduleId: string,
    options?: ListScheduledEpicRunsOptions,
  ): Promise<ListResult<ScheduledEpicRun>> {
    await this.storage.getScheduledEpic(scheduleId);
    return this.storage.listScheduledEpicRuns(scheduleId, options);
  }

  private computeNextRunAt(cronExpression: string, timezone: string): Date | null {
    return getNextRunAt(cronExpression, timezone);
  }

  private notifyRunner(): void {
    if (this.runnerRefresh) {
      try {
        this.runnerRefresh.refreshScheduleWindow();
      } catch (error) {
        logger.warn({ error: String(error) }, 'Failed to notify runner of schedule change');
      }
    }
  }
}
