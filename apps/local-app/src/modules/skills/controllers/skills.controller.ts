import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { Skill } from '../../storage/models/domain.models';
import {
  SkillByIdParamsSchema,
  SkillBySlugParamsSchema,
  SkillBulkActionSchema,
  SkillDisableBodySchema,
  SkillDisableParamsSchema,
  SkillDisabledQuerySchema,
  SkillEnableBodySchema,
  SkillEnableParamsSchema,
  SkillResolveSlugsBodySchema,
  SkillSourceParamsSchema,
  SkillSyncRequestSchema,
  SkillUsageLogQuerySchema,
  SkillUsageStatsQuerySchema,
  SkillsListQuerySchema,
  type ResolvedSkillSummary,
} from '../dtos/skill.dto';
import { SkillSyncService, SyncResult } from '../services/skill-sync.service';
import {
  SkillSourceMetadata,
  ProjectSkill,
  SkillUsageLogListResult,
  SkillUsageStat,
  SkillsService,
} from '../services/skills.service';

const logger = createLogger('SkillsController');

@Controller('api/skills')
export class SkillsController {
  constructor(
    private readonly skillsService: SkillsService,
    private readonly skillSyncService: SkillSyncService,
  ) {}

  @Post('sync')
  @HttpCode(200)
  async syncSkills(@Body() body: unknown): Promise<SyncResult> {
    logger.info('POST /api/skills/sync');
    const parsed = SkillSyncRequestSchema.parse(body ?? {});
    if (parsed.sourceName) {
      return this.skillSyncService.syncSource(parsed.sourceName);
    }
    return this.skillSyncService.syncAll();
  }

  @Get('sources')
  async listSources(): Promise<SkillSourceMetadata[]> {
    logger.info('GET /api/skills/sources');
    return this.skillsService.listSources();
  }

  @Post('sources/:name/enable')
  @HttpCode(200)
  async enableSource(@Param() params: unknown): Promise<{ name: string; enabled: boolean }> {
    logger.info('POST /api/skills/sources/:name/enable');
    const parsed = SkillSourceParamsSchema.parse(params);
    return this.skillsService.setSourceEnabled(parsed.name, true);
  }

  @Post('sources/:name/disable')
  @HttpCode(200)
  async disableSource(@Param() params: unknown): Promise<{ name: string; enabled: boolean }> {
    logger.info('POST /api/skills/sources/:name/disable');
    const parsed = SkillSourceParamsSchema.parse(params);
    return this.skillsService.setSourceEnabled(parsed.name, false);
  }

  @Get('disabled')
  async listDisabled(@Query() query: unknown): Promise<string[]> {
    logger.info('GET /api/skills/disabled');
    const parsed = SkillDisabledQuerySchema.parse(query);
    return this.skillsService.listDisabled(parsed.projectId);
  }

  @Post('disable-all')
  @HttpCode(200)
  async disableAll(@Body() body: unknown): Promise<{ projectId: string; disabledCount: number }> {
    logger.info('POST /api/skills/disable-all');
    const parsed = SkillBulkActionSchema.parse(body);
    const disabledCount = await this.skillsService.disableAll(parsed.projectId);
    return { projectId: parsed.projectId, disabledCount };
  }

  @Post('enable-all')
  @HttpCode(200)
  async enableAll(@Body() body: unknown): Promise<{ projectId: string; enabledCount: number }> {
    logger.info('POST /api/skills/enable-all');
    const parsed = SkillBulkActionSchema.parse(body);
    const enabledCount = await this.skillsService.enableAll(parsed.projectId);
    return { projectId: parsed.projectId, enabledCount };
  }

  @Get('usage/stats')
  async getUsageStats(@Query() query: unknown): Promise<SkillUsageStat[]> {
    logger.info('GET /api/skills/usage/stats');
    const parsed = SkillUsageStatsQuerySchema.parse(query);
    return this.skillsService.getUsageStats({
      projectId: parsed.projectId,
      from: parsed.from,
      to: parsed.to,
      limit: parsed.limit,
      offset: parsed.offset,
    });
  }

  @Get('usage/log')
  async getUsageLog(@Query() query: unknown): Promise<SkillUsageLogListResult> {
    logger.info('GET /api/skills/usage/log');
    const parsed = SkillUsageLogQuerySchema.parse(query);
    return this.skillsService.listUsageLog({
      projectId: parsed.projectId,
      skillId: parsed.skillId,
      agentId: parsed.agentId,
      from: parsed.from,
      to: parsed.to,
      limit: parsed.limit,
      offset: parsed.offset,
    });
  }

  @Get('by-slug/:source/:name')
  async getBySlug(@Param() params: unknown): Promise<Skill> {
    logger.info('GET /api/skills/by-slug/:source/:name');
    const parsed = SkillBySlugParamsSchema.parse(params);
    const slug = `${parsed.source.trim().toLowerCase()}/${parsed.name.trim().toLowerCase()}`;
    return this.skillsService.getSkillBySlug(slug);
  }

  @Get()
  async listSkills(@Query() query: unknown): Promise<Array<Skill | ProjectSkill>> {
    logger.info('GET /api/skills');
    const parsed = SkillsListQuerySchema.parse(query);

    if (parsed.projectId) {
      return this.skillsService.listAllForProject(parsed.projectId, {
        q: parsed.q,
        source: parsed.source,
        category: parsed.category,
      });
    }

    return this.skillsService.listSkills({
      q: parsed.q,
      source: parsed.source,
      category: parsed.category,
    });
  }

  @Post('resolve')
  @HttpCode(200)
  async resolveSkills(@Body() body: unknown): Promise<Record<string, ResolvedSkillSummary>> {
    logger.info('POST /api/skills/resolve');
    const parsed = SkillResolveSlugsBodySchema.parse(body);
    return this.skillsService.resolveSkillSummariesBySlugs(parsed.slugs);
  }

  @Post(':id/disable')
  @HttpCode(200)
  async disableSkill(
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<{ projectId: string; skillId: string }> {
    logger.info('POST /api/skills/:id/disable');
    const parsedParams = SkillDisableParamsSchema.parse(params);
    const parsedBody = SkillDisableBodySchema.parse(body);
    await this.skillsService.disableSkill(parsedBody.projectId, parsedParams.id);
    return { projectId: parsedBody.projectId, skillId: parsedParams.id };
  }

  @Post(':id/enable')
  @HttpCode(200)
  async enableSkill(
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<{ projectId: string; skillId: string }> {
    logger.info('POST /api/skills/:id/enable');
    const parsedParams = SkillEnableParamsSchema.parse(params);
    const parsedBody = SkillEnableBodySchema.parse(body);
    await this.skillsService.enableSkill(parsedBody.projectId, parsedParams.id);
    return { projectId: parsedBody.projectId, skillId: parsedParams.id };
  }

  @Get(':id')
  async getSkillById(@Param() params: unknown): Promise<Skill> {
    logger.info('GET /api/skills/:id');
    const parsed = SkillByIdParamsSchema.parse(params);
    return this.skillsService.getSkill(parsed.id);
  }
}
