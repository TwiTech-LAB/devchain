import { Module, forwardRef } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventsService } from './services/events.service';
import { EventLogService } from './services/event-log.service';
import { EventLogController } from './controllers/event-log.controller';
import { EventsStreamService } from './services/events-stream.service';
import { subscribers } from './subscribers';
import { DbModule } from '../storage/db/db.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TerminalModule } from '../terminal/terminal.module';
import { ChatModule } from '../chat/chat.module';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [
    DbModule,
    StorageModule,
    SettingsModule,
    forwardRef(() => SessionsModule),
    forwardRef(() => TerminalModule),
    ChatModule,
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
    }),
  ],
  controllers: [EventLogController],
  providers: [EventsService, EventLogService, EventsStreamService, ...subscribers],
  exports: [EventsService, EventLogService, EventsStreamService],
})
export class EventsModule {}
