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
import { z } from 'zod';
import { ScheduledEpicsService } from '../services/scheduled-epics.service';
import {
  CreateScheduledEpicDtoSchema,
  UpdateScheduledEpicDtoSchema,
} from '../dtos/scheduled-epic.dto';
import type { ScheduledEpic, ScheduledEpicRun } from '../../storage/models/domain.models';
import type { ListResult, ClaimRunResult } from '../../storage/interfaces/storage.interface';

const ToggleSchema = z
  .object({
    enabled: z.boolean(),
    configVersion: z.number().int().positive(),
  })
  .strict();

const UpdateWithVersionSchema = z
  .object({
    configVersion: z.number().int().positive(),
  })
  .passthrough();

@Controller('api/scheduled-epics')
export class ScheduledEpicsController {
  constructor(private readonly service: ScheduledEpicsService) {}

  @Get()
  async list(
    @Query('projectId') projectId?: string,
    @Query('enabled') enabled?: string,
  ): Promise<ScheduledEpic[]> {
    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }

    const result = await this.service.list(projectId, {
      enabled: enabled === 'true' ? true : enabled === 'false' ? false : undefined,
    });
    return result.items;
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<ScheduledEpic> {
    return this.service.get(id);
  }

  @Post()
  async create(@Body() body: unknown): Promise<ScheduledEpic> {
    const parseResult = CreateScheduledEpicDtoSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }
    return this.service.create(parseResult.data);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<ScheduledEpic> {
    const versionParse = UpdateWithVersionSchema.safeParse(body);
    if (!versionParse.success) {
      throw new BadRequestException({
        message: 'configVersion is required',
        errors: versionParse.error.errors,
      });
    }
    const { configVersion, ...rest } = versionParse.data;

    const dtoParse = UpdateScheduledEpicDtoSchema.safeParse(rest);
    if (!dtoParse.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: dtoParse.error.errors,
      });
    }

    return this.service.update(id, dtoParse.data, configVersion);
  }

  @Delete(':id')
  async delete(@Param('id') id: string): Promise<{ success: boolean }> {
    await this.service.delete(id);
    return { success: true };
  }

  @Post(':id/toggle')
  async toggle(@Param('id') id: string, @Body() body: unknown): Promise<ScheduledEpic> {
    const parseResult = ToggleSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }
    return this.service.toggle(id, parseResult.data.enabled, parseResult.data.configVersion);
  }

  @Post(':id/run-now')
  async runNow(@Param('id') id: string): Promise<ClaimRunResult> {
    return this.service.runNow(id);
  }

  @Get(':id/runs')
  async listRuns(
    @Param('id') scheduleId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ListResult<ScheduledEpicRun>> {
    return this.service.listRuns(scheduleId, {
      status: status as 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }
}
