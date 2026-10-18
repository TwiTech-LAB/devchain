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
import { EpicTimeStoreModule } from '../epic-time/epic-time-store.module';
import { SessionTerminalRuntimeModule } from '../session-terminal-runtime/session-terminal-runtime.module';
import { GIT_SHIM_BIN, gitShimBin } from '../../common/git-shim-paths';

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
    SessionTerminalRuntimeModule,
    EpicTimeStoreModule,
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
  ],
})
export class SessionsModule {}
