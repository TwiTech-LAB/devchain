import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  STORAGE_SERVICE,
  StorageService,
  ListResult,
  ListOptions,
} from '../../storage/interfaces/storage.interface';
import { EpicComment } from '../../storage/models/domain.models';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('EpicCommentsController');

const CreateEpicCommentSchema = z.object({
  authorName: z.string().min(1),
  content: z.string().min(1),
});

@Controller('api')
export class EpicCommentsController {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  @Get('epics/:id/comments')
  async listEpicComments(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ListResult<EpicComment>> {
    logger.info({ id, limit, offset }, 'GET /api/epics/:id/comments');
    const options = this.parseListOptions(limit, offset);
    return this.storage.listEpicComments(id, options);
  }

  @Post('epics/:id/comments')
  async createEpicComment(@Param('id') id: string, @Body() body: unknown): Promise<EpicComment> {
    logger.info({ id }, 'POST /api/epics/:id/comments');
    const parsed = CreateEpicCommentSchema.parse(body);
    return this.storage.createEpicComment({
      epicId: id,
      authorName: parsed.authorName,
      content: parsed.content,
    });
  }

  @Delete('comments/:id')
  async deleteEpicComment(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/comments/:id');
    await this.storage.deleteEpicComment(id);
  }

  private parseListOptions(limit?: string, offset?: string): ListOptions {
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
}
