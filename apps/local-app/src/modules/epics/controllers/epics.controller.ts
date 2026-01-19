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
import { ListResult, ListOptions } from '../../storage/interfaces/storage.interface';
import { CreateEpic, UpdateEpic, Epic } from '../../storage/models/domain.models';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { EpicsService } from '../services/epics.service';

const logger = createLogger('EpicsController');

const CreateEpicSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  statusId: z.string(),
  data: z.record(z.unknown()).nullable().optional(),
  tags: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
});

const UpdateEpicSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  statusId: z.string().optional(),
  data: z.record(z.unknown()).nullable().optional(),
  tags: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  version: z.number().optional(),
});

const BulkUpdateEntrySchema = z.object({
  id: z.string(),
  statusId: z.string().optional(),
  agentId: z.string().nullable().optional(),
  version: z.number(),
});

const BulkUpdateSchema = z.object({
  parentId: z.string().nullable().optional(),
  updates: z.array(BulkUpdateEntrySchema).min(1),
});

@Controller('api/epics')
export class EpicsController {
  constructor(private readonly epicsService: EpicsService) {}

  @Get()
  async listEpics(
    @Query('projectId') projectId?: string,
    @Query('statusId') statusId?: string,
    @Query('parentId') parentId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
  ): Promise<ListResult<Epic>> {
    logger.info({ projectId, statusId, parentId, limit, offset, type, q }, 'GET /api/epics');

    // parentId and statusId queries use pagination only (no search)
    if (parentId) {
      const options = this.parsePaginationOptions(limit, offset);
      return this.epicsService.listEpics({ parentId, options });
    }

    if (statusId) {
      const options = this.parsePaginationOptions(limit, offset);
      return this.epicsService.listEpics({ statusId, options });
    }

    if (!projectId) {
      throw new BadRequestException('Provide projectId, statusId, or parentId to list epics.');
    }

    // Project-level listing supports search query
    const options = this.parseEpicSearchOptions(limit, offset, q);
    const normalized = (type || 'active').toLowerCase();
    const allowed = new Set<string>(['active', 'archived', 'all']);
    const listType = (allowed.has(normalized) ? normalized : 'active') as
      | 'active'
      | 'archived'
      | 'all';
    return this.epicsService.listEpics({ projectId, type: listType, options });
  }

  @Get(':id/sub-epics')
  async listSubEpicsForEpic(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ListResult<Epic>> {
    logger.info({ id, limit, offset }, 'GET /api/epics/:id/sub-epics');
    const options = this.parsePaginationOptions(limit, offset);
    return this.epicsService.listSubEpics(id, options);
  }

  @Get(':id/sub-epics/counts')
  async countSubEpicsByStatus(@Param('id') id: string): Promise<Record<string, number>> {
    logger.info({ id }, 'GET /api/epics/:id/sub-epics/counts');
    return this.epicsService.countSubEpicsByStatus(id);
  }

  @Get(':id')
  async getEpic(@Param('id') id: string): Promise<Epic> {
    logger.info({ id }, 'GET /api/epics/:id');
    return this.epicsService.getEpicById(id);
  }

  @Post()
  async createEpic(@Body() body: unknown): Promise<Epic> {
    logger.info('POST /api/epics');
    const parsed = CreateEpicSchema.parse(body);
    const data: CreateEpic = {
      projectId: parsed.projectId,
      title: parsed.title,
      description: parsed.description ?? null,
      statusId: parsed.statusId,
      data: parsed.data ?? null,
      tags: parsed.tags ?? [],
      parentId: parsed.parentId ?? null,
      agentId: parsed.agentId ?? null,
    };
    return this.epicsService.createEpic(data);
  }

  @Post('bulk-update')
  async bulkUpdateEpics(@Body() body: unknown): Promise<Epic[]> {
    logger.info('POST /api/epics/bulk-update');
    const parsed = BulkUpdateSchema.parse(body);
    return this.epicsService.bulkUpdateEpics(parsed.updates, parsed.parentId ?? null);
  }

  @Put(':id')
  async updateEpic(@Param('id') id: string, @Body() body: unknown): Promise<Epic> {
    logger.info({ id }, 'PUT /api/epics/:id');
    const { version = 1, ...rest } = UpdateEpicSchema.parse(body);
    const data = rest as UpdateEpic;
    return this.epicsService.updateEpic(id, data, version);
  }

  @Delete(':id')
  async deleteEpic(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/epics/:id');
    await this.epicsService.deleteEpic(id);
  }

  /**
   * Parse pagination options (limit/offset) for basic list queries.
   * Used for sub-epic listing and status-filtered queries.
   */
  private parsePaginationOptions(limit?: string, offset?: string): ListOptions {
    const options: ListOptions = {};

    if (limit !== undefined) {
      const parsed = parseInt(limit, 10);
      if (!Number.isNaN(parsed)) {
        options.limit = parsed;
      }
    }

    if (offset !== undefined) {
      const parsed = parseInt(offset, 10);
      if (!Number.isNaN(parsed)) {
        options.offset = parsed;
      }
    }

    return options;
  }

  /**
   * Parse search options (limit/offset/q) for project-level epic listing.
   * Includes optional search query parameter for filtering by title or UUID prefix.
   */
  private parseEpicSearchOptions(
    limit?: string,
    offset?: string,
    q?: string,
  ): ListOptions & { q?: string } {
    const options: ListOptions & { q?: string } = this.parsePaginationOptions(limit, offset);

    if (q !== undefined && q.trim().length > 0) {
      options.q = q;
    }

    return options;
  }
}
