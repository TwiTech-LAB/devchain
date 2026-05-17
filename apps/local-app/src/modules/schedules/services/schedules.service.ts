import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import {
  STORAGE_SERVICE,
  type ScheduledEpicStorage,
} from '../../storage/interfaces/storage.interface';
import type {
  ScheduledEpic,
  CreateScheduledEpic,
  UpdateScheduledEpic,
  ScheduledEpicRun,
} from '../../storage/models/domain.models';
import { Cron } from 'croner';

@Injectable()
export class SchedulesService {
  private readonly logger = createLogger('SchedulesService');

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ScheduledEpicStorage,
  ) {}

  async listScheduledEpics(projectId: string): Promise<ScheduledEpic[]> {
    return this.storage.listScheduledEpics(projectId);
  }

  async getScheduledEpic(id: string): Promise<ScheduledEpic> {
    const scheduled = await this.storage.getScheduledEpic(id);
    if (!scheduled) {
      throw new NotFoundException(`Scheduled epic not found: ${id}`);
    }
    return scheduled;
  }

  async createScheduledEpic(data: CreateScheduledEpic): Promise<ScheduledEpic> {
    this.validateCronExpression(data.cronExpression);
    const nextRunAt = this.computeNextRun(data.cronExpression, data.timezone);
    return this.storage.createScheduledEpic({ ...data, nextRunAt });
  }

  async updateScheduledEpic(id: string, data: UpdateScheduledEpic): Promise<ScheduledEpic> {
    await this.getScheduledEpic(id);

    if (data.cronExpression) {
      this.validateCronExpression(data.cronExpression);
    }

    const existing = await this.storage.getScheduledEpic(id);
    const cronExpression = data.cronExpression ?? existing!.cronExpression;
    const timezone = data.timezone ?? existing!.timezone;

    let nextRunAt = existing!.nextRunAt;
    if (data.cronExpression || data.timezone) {
      nextRunAt = this.computeNextRun(cronExpression, timezone);
    }

    return this.storage.updateScheduledEpic(id, { ...data, nextRunAt });
  }

  async deleteScheduledEpic(id: string): Promise<void> {
    await this.getScheduledEpic(id);
    await this.storage.deleteScheduledEpic(id);
  }

  async toggleScheduledEpic(id: string, enabled: boolean): Promise<ScheduledEpic> {
    const scheduled = await this.getScheduledEpic(id);
    if (enabled && !scheduled.nextRunAt) {
      const nextRunAt = this.computeNextRun(scheduled.cronExpression, scheduled.timezone);
      return this.storage.updateScheduledEpic(id, { enabled, nextRunAt });
    }
    return this.storage.updateScheduledEpic(id, { enabled });
  }

  async listScheduledEpicRuns(scheduledEpicId: string): Promise<ScheduledEpicRun[]> {
    return this.storage.listScheduledEpicRuns(scheduledEpicId);
  }

  async listDueScheduledEpics(): Promise<ScheduledEpic[]> {
    return this.storage.listDueScheduledEpics();
  }

  validateCronExpression(expression: string): void {
    try {
      new Cron(expression);
    } catch {
      throw new NotFoundException(`Invalid cron expression: ${expression}`);
    }
  }

  computeNextRun(cronExpression: string, timezone: string): string {
    try {
      const job = new Cron(cronExpression, { timezone });
      const next = job.nextRun();
      if (!next) {
        throw new Error('No future occurrences');
      }
      return next.toISOString();
    } catch (error) {
      this.logger.warn({ error, cronExpression, timezone }, 'Failed to compute next run');
      return new Date().toISOString();
    }
  }
}
