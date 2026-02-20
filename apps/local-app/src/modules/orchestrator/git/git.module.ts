import { Module } from '@nestjs/common';
import { OrchestratorGitController } from './controllers/git.controller';
import { GitWorktreeService } from './services/git-worktree.service';

@Module({
  controllers: [OrchestratorGitController],
  providers: [GitWorktreeService],
  exports: [GitWorktreeService],
})
export class OrchestratorGitModule {}
