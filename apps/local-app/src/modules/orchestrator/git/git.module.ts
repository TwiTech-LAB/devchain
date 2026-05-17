import { Module } from '@nestjs/common';
import { OrchestratorGitController } from './controllers/git.controller';
import { GitWorktreeService } from './services/git-worktree.service';
import { StorageModule } from '../../storage/storage.module';
import { ProcessExecutorModule } from '../../terminal/services/process-executor/process-executor.module';

@Module({
  imports: [StorageModule, ProcessExecutorModule],
  controllers: [OrchestratorGitController],
  providers: [GitWorktreeService],
  exports: [GitWorktreeService],
})
export class OrchestratorGitModule {}
