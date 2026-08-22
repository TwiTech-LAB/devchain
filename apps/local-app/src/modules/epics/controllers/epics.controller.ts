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
  UseGuards,
} from '@nestjs/common';
import { ListResult, ListOptions } from '../../storage/interfaces/storage.interface';
import {
  CreateEpic,
  UpdateEpic,
  Epic,
  INTEGRATION_PROVIDER_IDS,
} from '../../storage/models/domain.models';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { EpicsService } from '../services/epics.service';
import { SkillsRequiredInputSchema } from '../../skills/dtos/skill.dto';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import { normalizeExternalTaskSourceUrl } from '../../external-integrations/models/external-task-source';
import type {
  ExternalTaskImportResponse,
  ExternalTaskSourceSummary,
} from '../../external-integrations/models/external-provider.models';

const logger = createLogger('EpicsController');

const CreateEpicSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  statusId: z.string(),
  data: z.record(z.unknown()).nullable().optional(),
  skillsRequired: SkillsRequiredInputSchema.nullable().optional(),
  tags: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
});

const UpdateEpicSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  statusId: z.string().optional(),
  data: z.record(z.unknown()).nullable().optional(),
  skillsRequired: SkillsRequiredInputSchema.nullable().optional(),
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
const ExternalProviderSchema = z.enum(INTEGRATION_PROVIDER_IDS);
// 1,000 UUIDs do not belong in a URL; this bounded batch read matches the
// existing project batch-route pattern. The limit stays below SQLite's
// bind-variable ceiling, so one IN query needs no chunking.
const ExternalSourcesBatchSchema = z
  .object({
    epicIds: z.array(z.string().uuid()).min(1).max(1_000),
  })
  .strict();
const ImportExternalTaskSchema = z
  .object({
    projectId: z.string().uuid(),
    statusId: z.string().uuid(),
    agentId: z.null(),
    title: z.string().trim().min(1).max(1_000),
    description: z.string().max(65_536).nullable(),
    remote: z
      .object({
        provider: ExternalProviderSchema,
        scopeKey: z.string().trim().min(1).max(256),
        taskId: z.string().trim().min(1).max(256),
        remoteKey: z.string().trim().min(1).max(256),
        title: z.string().trim().min(1).max(1_000),
        description: z.string().max(65_536).nullable(),
        webUrl: z.string().url().max(2_048),
        workAreaId: z.string().trim().min(1).max(256),
        workAreaName: z.string().trim().min(1).max(1_000),
        statusName: z.string().trim().min(1).max(256),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!normalizeExternalTaskSourceUrl(value.remote.provider, value.remote.webUrl)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['remote', 'webUrl'],
        message: 'Remote task URL is not allowed for this provider.',
      });
    }
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
      skillsRequired: parsed.skillsRequired ?? null,
      tags: parsed.tags ?? [],
      parentId: parsed.parentId ?? null,
      agentId: parsed.agentId ?? null,
    };
    return this.epicsService.createEpic(data);
  }

  @Post('import-external-task')
  @UseGuards(IntegrationAdmissionGuard)
  async importExternalTask(@Body() body: unknown): Promise<ExternalTaskImportResponse> {
    const input = ImportExternalTaskSchema.parse(body);
    const result = await this.epicsService.importExternalTask({
      projectId: input.projectId,
      statusId: input.statusId,
      title: input.title,
      description: input.description,
      remote: {
        ...input.remote,
        webUrl: normalizeExternalTaskSourceUrl(input.remote.provider, input.remote.webUrl)!,
      },
    });
    return {
      epic: { id: result.epic.id, projectId: result.epic.projectId },
      created: result.created,
    };
  }

  @Get(':id/external-sources')
  @UseGuards(IntegrationAdmissionGuard)
  async getExternalSources(
    @Param('id') id: string,
  ): Promise<{ items: ExternalTaskSourceSummary[] }> {
    await this.epicsService.getEpicById(id);
    const links = await this.epicsService.listExternalTaskSources(id);
    return { items: links };
  }

  @Post('external-sources/batch')
  @UseGuards(IntegrationAdmissionGuard)
  async getExternalSourcesBatch(
    @Body() body: unknown,
  ): Promise<{ items: Array<{ epicId: string } & ExternalTaskSourceSummary> }> {
    const parsed = ExternalSourcesBatchSchema.parse(body);
    // Missing and unlinked Epics are omitted; the batch itself never 404s.
    const items = await this.epicsService.listExternalTaskSourcesBatch(parsed.epicIds);
    return { items };
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
