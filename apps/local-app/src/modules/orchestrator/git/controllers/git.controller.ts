import { Controller, Get } from '@nestjs/common';
import { createLogger } from '../../../../common/logging/logger';
import { GitWorktreeService } from '../services/git-worktree.service';

const logger = createLogger('OrchestratorGitController');

@Controller('api')
export class OrchestratorGitController {
  constructor(private readonly gitWorktreeService: GitWorktreeService) {}

  @Get('branches')
  async listBranches(): Promise<{ branches: string[] }> {
    logger.info('GET /api/branches');
    const branches = await this.gitWorktreeService.listBranches();
    return { branches };
  }
}
