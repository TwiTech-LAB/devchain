import { Module, forwardRef } from '@nestjs/common';
import { SessionsService } from './services/sessions.service';
import { SessionCoordinatorService } from './services/session-coordinator.service';
import { SessionsMessagePoolService } from './services/sessions-message-pool.service';
import { MessageActivityStreamService } from './services/message-activity-stream.service';
import { ActivityTrackerService } from './services/activity-tracker.service';
import { SessionsController } from './controllers/sessions.controller';
import { TerminalModule } from '../terminal/terminal.module';
import { CoreModule } from '../core/core.module';
import { StorageModule } from '../storage/storage.module';
import { SettingsModule } from '../settings/settings.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    StorageModule,
    forwardRef(() => TerminalModule),
    forwardRef(() => CoreModule),
    forwardRef(() => EventsModule),
    forwardRef(() => SettingsModule),
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
