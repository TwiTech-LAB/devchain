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
import { WatchersService } from '../services/watchers.service';
import {
  CreateWatcherSchema,
  UpdateWatcherSchema,
  ToggleWatcherSchema,
  type CreateWatcherData,
  type UpdateWatcherData,
  type WatcherDto,
  type WatcherTestResultDto,
} from '../dtos/watcher.dto';
import type { Watcher } from '../../storage/models/domain.models';

const logger = createLogger('WatchersController');

@Controller('api/watchers')
export class WatchersController {
  constructor(private readonly watchersService: WatchersService) {}

  /**
   * GET /api/watchers?projectId=<id>
   * List all watchers for a project.
   */
  @Get()
  async listWatchers(@Query('projectId') projectId?: string): Promise<WatcherDto[]> {
    logger.info({ projectId }, 'GET /api/watchers');

    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }

    const watchers = await this.watchersService.listWatchers(projectId);
    return watchers.map(this.toDto);
  }

  /**
   * GET /api/watchers/:id
   * Get a single watcher by ID.
   */
  @Get(':id')
  async getWatcher(@Param('id') id: string): Promise<WatcherDto> {
    logger.info({ id }, 'GET /api/watchers/:id');

    // Service throws NotFoundException if not found
    const watcher = await this.watchersService.getWatcher(id);
    return this.toDto(watcher);
  }

  /**
   * POST /api/watchers
   * Create a new watcher.
   */
  @Post()
  async createWatcher(@Body() body: unknown): Promise<WatcherDto> {
    logger.info('POST /api/watchers');

    const parseResult = CreateWatcherSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }

    const data: CreateWatcherData = parseResult.data;
    const watcher = await this.watchersService.createWatcher({
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      enabled: data.enabled,
      scope: data.scope,
      scopeFilterId: data.scopeFilterId ?? null,
      pollIntervalMs: data.pollIntervalMs,
      viewportLines: data.viewportLines,
      idleAfterSeconds: data.idleAfterSeconds,
      condition: data.condition,
      cooldownMs: data.cooldownMs,
      cooldownMode: data.cooldownMode,
      eventName: data.eventName,
    });

    return this.toDto(watcher);
  }

  /**
   * PUT /api/watchers/:id
   * Update an existing watcher.
   */
  @Put(':id')
  async updateWatcher(@Param('id') id: string, @Body() body: unknown): Promise<WatcherDto> {
    logger.info({ id }, 'PUT /api/watchers/:id');

    const parseResult = UpdateWatcherSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }

    const data: UpdateWatcherData = parseResult.data;
    // Service throws NotFoundException if not found
    const watcher = await this.watchersService.updateWatcher(id, data);

    return this.toDto(watcher);
  }

  /**
   * DELETE /api/watchers/:id
   * Delete a watcher.
   */
  @Delete(':id')
  async deleteWatcher(@Param('id') id: string): Promise<{ success: boolean }> {
    logger.info({ id }, 'DELETE /api/watchers/:id');

    // Verify exists first (service.getWatcher throws if not found)
    await this.watchersService.getWatcher(id);
    await this.watchersService.deleteWatcher(id);

    return { success: true };
  }

  /**
   * POST /api/watchers/:id/toggle
   * Toggle watcher enabled status.
   */
  @Post(':id/toggle')
  async toggleWatcher(@Param('id') id: string, @Body() body: unknown): Promise<WatcherDto> {
    logger.info({ id }, 'POST /api/watchers/:id/toggle');

    const parseResult = ToggleWatcherSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }

    // Service throws NotFoundException if not found
    const watcher = await this.watchersService.toggleWatcher(id, parseResult.data.enabled);

    return this.toDto(watcher);
  }

  /**
   * POST /api/watchers/:id/test
   * Test a watcher against current terminal viewports.
   * Returns viewport preview and condition match status without triggering events.
   */
  @Post(':id/test')
  async testWatcher(@Param('id') id: string): Promise<WatcherTestResultDto> {
    logger.info({ id }, 'POST /api/watchers/:id/test');

    // Service throws NotFoundException if not found
    const result = await this.watchersService.testWatcher(id);

    return {
      watcher: this.toDto(result.watcher),
      sessionsChecked: result.sessionsChecked,
      results: result.results,
    };
  }

  /**
   * Convert domain Watcher to WatcherDto
   */
  private toDto(watcher: Watcher): WatcherDto {
    return {
      id: watcher.id,
      projectId: watcher.projectId,
      name: watcher.name,
      description: watcher.description,
      enabled: watcher.enabled,
      scope: watcher.scope,
      scopeFilterId: watcher.scopeFilterId,
      pollIntervalMs: watcher.pollIntervalMs,
      viewportLines: watcher.viewportLines,
      idleAfterSeconds: watcher.idleAfterSeconds,
      condition: watcher.condition,
      cooldownMs: watcher.cooldownMs,
      cooldownMode: watcher.cooldownMode,
      eventName: watcher.eventName,
      createdAt: watcher.createdAt,
      updatedAt: watcher.updatedAt,
    };
  }
}
