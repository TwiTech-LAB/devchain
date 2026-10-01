import { Module } from '@nestjs/common';
import { DbModule } from '../storage/db/db.module';
import { StorageModule } from '../storage/storage.module';
import { GitModule } from '../git/git.module';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';
import { FILE_SYNC_PATHS, createProductionFileSyncPaths } from './file-sync-paths';
import { FileSyncController } from './file-sync.controller';
import { FileSyncIgnoresStore } from './file-sync-ignores.store';
import { FileSyncManagedExclusionsStore } from './file-sync-managed-exclusions.store';
import { FileSyncService } from './file-sync.service';
import { HomeGitGuardService } from './home-git-guard.service';
import { HostSyncController } from './host-sync.controller';
import { NodeSyncthingLauncher, SyncthingLauncher } from './syncthing-launcher';
import {
  DEFAULT_SYNCTHING_MANAGER_TIMINGS,
  SYNCTHING_MANAGER_TIMINGS,
  SyncthingManager,
} from './syncthing-manager.service';
import { SyncthingSettingsStore } from './syncthing-settings.store';

@Module({
  imports: [DbModule, StorageModule, GitModule, ProcessExecutorModule],
  controllers: [HostSyncController, FileSyncController],
  providers: [
    { provide: FILE_SYNC_PATHS, useFactory: () => createProductionFileSyncPaths() },
    { provide: SyncthingLauncher, useClass: NodeSyncthingLauncher },
    { provide: SYNCTHING_MANAGER_TIMINGS, useValue: DEFAULT_SYNCTHING_MANAGER_TIMINGS },
    SyncthingSettingsStore,
    SyncthingManager,
    FileSyncIgnoresStore,
    FileSyncManagedExclusionsStore,
    FileSyncService,
    HomeGitGuardService,
  ],
  exports: [
    FILE_SYNC_PATHS,
    SyncthingManager,
    FileSyncService,
    FileSyncManagedExclusionsStore,
    HomeGitGuardService,
  ],
})
export class FileSyncModule {}
