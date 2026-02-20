import { Module, forwardRef } from '@nestjs/common';
import { SessionsService } from './services/sessions.service';
import { SessionCoordinatorService } from './services/session-coordinator.service';
import { SessionsMessagePoolService } from './services/sessions-message-pool.service';
import { MessageActivityStreamService } from './services/message-activity-stream.service';
import { ActivityTrackerService } from './services/activity-tracker.service';
import { SessionsController } from './controllers/sessions.controller';
import { TerminalModule } from '../terminal/terminal.module';
import { CoreNormalModule } from '../core/core-normal.module';
import { StorageModule } from '../storage/storage.module';
import { SettingsModule } from '../settings/settings.module';
import { EventsDomainModule } from '../events/events-domain.module';
import { HooksModule } from '../hooks/hooks.module';

@Module({
  imports: [
    StorageModule,
    forwardRef(() => TerminalModule),
    forwardRef(() => CoreNormalModule),
    forwardRef(() => EventsDomainModule),
    forwardRef(() => SettingsModule),
    HooksModule,
  ],
  providers: [
    SessionsService,
    SessionCoordinatorService,
    SessionsMessagePoolService,
    MessageActivityStreamService,
    ActivityTrackerService,
  ],
  controllers: [SessionsController],
  exports: [
    SessionsService,
    SessionCoordinatorService,
    SessionsMessagePoolService,
    MessageActivityStreamService,
    ActivityTrackerService,
  ],
})
export class SessionsModule {}
