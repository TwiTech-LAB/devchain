import { Module } from '@nestjs/common';
import {
  GitCoordinatorService,
  GIT_COORDINATOR_TIMINGS,
  DEFAULT_GIT_COORDINATOR_TIMINGS,
} from '../remotes/git-coordinator/git-coordinator.service';
import { GitCoordinatorStore } from '../remotes/git-coordinator/git-coordinator.store';
import { GitCoordinatorIndexService } from '../remotes/git-coordinator/git-coordinator-index.service';
import { GitProcessIdentity } from '../remotes/git-coordinator/git-process-identity';
import { HostGitCoordinatorController } from '../remotes/git-coordinator/host-git-coordinator.controller';
import { VmGitCoordinatorController } from '../remotes/git-coordinator/vm-git-coordinator.controller';
import { DbModule } from '../storage/db/db.module';
import { StorageModule } from '../storage/storage.module';
import { GitModule } from '../git/git.module';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';
import { FILE_SYNC_PATHS, createProductionFileSyncPaths } from './file-sync-paths';
import { FileSyncController } from './file-sync.controller';
import { FileSyncIgnoresStore } from './file-sync-ignores.store';
import { FileSyncAutoFixStore } from './file-sync-auto-fix.store';
import { FileSyncManagedExclusionsStore } from './file-sync-managed-exclusions.store';
import { FileSyncService } from './file-sync.service';
import { SyncPathInspector } from './sync-path-inspector';
import { HomeGitGuardService } from './home-git-guard.service';
import { HostSyncController } from './host-sync.controller';
import { HostGitGuardController } from './host-git-guard.controller';
import { NodeSyncthingLauncher, SyncthingLauncher } from './syncthing-launcher';
import {
  DEFAULT_SYNCTHING_MANAGER_TIMINGS,
  SYNCTHING_MANAGER_TIMINGS,
  SyncthingManager,
} from './syncthing-manager.service';
import { SyncthingSettingsStore } from './syncthing-settings.store';

@Module({
  imports: [DbModule, StorageModule, GitModule, ProcessExecutorModule],
  controllers: [
    HostGitCoordinatorController,
    VmGitCoordinatorController,
    HostSyncController,
    HostGitGuardController,
    FileSyncController,
  ],
  providers: [
    GitCoordinatorService,
    GitCoordinatorStore,
    GitCoordinatorIndexService,
    GitProcessIdentity,
    { provide: GIT_COORDINATOR_TIMINGS, useValue: DEFAULT_GIT_COORDINATOR_TIMINGS },
    { provide: FILE_SYNC_PATHS, useFactory: () => createProductionFileSyncPaths() },
    { provide: SyncthingLauncher, useClass: NodeSyncthingLauncher },
    { provide: SYNCTHING_MANAGER_TIMINGS, useValue: DEFAULT_SYNCTHING_MANAGER_TIMINGS },
    SyncthingSettingsStore,
    SyncthingManager,
    FileSyncIgnoresStore,
    FileSyncAutoFixStore,
    FileSyncManagedExclusionsStore,
    FileSyncService,
    SyncPathInspector,
    HomeGitGuardService,
  ],
  exports: [
    GitCoordinatorService,
    GitCoordinatorStore,
    GitCoordinatorIndexService,
    GitProcessIdentity,
    FILE_SYNC_PATHS,
    SyncthingManager,
    FileSyncService,
    SyncPathInspector,
    FileSyncManagedExclusionsStore,
    FileSyncAutoFixStore,
    HomeGitGuardService,
  ],
})
export class FileSyncModule {}
