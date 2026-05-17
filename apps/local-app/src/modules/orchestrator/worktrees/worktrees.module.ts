import { Module } from '@nestjs/common';
import { EventsCoreModule } from '../../events/events-core.module';
import { StorageModule } from '../../storage/storage.module';
import { OrchestratorDockerModule } from '../docker/docker.module';
import { OrchestratorGitModule } from '../git/git.module';
import { OrchestratorStorageModule } from '../orchestrator-storage/orchestrator-storage.module';
import { ProcessExecutorModule } from '../../terminal/services/process-executor/process-executor.module';
import { WorktreesController } from './controllers/worktrees.controller';
import { LocalWorktreesStore } from './local-worktrees.store';
import { WorktreesService } from './services/worktrees.service';
import { WORKTREES_STORE } from './worktrees.store';

@Module({
  imports: [
    EventsCoreModule,
    OrchestratorStorageModule,
    StorageModule,
    OrchestratorDockerModule,
    OrchestratorGitModule,
    ProcessExecutorModule,
  ],
  controllers: [WorktreesController],
  providers: [
    WorktreesService,
    LocalWorktreesStore,
    {
      provide: WORKTREES_STORE,
      useExisting: LocalWorktreesStore,
    },
  ],
  exports: [WorktreesService, WORKTREES_STORE],
})
export class OrchestratorWorktreesModule {}
