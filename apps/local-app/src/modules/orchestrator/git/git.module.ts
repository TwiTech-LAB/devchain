import { Module } from '@nestjs/common';
import { OrchestratorGitController } from './controllers/git.controller';
import { GitWorktreeService } from './services/git-worktree.service';
import { StorageModule } from '../../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [OrchestratorGitController],
  providers: [GitWorktreeService],
  exports: [GitWorktreeService],
})
export class OrchestratorGitModule {}
