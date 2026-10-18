import { FileSyncModule } from '../file-sync/file-sync.module';
import { WorktreeAdmissionService } from './worktree-admission.service';
import { HostWorktreesController } from './host-worktrees.controller';
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { TeamsStore } from '../teams/storage/teams.store';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';
import { ProjectGitMutex } from './project-git-mutex';
import { WorktreeGitRunner } from './worktree-git-runner';
import { WorktreesService } from './worktrees.service';

@Module({
  imports: [StorageModule, ProcessExecutorModule, FileSyncModule],
  controllers: [HostWorktreesController],
  providers: [
    WorktreeAdmissionService,
    TeamsStore,
    ProjectGitMutex,
    WorktreeGitRunner,
    WorktreesService,
  ],
  exports: [WorktreeAdmissionService, ProjectGitMutex, WorktreeGitRunner, WorktreesService],
})
export class WorktreesModule {}
