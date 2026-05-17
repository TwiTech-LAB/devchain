import { Module, forwardRef } from '@nestjs/common';
import { GuestsService } from './services/guests.service';
import { GuestHealthService } from './services/guest-health.service';
import { StorageModule } from '../storage/storage.module';
import { TerminalModule } from '../terminal/terminal.module';
import { EventsCoreModule } from '../events/events-core.module';

@Module({
  imports: [StorageModule, forwardRef(() => TerminalModule), EventsCoreModule],
  providers: [GuestsService, GuestHealthService],
  exports: [GuestsService, GuestHealthService],
})
export class GuestsModule {}
