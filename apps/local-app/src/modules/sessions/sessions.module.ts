import { SessionRowsModule } from '../storage/sessions/session-rows.module';
import { Module } from '@nestjs/common';
import { SessionsService } from './services/sessions.service';
import { SessionCoordinatorService } from './services/session-coordinator.service';
import { SessionsMessagePoolService } from './services/sessions-message-pool.service';
import { MessageActivityStreamService } from './services/message-activity-stream.service';
import { MessageLogService } from './services/message-log.service';
import { DeliveryFailureNotifierService } from './services/delivery-failure-notifier.service';
import {
  SessionRuntime,
  SessionLaunchPipeline,
  SessionRestorePipeline,
} from './services/session-runtime';
import { SessionsController } from './controllers/sessions.controller';
import { TerminalModule } from '../terminal/terminal.module';
import { CoreNormalModule } from '../core/core-normal.module';
import { StorageModule } from '../storage/storage.module';
import { SettingsModule } from '../settings/settings.module';
import { EventsCoreModule } from '../events/events-core.module';
import { HooksModule } from '../hooks/hooks.module';
import { ProviderAdaptersModule } from '../providers/adapters/provider-adapters.module';
import { TeamsStore } from '../teams/storage/teams.store';
import { ProvidersModule } from '../providers/providers.module';
import { RealtimeBroadcastModule } from '../realtime/realtime-broadcast.module';
import { SessionsReadModule } from './sessions-read.module';
import { SessionLauncherFacade } from './services/session-launcher-facade.service';
import { RuntimeContextCaptureModule } from '../runtime-context-capture/runtime-context-capture.module';
import { ProviderRuntimePreparationService } from './services/provider-runtime-preparation';
import { RuntimeDirectoryModule } from '../runtime-directory/runtime-directory.module';
import { EpicTimeStoreModule } from '../epic-time/epic-time-store.module';
import { SessionTerminalRuntimeModule } from '../session-terminal-runtime/session-terminal-runtime.module';
import { DEVCHAIN_CLI_PATH, findDevchainCli } from '../../common/devchain-cli-launcher';
import { GIT_SHIM_BIN, GIT_SHIM_ON_VM, gitShimBin } from '../../common/git-shim-paths';
import { getEnvConfig } from '../../common/config/env.config';
import { isClaimedHost } from '../remotes/host-api-key';
import { VaultModule } from '../vault/vault.module';

@Module({
  imports: [
    SessionRowsModule,
    StorageModule,
    SessionsReadModule,
    RealtimeBroadcastModule,
    TerminalModule,
    CoreNormalModule,
    EventsCoreModule,
    SettingsModule,
    HooksModule,
    ProviderAdaptersModule,
    ProvidersModule,
    RuntimeContextCaptureModule,
    RuntimeDirectoryModule,
    SessionTerminalRuntimeModule,
    EpicTimeStoreModule,
    VaultModule,
  ],
  providers: [
    SessionsService,
    SessionCoordinatorService,
    SessionsMessagePoolService,
    MessageActivityStreamService,
    MessageLogService,
    DeliveryFailureNotifierService,
    SessionLaunchPipeline,
    SessionRestorePipeline,
    ProviderRuntimePreparationService,
    {
      provide: GIT_SHIM_BIN,
      useFactory: () => (process.env.NODE_ENV === 'test' ? null : gitShimBin()),
    },
    {
      provide: DEVCHAIN_CLI_PATH,
      useFactory: () => (process.env.NODE_ENV === 'test' ? null : findDevchainCli()),
    },
    {
      provide: GIT_SHIM_ON_VM,
      useValue: () => isClaimedHost(getEnvConfig().DEVCHAIN_HOST_ETC_DIR),
    },
    SessionRuntime,
    SessionLauncherFacade,
    TeamsStore,
  ],
  controllers: [SessionsController],
  exports: [
    SessionsService,
    SessionCoordinatorService,
    SessionsMessagePoolService,
    MessageActivityStreamService,
    SessionRuntime,
    SessionLauncherFacade,
    GIT_SHIM_ON_VM,
  ],
})
export class SessionsModule {}
