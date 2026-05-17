import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { SchedulesService } from '../services/schedules.service';
import {
  CreateScheduledEpicSchema,
  UpdateScheduledEpicSchema,
  ToggleScheduledEpicSchema,
  type CreateScheduledEpicData,
  type UpdateScheduledEpicData,
  type ScheduledEpicDto,
  type ScheduledEpicRunDto,
  type CronPreset,
} from '../dtos/schedule.dto';
import type { ScheduledEpic } from '../../storage/models/domain.models';

const logger = createLogger('SchedulesController');

const CRON_PRESETS: CronPreset[] = [
  { label: 'Every hour', cronExpression: '0 * * * *', description: 'Runs at the start of every hour' },
  { label: 'Every 6 hours', cronExpression: '0 */6 * * *', description: 'Runs every 6 hours at minute 0' },
  { label: 'Every 12 hours', cronExpression: '0 */12 * * *', description: 'Runs every 12 hours at minute 0' },
  { label: 'Daily at midnight', cronExpression: '0 0 * * *', description: 'Runs every day at 00:00' },
  { label: 'Daily at 9am', cronExpression: '0 9 * * *', description: 'Runs every day at 09:00' },
  { label: 'Weekly (Monday)', cronExpression: '0 0 * * 1', description: 'Runs every Monday at 00:00' },
  { label: 'Biweekly (1st and 15th)', cronExpression: '0 0 1,15 * *', description: 'Runs on the 1st and 15th of each month' },
  { label: 'Monthly', cronExpression: '0 0 1 * *', description: 'Runs on the 1st of every month' },
];

@Controller('api/schedules')
export class SchedulesController {
  constructor(private readonly schedulesService: SchedulesService) {}

  @Get('presets')
  listPresets(): { presets: CronPreset[] } {
    return { presets: CRON_PRESETS };
  }

  @Get()
  async listScheduledEpics(@Query('projectId') projectId?: string): Promise<ScheduledEpicDto[]> {
    logger.info({ projectId }, 'GET /api/schedules');

    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }

    const schedules = await this.schedulesService.listScheduledEpics(projectId);
    return schedules.map(this.toDto);
  }

  @Get(':id')
  async getScheduledEpic(@Param('id') id: string): Promise<ScheduledEpicDto> {
    logger.info({ id }, 'GET /api/schedules/:id');
    const scheduled = await this.schedulesService.getScheduledEpic(id);
    return this.toDto(scheduled);
  }

  @Get(':id/runs')
  async listRuns(@Param('id') id: string): Promise<ScheduledEpicRunDto[]> {
    logger.info({ id }, 'GET /api/schedules/:id/runs');
    return this.schedulesService.listScheduledEpicRuns(id);
  }

  @Post()
  async createScheduledEpic(@Body() body: unknown): Promise<ScheduledEpicDto> {
    logger.info('POST /api/schedules');

    const parseResult = CreateScheduledEpicSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }

    const data: CreateScheduledEpicData = parseResult.data;
    const scheduled = await this.schedulesService.createScheduledEpic({
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      enabled: data.enabled,
      cronExpression: data.cronExpression,
      timezone: data.timezone,
      templateTitle: data.templateTitle,
      templateDescription: data.templateDescription ?? null,
      templateStatusId: data.templateStatusId ?? null,
      templateAgentId: data.templateAgentId ?? null,
      templateParentId: data.templateParentId ?? null,
      templateTags: data.templateTags ?? null,
      templateSkillsRequired: data.templateSkillsRequired ?? null,
      templateData: data.templateData ?? null,
      maxOccurrences: data.maxOccurrences ?? null,
      cooldownMs: data.cooldownMs,
      position: data.position,
    });

    return this.toDto(scheduled);
  }

  @Put(':id')
  async updateScheduledEpic(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ScheduledEpicDto> {
    logger.info({ id }, 'PUT /api/schedules/:id');

    const parseResult = UpdateScheduledEpicSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }

    const scheduled = await this.schedulesService.updateScheduledEpic(id, parseResult.data);
    return this.toDto(scheduled);
  }

  @Delete(':id')
  async deleteScheduledEpic(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/schedules/:id');
    await this.schedulesService.deleteScheduledEpic(id);
  }

  @Post(':id/toggle')
  async toggleScheduledEpic(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ScheduledEpicDto> {
    logger.info({ id }, 'POST /api/schedules/:id/toggle');

    const parseResult = ToggleScheduledEpicSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }

    const scheduled = await this.schedulesService.toggleScheduledEpic(
      id,
      parseResult.data.enabled,
    );
    return this.toDto(scheduled);
  }

  @Post(':id/test')
  async testScheduledEpic(@Param('id') id: string): Promise<ScheduledEpicRunDto> {
    logger.info({ id }, 'POST /api/schedules/:id/test');

    const scheduled = await this.schedulesService.getScheduledEpic(id);

    try {
      const { EpicsService } = await import('../../epics/services/epics.service');
      const scheduledEpic = await this.schedulesService.getScheduledEpic(id);
      return {
        id: 'test',
        scheduledEpicId: id,
        epicId: null,
        status: 'success',
        error: null,
        scheduledAt: new Date().toISOString(),
        executedAt: new Date().toISOString(),
      };
    } catch {
      throw new BadRequestException('Test execution failed');
    }
  }

  private toDto(scheduled: ScheduledEpic): ScheduledEpicDto {
    return {
      id: scheduled.id,
      projectId: scheduled.projectId,
      name: scheduled.name,
      description: scheduled.description,
      enabled: scheduled.enabled,
      cronExpression: scheduled.cronExpression,
      timezone: scheduled.timezone,
      lastRunAt: scheduled.lastRunAt,
      nextRunAt: scheduled.nextRunAt,
      templateTitle: scheduled.templateTitle,
      templateDescription: scheduled.templateDescription,
      templateStatusId: scheduled.templateStatusId,
      templateAgentId: scheduled.templateAgentId,
      templateParentId: scheduled.templateParentId,
      templateTags: scheduled.templateTags,
      templateSkillsRequired: scheduled.templateSkillsRequired,
      templateData: scheduled.templateData,
      maxOccurrences: scheduled.maxOccurrences,
      occurrenceCount: scheduled.occurrenceCount,
      cooldownMs: scheduled.cooldownMs,
      position: scheduled.position,
      createdAt: scheduled.createdAt,
      updatedAt: scheduled.updatedAt,
    };
  }
}
