import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { createLogger } from '../../../../common/logging/logger';
import { NotFoundError } from '../../../../common/errors/error-types';
import {
  STORAGE_SERVICE,
  type StorageService,
} from '../../../storage/interfaces/storage.interface';
import { GitWorktreeService } from '../services/git-worktree.service';

const logger = createLogger('OrchestratorGitController');
const ListBranchesQuerySchema = z.object({
  ownerProjectId: z.string().uuid(),
});

@Controller('api')
export class OrchestratorGitController {
  constructor(
    private readonly gitWorktreeService: GitWorktreeService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  @Get('branches')
  async listBranches(
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<{ branches: string[] }> {
    const parsed = ListBranchesQuerySchema.safeParse({
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

    const { ownerProjectId } = parsed.data;
    logger.info({ ownerProjectId }, 'GET /api/branches');

    try {
      const project = await this.storage.getProject(ownerProjectId);
      const branches = await this.gitWorktreeService.listBranches(project.rootPath);
      return { branches };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`Project not found: ${ownerProjectId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/not a git repository/i.test(message)) {
        throw new BadRequestException('Project is not a git repository');
      }
      throw error;
    }
  }
}
