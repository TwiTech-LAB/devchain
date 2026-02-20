import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Optional,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { createLogger } from '../../../../common/logging/logger';
import {
  CreateWorktreeSchema,
  DeleteWorktreeQuerySchema,
  WorktreeListQuerySchema,
  WorktreeMergePreviewDto,
  WorktreeLogsQuerySchema,
  WorktreeOverviewDto,
  WorktreeResponseDto,
} from '../dtos/worktree.dto';
import { WorktreesService } from '../services/worktrees.service';
import { OrchestratorDockerService } from '../../docker/services/docker.service';

const logger = createLogger('OrchestratorWorktreesController');
const DEFAULT_DOCKER_AVAILABILITY_TTL_MS = 60_000;

function resolveDockerAvailabilityTtlMs(rawValue: string | undefined): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DOCKER_AVAILABILITY_TTL_MS;
  }
  return Math.floor(parsed);
}

@Controller('api/worktrees')
export class WorktreesController {
  private dockerAvailabilityCache: boolean | null = null;
  private dockerAvailabilityCachedAtMs: number | null = null;
  private dockerAvailabilityPending: Promise<boolean> | null = null;
  private readonly dockerAvailabilityTtlMs = resolveDockerAvailabilityTtlMs(
    process.env.WORKTREES_DOCKER_AVAILABILITY_TTL_MS,
  );

  constructor(
    private readonly worktreesService: WorktreesService,
    @Optional() private readonly dockerService?: OrchestratorDockerService,
  ) {}

  @Post()
  async createWorktree(@Body() body: unknown): Promise<WorktreeResponseDto> {
    logger.info('POST /api/worktrees');
    const parsed = CreateWorktreeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parsed.error.errors,
      });
    }

    const dockerAvailable = await this.resolveDockerAvailability();
    const runtimeType = parsed.data.runtimeType ?? (dockerAvailable ? 'container' : 'process');
    if (runtimeType === 'container' && !dockerAvailable) {
      throw new BadRequestException(
        'Docker is unavailable, so runtimeType "container" cannot be selected',
      );
    }

    return this.worktreesService.createWorktree({
      ...parsed.data,
      runtimeType,
    });
  }

  @Get()
  async listWorktrees(
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<WorktreeResponseDto[]> {
    logger.info('GET /api/worktrees');
    const parsed = WorktreeListQuerySchema.safeParse({
      ownerProjectId: Array.isArray(query.ownerProjectId)
        ? query.ownerProjectId[0]
        : query.ownerProjectId,
    });
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parsed.error.errors,
      });
    }
    if (parsed.data.ownerProjectId) {
      return this.worktreesService.listByOwnerProject(parsed.data.ownerProjectId);
    }
    return this.worktreesService.listWorktrees();
  }

  @Get('overview')
  async listWorktreeOverviews(
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<WorktreeOverviewDto[]> {
    logger.info('GET /api/worktrees/overview');
    const parsed = WorktreeListQuerySchema.safeParse({
      ownerProjectId: Array.isArray(query.ownerProjectId)
        ? query.ownerProjectId[0]
        : query.ownerProjectId,
    });
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parsed.error.errors,
      });
    }

    return this.worktreesService.listWorktreeOverviews(parsed.data.ownerProjectId);
  }

  @Get(':id')
  async getWorktree(@Param('id') id: string): Promise<WorktreeResponseDto> {
    logger.info({ id }, 'GET /api/worktrees/:id');
    return this.worktreesService.getWorktree(id);
  }

  @Get(':id/overview')
  async getWorktreeOverview(@Param('id') id: string): Promise<WorktreeOverviewDto> {
    logger.info({ id }, 'GET /api/worktrees/:id/overview');
    return this.worktreesService.getWorktreeOverview(id);
  }

  @Delete(':id')
  async deleteWorktree(
    @Param('id') id: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<{ success: true }> {
    const parsed = DeleteWorktreeQuerySchema.safeParse({
      deleteBranch: Array.isArray(query.deleteBranch) ? query.deleteBranch[0] : query.deleteBranch,
    });
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parsed.error.errors,
      });
    }

    logger.info({ id, deleteBranch: parsed.data.deleteBranch }, 'DELETE /api/worktrees/:id');
    return this.worktreesService.deleteWorktree(id, {
      deleteBranch: parsed.data.deleteBranch,
    });
  }

  @Post(':id/start')
  async startWorktree(@Param('id') id: string): Promise<WorktreeResponseDto> {
    logger.info({ id }, 'POST /api/worktrees/:id/start');
    return this.worktreesService.startWorktree(id);
  }

  @Post(':id/stop')
  async stopWorktree(@Param('id') id: string): Promise<WorktreeResponseDto> {
    logger.info({ id }, 'POST /api/worktrees/:id/stop');
    return this.worktreesService.stopWorktree(id);
  }

  @Post(':id/merge')
  async mergeWorktree(@Param('id') id: string): Promise<WorktreeResponseDto> {
    logger.info({ id }, 'POST /api/worktrees/:id/merge');
    return this.worktreesService.mergeWorktree(id);
  }

  @Post(':id/merge/preview')
  async previewMergeWorktree(@Param('id') id: string): Promise<WorktreeMergePreviewDto> {
    logger.info({ id }, 'POST /api/worktrees/:id/merge/preview');
    return this.worktreesService.previewMergeWorktree(id);
  }

  @Post(':id/rebase')
  async rebaseWorktree(@Param('id') id: string): Promise<WorktreeResponseDto> {
    logger.info({ id }, 'POST /api/worktrees/:id/rebase');
    return this.worktreesService.rebaseWorktree(id);
  }

  @Get(':id/logs')
  async getWorktreeLogs(
    @Param('id') id: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<{ logs: string }> {
    logger.info({ id }, 'GET /api/worktrees/:id/logs');
    const parsed = WorktreeLogsQuerySchema.safeParse({
      tail: Array.isArray(query.tail) ? query.tail[0] : query.tail,
    });
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parsed.error.errors,
      });
    }
    return this.worktreesService.getWorktreeLogs(id, parsed.data);
  }

  private async resolveDockerAvailability(): Promise<boolean> {
    const now = Date.now();
    if (
      this.dockerAvailabilityCache !== null &&
      this.dockerAvailabilityCachedAtMs !== null &&
      now - this.dockerAvailabilityCachedAtMs < this.dockerAvailabilityTtlMs
    ) {
      return this.dockerAvailabilityCache;
    }
    if (this.dockerAvailabilityPending) {
      return this.dockerAvailabilityPending;
    }

    this.dockerAvailabilityPending = (async () => {
      if (!this.dockerService) {
        return false;
      }
      try {
        return await this.dockerService.ping();
      } catch {
        return false;
      }
    })();

    try {
      const availability = await this.dockerAvailabilityPending;
      this.dockerAvailabilityCache = availability;
      this.dockerAvailabilityCachedAtMs = Date.now();
      return availability;
    } finally {
      this.dockerAvailabilityPending = null;
    }
  }
}
