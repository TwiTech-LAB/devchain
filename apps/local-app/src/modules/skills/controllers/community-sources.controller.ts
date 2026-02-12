import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import type { CommunitySkillSource } from '../../storage/models/domain.models';
import {
  CommunitySourceDeleteParamsSchema,
  CommunitySourceResponseSchema,
  CreateCommunitySourceSchema,
  type CommunitySourceResponseDto,
} from '../dtos/community-sources.dto';
import { CommunitySourcesService } from '../services/community-sources.service';

const logger = createLogger('CommunitySourcesController');

@Controller('api/skills/community-sources')
export class CommunitySourcesController {
  constructor(private readonly communitySourcesService: CommunitySourcesService) {}

  @Get()
  async listCommunitySources(): Promise<CommunitySourceResponseDto[]> {
    logger.info('GET /api/skills/community-sources');
    const sources = await this.communitySourcesService.listCommunitySources();
    return sources.map((source) => this.toResponse(source));
  }

  @Post()
  async createCommunitySource(@Body() body: unknown): Promise<CommunitySourceResponseDto> {
    logger.info('POST /api/skills/community-sources');
    const parsed = CreateCommunitySourceSchema.parse(body);
    const created = await this.communitySourcesService.createCommunitySource(parsed);
    return this.toResponse(created);
  }

  @Delete(':id')
  async deleteCommunitySource(@Param() params: unknown): Promise<{ success: true }> {
    logger.info('DELETE /api/skills/community-sources/:id');
    const parsed = CommunitySourceDeleteParamsSchema.parse(params);
    await this.communitySourcesService.deleteCommunitySource(parsed.id);
    return { success: true };
  }

  private toResponse(source: CommunitySkillSource): CommunitySourceResponseDto {
    return CommunitySourceResponseSchema.parse(source);
  }
}
