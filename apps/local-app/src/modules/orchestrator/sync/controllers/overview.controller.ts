import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { createLogger } from '../../../../common/logging/logger';
import { MergedEpicDto, MergedEpicHierarchyDto, WorktreeSnapshot } from '../dtos/overview.dto';
import { LazyFetchService } from '../services/lazy-fetch.service';

const logger = createLogger('OrchestratorOverviewController');

@Controller('api/overview')
export class OverviewController {
  constructor(private readonly lazyFetchService: LazyFetchService) {}

  @Get()
  async listOverview(): Promise<WorktreeSnapshot[]> {
    logger.info('GET /api/overview');
    return this.lazyFetchService.fetchAllWorktreeStatuses();
  }

  @Get('merged-epics')
  async listMergedEpics(@Query('worktreeId') worktreeId?: string): Promise<MergedEpicDto[]> {
    const normalizedWorktreeId = worktreeId?.trim();
    if (worktreeId !== undefined && !normalizedWorktreeId) {
      throw new BadRequestException('worktreeId query parameter must not be empty');
    }

    logger.info({ worktreeId: normalizedWorktreeId }, 'GET /api/overview/merged-epics');
    return this.lazyFetchService.listMergedEpics(normalizedWorktreeId);
  }

  @Get('merged-epics/:worktreeId')
  async getMergedEpicHierarchy(
    @Param('worktreeId') worktreeId: string,
  ): Promise<MergedEpicHierarchyDto> {
    logger.info({ worktreeId }, 'GET /api/overview/merged-epics/:worktreeId');
    return this.lazyFetchService.getMergedEpicHierarchy(worktreeId);
  }
}
