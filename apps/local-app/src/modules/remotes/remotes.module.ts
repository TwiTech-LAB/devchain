import { RemoteWorktreeGuard } from './operations/remote-worktree-guard';
import { RemoteApiKeyManagementService } from './auth/remote-api-key-management.service';
import { RemoteApiKeyController } from './controllers/remote-api-key.controller';
import { RemoteApiKeyModule } from './auth/remote-api-key.module';
import { HostApiKeyModule } from './host/host-api-key.module';
import { ProvidersModule } from '../providers/providers.module';
import { ProviderCliStateModule } from '../providers/services/provider-cli-state.module';
import { HostProviderCliSettingsController } from './host/host-provider-cli-settings.controller';
import { HostProviderCliSettingsService } from './host/host-provider-cli-settings.service';
import { RemoteProviderCliSettingsService } from './services/remote-provider-cli-settings.service';
import { HostProviderUsageSettingsController } from './host/host-provider-usage-settings.controller';
import { HostProviderUsageSettingsService } from './host/host-provider-usage-settings.service';
import { RemoteProviderUsageSettingsService } from './services/remote-provider-usage-settings.service';
import { RemoteSkillSettingsService } from './services/remote-skill-settings.service';
import { SkillsModule } from '../skills/skills.module';
import { SettingsModule } from '../settings/settings.module';
import { HostSkillSettingsController } from './host/host-skill-settings.controller';
import { HostSkillSettingsService } from './host/host-skill-settings.service';
import { GitModule } from '../git/git.module';
import { RemoteFileSyncService } from './sync/remote-file-sync.service';
import { GitOwnerStore } from './git-owner.store';
import { FileSyncSuggestionsService } from './sync/file-sync-suggestions.service';
import { FileSyncFailuresService } from './sync/file-sync-failures.service';
import { FileSyncPatternPreviewService } from './sync/file-sync-pattern-preview.service';
import { ProjectFileSyncController } from './sync/project-file-sync.controller';
import { DockerArchiveJournal } from '../core/controllers/docker-archive-journal';
import { HostDockerRecoveryService } from './host/host-docker-recovery.service';
import { HostDockerController } from './host/host-docker.controller';
import { HostDockerService } from './host/host-docker.service';
import { HostDockerVolumeAssociationsStore } from './host/host-docker-volume-associations.store';
import { HostDockerBodyParser } from './host/host-docker-body.parser';
import { DockerPlanController } from './docker/docker-plan.controller';
import { DockerPlanService } from './docker/docker-plan.service';
import { DockerPlanSourceService } from './docker/docker-plan-source.service';
import { DockerHandoff } from './docker/docker-handoff';
import { DockerCopyBack } from './docker/docker-copy-back';
import { DockerCopyBackExclusions } from './docker/docker-copy-back-exclusions';
import { DockerHandoffStore } from './docker/docker-handoff.store';
import { TranscriptPathValidator } from '../session-reader/services/transcript-path-validator.service';
import { TranscriptFilesService } from './transcripts/transcript-files.service';
import { TranscriptHandoff } from './operations/transcript-handoff';
import { HostTranscriptsController } from './host/host-transcripts.controller';
import { HostTranscriptBodyParser } from './host/host-transcript-body.parser';
import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { RealtimeBroadcastModule } from '../realtime/realtime-broadcast.module';
import { EventsModule } from '../events/events.module';
import { EventsService } from '../events/services/events.service';
import { RemotesController } from './controllers/remotes.controller';
import { RemoteProbeController } from './controllers/remote-probe.controller';
import { RemoteProbeService } from './services/remote-probe.service';
import { RemoteHealthService } from './services/remote-health.service';
import { RemoteProxyService } from './services/remote-proxy.service';
import { RemotesService } from './services/remotes.service';
import { REMOTE_HEALTH_PORT } from './ports/remote-health.port';
import { REMOTE_MIRROR_SYNC_PORT } from './ports/remote-mirror-sync.port';
import { ProjectReplicaBuilder } from './replica/project-replica.builder';
import { ProjectReplicaApplier } from './replica/project-replica.applier';
import { HostController } from './host/host.controller';
import { HostUpdateController } from './host/host-update.controller';
import { HostHelperModule } from './host/host-helper.module';
import { ProviderBaselineService } from './host/provider-baseline.service';
import { HostProviderAuthController } from './host/host-provider-auth.controller';
import { HostProviderAuthService } from './host/host-provider-auth.service';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';
import { HostService } from './host/host.service';
import { HostReplicaBodyParser } from './host/host-replica-body.parser';
import { ProjectWriteAdmissionModule } from './admission/project-write-admission.module';
import { SessionsModule } from '../sessions/sessions.module';
import { RemoteBindingsService } from './services/remote-bindings.service';
import { ProjectSessionsStopper } from './services/project-sessions-stopper.service';
import { RemoteLiveSyncService } from './sync/remote-live-sync.service';
import { RemoteHostClient } from './operations/remote-host.client';
import { AttachOperation } from './operations/attach.operation';
import { DetachOperation } from './operations/detach.operation';
import { DisconnectAllOperation } from './operations/disconnect-all.operation';
import { ForceSyncOperation } from './operations/force-sync.operation';
import { DockerImportInventoryStore } from './operations/docker-import-inventory.store';
import { RemoteOperationRunner } from './operations/remote-operation.runner';
import { RemoteOperationsService } from './operations/remote-operations.service';
import { RemoteOperationsController } from './operations/remote-operations.controller';
import { ProjectTimeSettler } from './time/project-time-settler.service';
import { EpicTimeStoreModule } from '../epic-time/epic-time-store.module';
import { FileSyncModule } from '../file-sync/file-sync.module';
import { FileSyncHandoff } from './operations/file-sync-handoff';
import { UpdateLoginsOperation } from './operations/update-logins.operation';
import { ClaimOperation } from './operations/claim.operation';
import { UpdateHostOperation } from './operations/update-host.operation';
import { CreateVmOperation } from './operations/create-vm.operation';
import { ResetVmOperation } from './operations/reset-vm.operation';
import { DestroyVmOperation } from './operations/destroy-vm.operation';
import { VmOperationsService } from './operations/vm-operations.service';
import { VmOperationsController } from './operations/vm-operations.controller';
import { ProviderAuthModule } from '../provider-auth/provider-auth.module';
import { ProviderAdaptersModule } from '../providers/adapters/provider-adapters.module';
import { VmProvidersModule } from '../vm-providers/vm-providers.module';
import { HostInstallController } from './host-install/host-install.controller';
import { ProjectSizeService } from './host-install/project-size.service';
import { HostInstallService } from './host-install/host-install.service';
import { SshRunner } from './host-install/ssh-runner';
import { ConnectChoicesController } from './connect-choices.controller';
import { ConnectChoicesStore } from './connect-choices.store';
import { InstallHostOperation } from './operations/install-host.operation';
import { SshKeyService } from './host-install/ssh-key.service';
import { HostSshKeysController } from './host/host-ssh-keys.controller';
import { HostSshKeysService } from './host/host-ssh-keys.service';
import { HostSharedVmController } from './host/host-shared-vm.controller';
import { HostSharedVmService } from './host/host-shared-vm.service';
import { HostSharedVmStore } from './host/host-shared-vm.store';
import { RemoteSharedVmService } from './services/remote-shared-vm.service';
import { RemoteSharedVmStore } from './services/remote-shared-vm.store';
import { HomeSharedVmNoticesService } from './services/home-shared-vm-notices.service';
import { HomeSharedVmNoticesController } from './controllers/home-shared-vm-notices.controller';
import { RemoteForcedDetachService } from './services/remote-forced-detach.service';
import { RemoteForcedDetachStore } from './services/remote-forced-detach.store';
import {
  GitShimRegistryService,
  GIT_SHIM_HOME,
  GIT_SHIM_ON_VM,
  GIT_SHIM_REFRESH_MS,
} from './git-shim/git-shim-registry.service';
import { gitShimHome } from '../../common/git-shim-paths';
import { getEnvConfig } from '../../common/config/env.config';
import { isClaimedHost } from './host-api-key';
import { HomeGitWriteController } from './git-writes/home-git-write.controller';
import {
  HomeGitWriteService,
  HOME_GIT_WRITE_TIMINGS,
  DEFAULT_HOME_GIT_WRITE_TIMINGS,
} from './git-writes/home-git-write.service';
import { HomeGitWriteStore } from './git-writes/home-git-write.store';
import { HomeGitTransitions } from './git-writes/home-git-transitions';
import {
  HomeGitHandoverService,
  HOME_GIT_HANDOVER_TIMINGS,
  DEFAULT_HOME_GIT_HANDOVER_TIMINGS,
} from './git-writes/home-git-handover.service';

