import { Module } from '@nestjs/common';
import { EventsInfraModule } from '../../events/events-infra.module';
import { StorageModule } from '../../storage/storage.module';
import { OrchestratorGitModule } from '../git/git.module';
import { OrchestratorStorageModule } from '../orchestrator-storage/orchestrator-storage.module';
import { OrchestratorWorktreesModule } from '../worktrees/worktrees.module';
import { OverviewController } from './controllers/overview.controller';
import { LazyFetchService } from './services/lazy-fetch.service';
import { TaskMergeService } from './services/task-merge.service';

@Module({
  imports: [
    EventsInfraModule,
    StorageModule,
    OrchestratorWorktreesModule,
    OrchestratorGitModule,
    OrchestratorStorageModule,
  ],
  controllers: [OverviewController],
  providers: [LazyFetchService, TaskMergeService],
  exports: [LazyFetchService, TaskMergeService],
})
export class OrchestratorSyncModule {}
