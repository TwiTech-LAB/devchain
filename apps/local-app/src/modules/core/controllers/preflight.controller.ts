import { Controller, Get, Post, Query } from '@nestjs/common';
import { PreflightService, PreflightResult } from '../services/preflight.service';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('PreflightController');

@Controller('api/preflight')
export class PreflightController {
  constructor(private readonly preflightService: PreflightService) {}

  @Get()
  async runPreflightChecks(
    @Query('projectPath') projectPath?: string,
    @Query('all') all?: string,
  ): Promise<PreflightResult> {
    const includeAllProviders = all === '1' || all === 'true';
    logger.info({ projectPath, includeAllProviders }, 'GET /api/preflight');
    return this.preflightService.runChecks(projectPath, { includeAllProviders });
  }

  @Post('clear-cache')
  async clearCache(
    @Query('projectPath') projectPath?: string,
  ): Promise<{ success: boolean; message: string }> {
    logger.info({ projectPath }, 'POST /api/preflight/clear-cache');
    this.preflightService.clearCache(projectPath);
    return {
      success: true,
      message: projectPath
        ? `Cleared preflight cache for ${projectPath}`
        : 'Cleared all preflight cache',
    };
  }
}
