import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import type { LocalSkillSource } from '../../storage/models/domain.models';
import {
  CreateLocalSourceSchema,
  LocalSourceDeleteParamsSchema,
  LocalSourceResponseSchema,
  type LocalSourceResponseDto,
} from '../dtos/local-sources.dto';
import { LocalSourcesService } from '../services/local-sources.service';

const logger = createLogger('LocalSourcesController');

@Controller('api/skills/local-sources')
export class LocalSourcesController {
  constructor(private readonly localSourcesService: LocalSourcesService) {}

  @Get()
  async listLocalSources(): Promise<LocalSourceResponseDto[]> {
    logger.info('GET /api/skills/local-sources');
    const sources = await this.localSourcesService.listLocalSources();
    return sources.map((source) => this.toResponse(source));
  }

  @Post()
  async createLocalSource(@Body() body: unknown): Promise<LocalSourceResponseDto> {
    logger.info('POST /api/skills/local-sources');
    const parsed = CreateLocalSourceSchema.parse(body);
    const created = await this.localSourcesService.createLocalSource(parsed);
    return this.toResponse(created);
  }

  @Delete(':id')
  async deleteLocalSource(@Param() params: unknown): Promise<{ success: true }> {
    logger.info('DELETE /api/skills/local-sources/:id');
    const parsed = LocalSourceDeleteParamsSchema.parse(params);
    await this.localSourcesService.deleteLocalSource(parsed.id);
    return { success: true };
  }

  private toResponse(source: LocalSkillSource): LocalSourceResponseDto {
    return LocalSourceResponseSchema.parse(source);
  }
}
