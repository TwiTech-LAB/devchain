import { Module } from '@nestjs/common';
import { EventsInfraModule } from '../../events/events-infra.module';
import { EventsDomainModule } from '../../events/events-domain.module';
import { OrchestratorDockerModule } from '../docker/docker.module';
import { OrchestratorGitModule } from '../git/git.module';
import { OrchestratorStorageModule } from '../orchestrator-storage/orchestrator-storage.module';
import { WorktreesController } from './controllers/worktrees.controller';
import { LocalWorktreesStore } from './local-worktrees.store';
import { WorktreesService } from './services/worktrees.service';
import { WORKTREES_STORE } from './worktrees.store';

@Module({
  imports: [
    EventsInfraModule,
    EventsDomainModule,
    OrchestratorStorageModule,
    OrchestratorDockerModule,
    OrchestratorGitModule,
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
