import { Module, forwardRef } from '@nestjs/common';
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

@Module({
  imports: [
    StorageModule,
    SessionsReadModule,
    RealtimeBroadcastModule,
    forwardRef(() => TerminalModule),
    forwardRef(() => CoreNormalModule),
    EventsCoreModule,
    forwardRef(() => SettingsModule),
    HooksModule,
    ProviderAdaptersModule,
    forwardRef(() => ProvidersModule),
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
