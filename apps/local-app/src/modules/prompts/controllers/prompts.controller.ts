import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { StorageService, STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { CreatePrompt, UpdatePrompt, Prompt } from '../../storage/models/domain.models';
import { z } from 'zod';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('PromptsController');

const CreatePromptSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  tags: z.array(z.string()).optional(),
});

const UpdatePromptSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  version: z.number().optional(),
});

@Controller('api/prompts')
export class PromptsController {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  @Get()
  async listPrompts(
    @Query('projectId') projectId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    logger.info({ projectId, q, limit, offset }, 'GET /api/prompts');
    if (!projectId || projectId.trim() === '') {
      throw new BadRequestException({ message: 'projectId query parameter is required' });
    }

    let parsedLimit: number | undefined;
    if (limit) {
      const parsed = parseInt(limit, 10);
      if (!Number.isNaN(parsed)) {
        parsedLimit = parsed;
      }
    }

    let parsedOffset: number | undefined;
    if (offset) {
      const parsed = parseInt(offset, 10);
      if (!Number.isNaN(parsed)) {
        parsedOffset = parsed;
      }
    }

    return this.storage.listPrompts({
      projectId,
      q,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  }

  @Get(':id')
  async getPrompt(@Param('id') id: string): Promise<Prompt> {
    logger.info({ id }, 'GET /api/prompts/:id');
    return this.storage.getPrompt(id);
  }

  @Post()
  async createPrompt(@Body() body: unknown): Promise<Prompt> {
    logger.info('POST /api/prompts');
    const data = CreatePromptSchema.parse(body) as CreatePrompt;
    // Ensure projectId is set (schema enforces non-empty string)
    if (!data.projectId) {
      throw new BadRequestException({ message: 'projectId is required' });
    }
    return this.storage.createPrompt(data);
  }

  @Put(':id')
  async updatePrompt(@Param('id') id: string, @Body() body: unknown): Promise<Prompt> {
    logger.info({ id, body }, 'PUT /api/prompts/:id - received body');
    const parsed = UpdatePromptSchema.parse(body);
    logger.info({ parsed }, 'PUT /api/prompts/:id - parsed data');
    const version = parsed.version || 1;
    const data = { ...parsed, version: undefined } as UpdatePrompt;
    logger.info({ data, version }, 'PUT /api/prompts/:id - calling storage with data');
    return this.storage.updatePrompt(id, data, version);
  }

  @Delete(':id')
  async deletePrompt(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/prompts/:id');
    await this.storage.deletePrompt(id);
  }
}
