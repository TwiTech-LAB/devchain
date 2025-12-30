import { Module, forwardRef } from '@nestjs/common';
import { EpicsController } from './controllers/epics.controller';
import { EpicCommentsController } from './controllers/epic-comments.controller';
import { StorageModule } from '../storage/storage.module';
import { EventsModule } from '../events/events.module';
import { EpicsService } from './services/epics.service';
import { TerminalModule } from '../terminal/terminal.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [StorageModule, EventsModule, forwardRef(() => TerminalModule), SettingsModule],
  controllers: [EpicsController, EpicCommentsController],
  providers: [EpicsService],
  exports: [EpicsService],
})
export class EpicsModule {}