@Module({
  imports: [
    // Install root admission before the proxy plugin inherits Fastify hooks.
    HostApiKeyModule,
    RemoteApiKeyModule,
    ProvidersModule,
    ProviderCliStateModule,
    SkillsModule,
    SettingsModule,
    StorageModule,
    RealtimeBroadcastModule,
    EventsModule,
    ProjectWriteAdmissionModule,
    HostHelperModule,
    SessionsModule,
    EpicTimeStoreModule,
    FileSyncModule,
    GitModule,
    ProcessExecutorModule,
    ProviderAuthModule,
    ProviderAdaptersModule,
    VmProvidersModule,
  ],
  controllers: [
    HomeGitWriteController,
    ConnectChoicesController,
    ProjectFileSyncController,
    RemoteApiKeyController,
    HostProviderCliSettingsController,
    HostProviderUsageSettingsController,
    HostSkillSettingsController,
    RemotesController,
    RemoteProbeController,
    RemoteOperationsController,
    VmOperationsController,
    HostController,
    HostTranscriptsController,
    HostDockerController,
    DockerPlanController,
    HostUpdateController,
    HostProviderAuthController,
    HostInstallController,
    HostSshKeysController,
    HostSharedVmController,
    HomeSharedVmNoticesController,
  ],
  providers: [
    GitShimRegistryService,
    { provide: GIT_SHIM_HOME, useFactory: () => gitShimHome() },
    {
      provide: GIT_SHIM_ON_VM,
      useValue: () => isClaimedHost(getEnvConfig().DEVCHAIN_HOST_ETC_DIR),
    },
    // Tests never touch the developer's own shim files unless they provide a home.
    {
      provide: GIT_SHIM_REFRESH_MS,
      useFactory: () => (process.env.NODE_ENV === 'test' ? 0 : 2_000),
    },
    HomeGitWriteService,
    HomeGitWriteStore,
    { provide: HomeGitTransitions, useClass: HomeGitHandoverService },
    { provide: HOME_GIT_HANDOVER_TIMINGS, useValue: DEFAULT_HOME_GIT_HANDOVER_TIMINGS },
    { provide: HOME_GIT_WRITE_TIMINGS, useValue: DEFAULT_HOME_GIT_WRITE_TIMINGS },
    RemoteWorktreeGuard,
    ConnectChoicesStore,
    RemoteApiKeyManagementService,
    HostProviderCliSettingsService,
    RemoteProviderCliSettingsService,
    HostProviderUsageSettingsService,
    RemoteProviderUsageSettingsService,
    HostSkillSettingsService,
    RemotesService,
    RemoteProbeService,
    RemoteHealthService,
    RemoteSkillSettingsService,
    RemoteProxyService,
    HostService,
    HostSharedVmService,
    HostSharedVmStore,
    RemoteSharedVmService,
    RemoteSharedVmStore,
    HomeSharedVmNoticesService,
    RemoteForcedDetachService,
    RemoteForcedDetachStore,
    ProviderBaselineService,
    HostProviderAuthService,
    HostReplicaBodyParser,
    HostTranscriptBodyParser,
    HostDockerBodyParser,
    HostDockerService,
    HostDockerVolumeAssociationsStore,
    HostDockerRecoveryService,
    { provide: DockerArchiveJournal, useFactory: () => new DockerArchiveJournal() },
    TranscriptPathValidator,
    TranscriptFilesService,
    TranscriptHandoff,
    RemoteBindingsService,
    ProjectSessionsStopper,
    RemoteLiveSyncService,
    RemoteFileSyncService,
    GitOwnerStore,
    FileSyncSuggestionsService,
    FileSyncFailuresService,
    FileSyncPatternPreviewService,
    RemoteHostClient,
    FileSyncHandoff,
    DockerImportInventoryStore,
    DockerPlanSourceService,
    DockerPlanService,
    { provide: DockerHandoffStore, useFactory: () => new DockerHandoffStore() },
    DockerHandoff,
    DockerCopyBack,
    DockerCopyBackExclusions,
    AttachOperation,
    DetachOperation,
    DisconnectAllOperation,
    ForceSyncOperation,
    ClaimOperation,
    UpdateLoginsOperation,
    UpdateHostOperation,
    CreateVmOperation,
    ResetVmOperation,
    DestroyVmOperation,
    RemoteOperationRunner,
    RemoteOperationsService,
    VmOperationsService,
    ProjectTimeSettler,
    ProjectSizeService,
    HostInstallService,
    SshKeyService,
    HostSshKeysService,
    SshRunner,
    InstallHostOperation,
    { provide: REMOTE_HEALTH_PORT, useExisting: RemoteHealthService },
    { provide: REMOTE_MIRROR_SYNC_PORT, useExisting: RemoteLiveSyncService },
    {
      provide: ProjectReplicaBuilder,
      useFactory: (storage: ConstructorParameters<typeof ProjectReplicaBuilder>[0]) =>
        new ProjectReplicaBuilder(storage),
      inject: [STORAGE_SERVICE],
    },
    {
      provide: ProjectReplicaApplier,
      useFactory: (
        storage: ConstructorParameters<typeof ProjectReplicaApplier>[0],
        events: EventsService,
      ) => new ProjectReplicaApplier(storage, events),
      inject: [STORAGE_SERVICE, EventsService],
    },
  ],
  exports: [
    DockerArchiveJournal,
    DockerPlanService,
    REMOTE_HEALTH_PORT,
    REMOTE_MIRROR_SYNC_PORT,
    RemoteHostClient,
    ProjectReplicaBuilder,
    ProjectReplicaApplier,
  ],
})
export class RemotesModule {}
